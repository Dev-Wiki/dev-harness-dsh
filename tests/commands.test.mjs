import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import * as Plugin from '../lib/index.js'

const execFile = promisify(execFileCallback)
const CORE_SKILLS = [
  'dev-harness-auto-fix',
  'dev-harness-codebase-audit',
  'dev-harness-commands',
  'dev-harness-git-workflow',
]

async function git(cwd, ...args) {
  return await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

async function createRepository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-harness-commands-'))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Command Test')
  await git(cwd, 'config', 'user.email', 'command@example.test')
  await writeFile(join(cwd, 'README.md'), '# command fixture\n')
  await writeFile(join(cwd, 'AGENTS.md'), '# Agents\n')
  await writeFile(join(cwd, 'ARCHITECTURE.md'), '# Architecture\n')
  await writeFile(join(cwd, 'HARNESS.md'), '# Harness\n')
  await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', 'fixture')
  return cwd
}

function registerCoreSkills(ctx) {
  return CORE_SKILLS.map(name => ctx.skills.register({
    name,
    description: `${name} test fixture`,
    content: `# ${name}\n`,
  }))
}

async function createHarness(options = {}) {
  const cwd = options.cwd ?? await createRepository()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  const skillDisposers = registerCoreSkills(ctx)
  if (options.incomplete === true) {
    ctx.skills.registerProvider(() => ({
      name: 'incomplete-test',
      async list() {
        return { candidates: [], complete: false }
      },
      async get() {
        return undefined
      },
    }))
  }
  const session = ctx.sessions.create(SessionId(`command-${Date.now()}-${Math.random()}`), {
    meta: { cwd },
  })
  const agent = { id: session.id, session }
  const pluginFiber = await ctx.plugin(Plugin, options.config ?? {})
  return {
    agent,
    ctx,
    cwd,
    pluginFiber,
    session,
    skillDisposers,
    async dispose() {
      await pluginFiber.dispose()
      for (const dispose of skillDisposers.reverse()) dispose()
      await ctx.fiber.dispose()
      if (options.cwd === undefined) await rm(cwd, { recursive: true, force: true })
    },
  }
}

async function execute(harness, line, signal = new AbortController().signal) {
  return await harness.ctx.commands.execute(harness.agent, line, [], signal)
}

test('run, status, pause/resume, cancel, and command lifecycle stay deterministic', async () => {
  const harness = await createHarness()
  try {
    const descriptors = harness.ctx.commands.list(harness.agent).map(command => command.name)
    assert.deepEqual(descriptors, ['harness-resume', 'harness-run', 'harness-status'])

    const started = await execute(harness, '/harness-run')
    assert.equal(started?.result.kind, 'success')
    const startedView = JSON.parse(started.result.text)
    assert.equal(startedView.phase, 'PREFLIGHT')
    assert.equal(startedView.status, 'RUNNING')
    assert.equal(startedView.revision, 1)

    const duplicate = await execute(harness, '/harness-run')
    assert.equal(duplicate?.result.kind, 'error')
    assert.match(duplicate.result.text, /^ACTIVE_RUN_EXISTS:/u)

    const status = await execute(harness, '/harness-status')
    assert.deepEqual(JSON.parse(status.result.text), startedView)

    const state = await Plugin.loadRun(harness.cwd, startedView.runId)
    const paused = await Plugin.updateRun({
      cwd: harness.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.status = 'PAUSED'
      },
    })
    const resumed = await execute(harness, `/harness-resume ${paused.runId}`)
    assert.equal(JSON.parse(resumed.result.text).status, 'RUNNING')

    const cancelled = await Plugin.cancelRun(harness.cwd, paused.runId)
    assert.equal(cancelled.status, 'CANCELLED')
    assert.deepEqual(await Plugin.cancelRun(harness.cwd, paused.runId), cancelled)
    const terminalResume = await execute(harness, `/harness-resume ${paused.runId}`)
    assert.equal(terminalResume?.result.kind, 'error')
    assert.match(terminalResume.result.text, /^TERMINAL_RUN:/u)

    const lifecycle = harness.session.events
      .filter(event => event.type === 'command/run' || event.type === 'command/done')
    assert.equal(lifecycle.length, 10)
    for (let index = 0; index < lifecycle.length; index += 2) {
      assert.equal(lifecycle[index].type, 'command/run')
      assert.equal(lifecycle[index + 1].type, 'command/done')
      assert.equal(lifecycle[index].data.commandId, lifecycle[index + 1].data.commandId)
    }
    assert.equal(harness.session.events.some(event => event.type === 'turn/start'), false)
  } finally {
    await harness.dispose()
  }
})

test('missing and incomplete Skill catalogs fail closed before state creation', async () => {
  const missing = await createHarness({ config: { additionalRequiredSkills: ['not-installed'] } })
  try {
    const result = await execute(missing, '/harness-run')
    assert.equal(result?.result.kind, 'error')
    assert.match(result.result.text, /^REQUIRED_SKILLS_MISSING:/u)
    assert.deepEqual(await Plugin.listRuns(missing.cwd), [])
  } finally {
    await missing.dispose()
  }

  const incomplete = await createHarness({ incomplete: true })
  try {
    const result = await execute(incomplete, '/harness-run')
    assert.equal(result?.result.kind, 'error')
    assert.match(result.result.text, /^SKILL_CATALOG_INCOMPLETE:/u)
    assert.deepEqual(await Plugin.listRuns(incomplete.cwd), [])
  } finally {
    await incomplete.dispose()
  }
})

test('input, cwd, cancellation, and fiber disposal boundaries are fail closed', async () => {
  const harness = await createHarness()
  try {
    assert.equal((await execute(harness, '/harness-run unexpected')).result.kind, 'error')
    assert.equal((await execute(harness, '/harness-resume')).result.kind, 'error')
    assert.equal((await execute(harness, '/harness-status one two')).result.kind, 'error')

    const controller = new AbortController()
    controller.abort(new Error('cancel before dispatch'))
    await assert.rejects(
      execute(harness, '/harness-run', controller.signal),
      /cancel before dispatch/u,
    )
    assert.deepEqual(await Plugin.listRuns(harness.cwd), [])

    await harness.pluginFiber.dispose()
    assert.equal(harness.ctx.commands.find(harness.agent, 'harness-run'), undefined)
    assert.equal(harness.ctx.commands.find(harness.agent, 'harness-resume'), undefined)
    assert.equal(harness.ctx.commands.find(harness.agent, 'harness-status'), undefined)
  } finally {
    await harness.dispose()
  }
})

test('session without cwd is rejected without touching repository state', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  registerCoreSkills(ctx)
  const session = ctx.sessions.create(SessionId('command-no-cwd'))
  const agent = { id: session.id, session }
  const fiber = await ctx.plugin(Plugin)
  try {
    const result = await ctx.commands.execute(agent, '/harness-run', [], new AbortController().signal)
    assert.equal(result?.result.kind, 'error')
    assert.match(result.result.text, /no workspace cwd/u)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
