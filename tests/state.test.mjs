import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  RUNTIME_DEPENDENCIES,
  RunStateError,
  createRun,
  listRuns,
  loadRun,
  resolveStatePath,
  updateRun,
  validateResume,
} from '../lib/state.js'

const execFile = promisify(execFileCallback)
const scratchDirectories = new Set()

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return stdout.trim()
}

async function repository(name = 'repo') {
  const scratch = await mkdtemp(join(tmpdir(), `dev-harness-state-${name}-`))
  scratchDirectories.add(scratch)
  const cwd = join(scratch, 'primary')
  await mkdir(cwd)
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'State Test')
  await git(cwd, 'config', 'user.email', 'state@example.invalid')
  await writeFile(join(cwd, 'README.md'), 'baseline\n')
  await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await git(cwd, 'add', 'README.md', 'pnpm-lock.yaml')
  await git(cwd, 'commit', '-m', 'baseline')
  return { scratch, cwd }
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    error => error instanceof RunStateError && error.code === code,
  )
}

test.afterEach(async () => {
  await Promise.all([...scratchDirectories].map(path => rm(path, { recursive: true, force: true })))
  scratchDirectories.clear()
})

test('creates private state with exact runtime dependencies and owner-only permissions', async () => {
  const { cwd } = await repository('create')
  const state = await createRun({
    cwd,
    runId: 'state-create',
    now: new Date('2026-08-20T00:00:00.000Z'),
  })
  const statePath = await resolveStatePath(cwd, state.runId)
  const gitDir = await git(cwd, 'rev-parse', '--absolute-git-dir')

  assert.equal(statePath, join(gitDir, 'dev-harness', 'dsh', state.runId, 'state.json'))
  assert.deepEqual(state.dependencies.packages, RUNTIME_DEPENDENCIES)
  assert.deepEqual(await loadRun(cwd, state.runId), state)
  assert.deepEqual((await listRuns(cwd)).map(run => run.runId), [state.runId])
  assert.equal(await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), '')
  if (process.platform !== 'win32') assert.equal((await stat(statePath)).mode & 0o777, 0o600)
})

test('serializes revision updates and enforces phase and terminal transitions', async () => {
  const { cwd } = await repository('transitions')
  const created = await createRun({ cwd, runId: 'state-transitions' })
  const competing = [0, 1].map(() => updateRun({
    cwd,
    runId: created.runId,
    expectedRevision: 0,
    mutate(draft) {
      draft.phase = 'PREFLIGHT'
    },
  }))
  const settled = await Promise.allSettled(competing)
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(
    settled.filter(result => result.status === 'rejected')
      .every(result => result.reason instanceof RunStateError && result.reason.code === 'REVISION_CONFLICT'),
    true,
  )

  const current = await loadRun(cwd, created.runId)
  assert.equal(current.revision, 1)
  assert.equal(current.phase, 'PREFLIGHT')
  await expectCode(updateRun({
    cwd,
    runId: current.runId,
    expectedRevision: current.revision,
    mutate(draft) {
      draft.phase = 'ROUTE'
    },
  }), 'INVALID_TRANSITION')

  const failed = await updateRun({
    cwd,
    runId: current.runId,
    expectedRevision: current.revision,
    mutate(draft) {
      draft.status = 'FAILED'
      draft.blocker = { code: 'TEST_FAILURE', message: 'terminal fixture state' }
    },
  })
  await expectCode(updateRun({
    cwd,
    runId: failed.runId,
    expectedRevision: failed.revision,
    mutate(draft) {
      draft.status = 'RUNNING'
    },
  }), 'TERMINAL_RUN')
})

test('isolates primary and linked worktree run namespaces', async () => {
  const { scratch, cwd } = await repository('linked')
  const linked = join(scratch, 'linked')
  await git(cwd, 'worktree', 'add', '-b', 'linked-state', linked)
  const primary = await createRun({ cwd, runId: 'primary-run' })
  const linkedRun = await createRun({ cwd: linked, runId: 'linked-run' })
  const primaryPath = await resolveStatePath(cwd, primary.runId)
  const linkedPath = await resolveStatePath(linked, linkedRun.runId)

  assert.notEqual(primaryPath, linkedPath)
  assert.match(linkedPath, /[\\/]\.git[\\/]worktrees[\\/]/u)
  assert.equal(await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), '')
  assert.equal(await git(linked, 'status', '--porcelain=v1', '--untracked-files=all'), '')
})

test('fails closed on worktree, HEAD, lockfile, and runtime dependency drift', async () => {
  const { scratch, cwd } = await repository('drift')
  const state = await createRun({ cwd, runId: 'drift-run' })
  const statePath = await resolveStatePath(cwd, state.runId)
  const originalState = await readFile(statePath, 'utf8')
  const linked = join(scratch, 'linked')
  await git(cwd, 'worktree', 'add', '-b', 'linked-drift', linked)

  await expectCode(validateResume(state, linked), 'WORKTREE_MISMATCH')
  assert.equal(await readFile(statePath, 'utf8'), originalState)

  await appendFile(join(cwd, 'README.md'), 'dirty\n')
  await expectCode(validateResume(state, cwd), 'WORKTREE_MISMATCH')
  await writeFile(join(cwd, 'README.md'), 'baseline\n')

  await appendFile(join(cwd, 'README.md'), 'committed\n')
  await git(cwd, 'add', 'README.md')
  await git(cwd, 'commit', '-m', 'advance head')
  await expectCode(validateResume(state, cwd), 'HEAD_MISMATCH')
  assert.equal(await readFile(statePath, 'utf8'), originalState)
})

test('classifies dependency drift before general dirty-worktree drift', async () => {
  const { cwd } = await repository('dependencies')
  const state = await createRun({ cwd, runId: 'dependency-run' })
  const statePath = await resolveStatePath(cwd, state.runId)
  const originalState = await readFile(statePath, 'utf8')

  await appendFile(join(cwd, 'pnpm-lock.yaml'), 'changed: true\n')
  await expectCode(validateResume(state, cwd), 'DEPENDENCY_MISMATCH')
  await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await expectCode(validateResume(state, cwd, {
    runtimeDependencies: {
      ...RUNTIME_DEPENDENCIES,
      '@deepseek-ai/dsh-atomic-write': '0.1.0-rc.9',
    },
  }), 'DEPENDENCY_MISMATCH')
  assert.equal(await readFile(statePath, 'utf8'), originalState)
})

test('rejects duplicate active runs, invalid ids, corrupt state, and symlink state files', async () => {
  const { cwd } = await repository('reject')
  const state = await createRun({ cwd, runId: 'active-run' })
  await expectCode(createRun({ cwd, runId: 'second-run' }), 'ACTIVE_RUN_EXISTS')
  await expectCode(loadRun(cwd, '../escape'), 'INVALID_RUN_ID')

  const statePath = await resolveStatePath(cwd, state.runId)
  await writeFile(statePath, '{"schemaVersion":999}\n')
  await expectCode(loadRun(cwd, state.runId), 'STATE_CORRUPT')

  if (process.platform !== 'win32') {
    const target = join(cwd, 'README.md')
    await rm(statePath)
    await import('node:fs/promises').then(fs => fs.symlink(target, statePath))
    await expectCode(loadRun(cwd, state.runId), 'STATE_CORRUPT')
    await chmod(target, 0o644)
  }
})
