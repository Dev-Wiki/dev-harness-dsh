import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback, fork } from 'node:child_process'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import atomicPackage from '@deepseek-ai/dsh-atomic-write/package.json' with { type: 'json' }
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import skillFileSystemPackage from '@deepseek-ai/dsh-skill-filesystem/package.json' with { type: 'json' }

const execFile = promisify(execFileCallback)
const EXPECTED_VERSION = '0.1.0-rc.8'
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const childScript = fileURLToPath(new URL('./atomic-writer-child.mjs', import.meta.url))

class ResumeMismatchError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`)
    this.name = 'ResumeMismatchError'
    this.code = code
  }
}

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return stdout.trim()
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function repositoryIdentity(cwd) {
  return {
    worktreeRoot: await realpath(await git(cwd, 'rev-parse', '--show-toplevel')),
    privateGitDir: await realpath(resolve(await git(cwd, 'rev-parse', '--absolute-git-dir'))),
    head: await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}'),
    fingerprint: digest(await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all')),
  }
}

async function privateStatePath(cwd, runId) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`invalid run id: ${runId}`)
  const gitDir = await realpath(resolve(await git(cwd, 'rev-parse', '--absolute-git-dir')))
  return join(gitDir, 'dev-harness', 'dsh', runId, 'state.json')
}

async function captureBaseline(cwd, lockfilePath, dependencies) {
  return {
    repo: await repositoryIdentity(cwd),
    lockfileDigest: digest(await readFile(lockfilePath)),
    dependencies: { ...dependencies },
  }
}

async function validateResume(baseline, cwd, lockfilePath, dependencies) {
  const current = await repositoryIdentity(cwd)
  if (
    current.worktreeRoot !== baseline.repo.worktreeRoot
    || current.privateGitDir !== baseline.repo.privateGitDir
  ) {
    throw new ResumeMismatchError('WORKTREE_MISMATCH', 'worktree root or private Git dir changed')
  }
  if (current.head !== baseline.repo.head) {
    throw new ResumeMismatchError('HEAD_MISMATCH', 'HEAD commit changed')
  }
  if (digest(await readFile(lockfilePath)) !== baseline.lockfileDigest) {
    throw new ResumeMismatchError('DEPENDENCY_MISMATCH', 'lockfile digest changed')
  }
  for (const [name, version] of Object.entries(baseline.dependencies)) {
    if (dependencies[name] !== version) {
      throw new ResumeMismatchError('DEPENDENCY_MISMATCH', `${name} resolved to ${dependencies[name]}`)
    }
  }
  if (current.fingerprint !== baseline.repo.fingerprint) {
    throw new ResumeMismatchError('WORKTREE_MISMATCH', 'tracked or untracked worktree content changed')
  }
}

async function expectMismatch(code, baseline, cwd, lockfilePath, dependencies, statePath) {
  const before = await readFile(statePath, 'utf8')
  await assert.rejects(
    validateResume(baseline, cwd, lockfilePath, dependencies),
    error => error instanceof ResumeMismatchError && error.code === code,
  )
  assert.equal(await readFile(statePath, 'utf8'), before)
}

async function writeSkill(worktree, description, body) {
  const directory = join(worktree, '.dsh', 'skills', 'worktree-probe')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    'name: worktree-probe',
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n'))
}

function spawnWriter(statePath, writerId) {
  const child = fork(childScript, [statePath, writerId], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const ready = Promise.withResolvers()
  const done = Promise.withResolvers()
  let settled = false
  child.on('message', message => {
    if (message === 'ready') ready.resolve()
    if (message?.type === 'done') {
      settled = true
      done.resolve()
    }
    if (message?.type === 'error') {
      settled = true
      done.reject(new Error(message.message))
    }
  })
  child.on('error', error => {
    ready.reject(error)
    if (!settled) done.reject(error)
  })
  child.on('exit', code => {
    if (!settled && code !== 0) done.reject(new Error(`writer ${writerId} exited ${code}`))
  })
  return { child, ready: ready.promise, done: done.promise }
}

async function exerciseConcurrentWriters(statePath) {
  await writeFileAtomic(statePath, JSON.stringify({ revision: 0, writers: [] }), {
    mode: 0o600,
    dirMode: 0o700,
  })
  const writers = Array.from({ length: 8 }, (_value, index) => spawnWriter(statePath, String(index)))
  try {
    await Promise.all(writers.map(writer => writer.ready))
    let reading = true
    const readErrors = []
    const reader = (async () => {
      while (reading) {
        try {
          JSON.parse(await readFile(statePath, 'utf8'))
        } catch (error) {
          readErrors.push(error)
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    })()
    for (const writer of writers) writer.child.send('go')
    await Promise.all(writers.map(writer => writer.done))
    reading = false
    await reader

    assert.deepEqual(readErrors, [])
    const finalState = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(finalState.revision, 8)
    assert.equal(finalState.writers.length, 8)
    assert.equal(new Set(finalState.writers).size, 8)
    const siblings = await readdir(dirname(statePath))
    assert.equal(siblings.some(name => name.endsWith('.lock') || name.endsWith('.tmp')), false)
    if (process.platform !== 'win32') {
      assert.equal((await stat(statePath)).mode & 0o777, 0o600)
    }
  } finally {
    for (const writer of writers) {
      if (!writer.child.killed && writer.child.connected) writer.child.kill()
    }
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-v0-worktree-'))
const primary = join(scratch, 'primary')
const linked = join(scratch, 'linked')
const lockfile = join(primary, 'pnpm-lock.yaml')
const linkedLockfile = join(linked, 'pnpm-lock.yaml')
const readme = join(primary, 'README.md')
const originalReadme = 'fixture repository\n'
const dependencies = {
  '@deepseek-ai/dsh-atomic-write': atomicPackage.version,
  '@deepseek-ai/dsh-skill-filesystem': skillFileSystemPackage.version,
}
let ctx

try {
  assert.deepEqual(dependencies, {
    '@deepseek-ai/dsh-atomic-write': EXPECTED_VERSION,
    '@deepseek-ai/dsh-skill-filesystem': EXPECTED_VERSION,
  })

  await mkdir(primary, { recursive: true })
  await git(primary, 'init', '-b', 'main')
  await git(primary, 'config', 'user.name', 'V0 Offline Fixture')
  await git(primary, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(readme, originalReadme)
  await writeFile(lockfile, 'lockfileVersion: 9\n')
  await git(primary, 'add', 'README.md', 'pnpm-lock.yaml')
  await git(primary, 'commit', '-m', 'fixture baseline')
  await git(primary, 'worktree', 'add', '-b', 'linked-probe', linked)

  await writeSkill(primary, 'Primary worktree probe', 'Primary worktree body.')
  await writeSkill(linked, 'Linked worktree probe', 'Linked worktree body.')
  const primaryNested = join(primary, 'src', 'nested')
  const linkedNested = join(linked, 'src', 'nested')
  await mkdir(primaryNested, { recursive: true })
  await mkdir(linkedNested, { recursive: true })

  ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    watch: false,
    dshHome: join(scratch, 'isolated-home', '.dsh'),
    agentsHome: join(scratch, 'isolated-home', '.agents'),
    bundledSkillDir: join(scratch, 'isolated-bundled'),
  })

  const primarySnapshot = await ctx.skills.snapshot({ cwd: primaryNested })
  const linkedSnapshot = await ctx.skills.snapshot({ cwd: linkedNested })
  assert.equal(primarySnapshot.complete, true)
  assert.equal(linkedSnapshot.complete, true)
  assert.deepEqual(primarySnapshot.skills.map(skill => skill.name), ['worktree-probe'])
  assert.deepEqual(linkedSnapshot.skills.map(skill => skill.name), ['worktree-probe'])
  const primarySkill = await ctx.skills.get('worktree-probe', { cwd: primaryNested })
  const linkedSkill = await ctx.skills.get('worktree-probe', { cwd: linkedNested })
  assert.equal(primarySkill?.source, 'project-dsh')
  assert.equal(linkedSkill?.source, 'project-dsh')
  assert.equal(primarySkill?.content, 'Primary worktree body.')
  assert.equal(linkedSkill?.content, 'Linked worktree body.')
  assert.equal(primarySkill?.path, join(primary, '.dsh', 'skills', 'worktree-probe', 'SKILL.md'))
  assert.equal(linkedSkill?.path, join(linked, '.dsh', 'skills', 'worktree-probe', 'SKILL.md'))

  const primaryGitDir = await realpath(join(primary, '.git'))
  const linkedGitDir = await realpath(resolve(await git(linked, 'rev-parse', '--absolute-git-dir')))
  const primaryState = await privateStatePath(primary, 'v0-state')
  const linkedState = await privateStatePath(linked, 'v0-state')
  assert.equal(primaryState, join(primaryGitDir, 'dev-harness', 'dsh', 'v0-state', 'state.json'))
  assert.equal(linkedState, join(linkedGitDir, 'dev-harness', 'dsh', 'v0-state', 'state.json'))
  assert.equal(linkedGitDir.startsWith(join(primaryGitDir, 'worktrees')), true)
  assert.notEqual(linkedState, join(linked, '.git', 'dev-harness', 'dsh', 'v0-state', 'state.json'))
  assert.notEqual(
    linkedGitDir,
    await realpath(await git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
  )

  await exerciseConcurrentWriters(linkedState)

  const baseline = await captureBaseline(primary, lockfile, dependencies)
  await expectMismatch('WORKTREE_MISMATCH', baseline, linked, linkedLockfile, dependencies, linkedState)

  await appendFile(readme, 'dirty edit\n')
  await expectMismatch('WORKTREE_MISMATCH', baseline, primary, lockfile, dependencies, linkedState)
  await writeFile(readme, originalReadme)

  await appendFile(readme, 'new committed line\n')
  await git(primary, 'add', 'README.md')
  await git(primary, 'commit', '-m', 'advance fixture head')
  await expectMismatch('HEAD_MISMATCH', baseline, primary, lockfile, dependencies, linkedState)

  const currentBaseline = await captureBaseline(primary, lockfile, dependencies)
  await appendFile(lockfile, 'changed: true\n')
  await expectMismatch('DEPENDENCY_MISMATCH', currentBaseline, primary, lockfile, dependencies, linkedState)
  await writeFile(lockfile, 'lockfileVersion: 9\n')
  await expectMismatch('DEPENDENCY_MISMATCH', currentBaseline, primary, lockfile, {
    ...dependencies,
    '@deepseek-ai/dsh-atomic-write': '0.1.0-rc.9',
  }, linkedState)

  await assert.rejects(privateStatePath(primary, '../escape'), /invalid run id/)
  console.log('PASS  Skill lookup stays isolated across linked worktrees')
  console.log('PASS  private Git state survives concurrent atomic writers')
  console.log('PASS  resume rejects worktree, HEAD, and dependency drift without mutation')
  console.log('\n3/3 worktree and state checks passed')
} finally {
  if (ctx !== undefined) await ctx.fiber.dispose()
  await rm(scratch, { recursive: true, force: true })
}
