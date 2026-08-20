import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const checks = []

async function check(label, fn) {
  try {
    await fn()
    checks.push({ label, ok: true })
  } catch (error) {
    checks.push({ label, ok: false, error })
  }
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  requests = []
  started = Promise.withResolvers()

  constructor(script) {
    super()
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'hang') {
      this.started.resolve()
      await new Promise((_resolve, reject) => {
        const abort = () => reject(new Error('mock stream aborted'))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    for (const chunk of textResponse(entry)) yield chunk
  }
}

async function mount(adapter, persistenceRoot) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, {
      root: persistenceRoot,
      compression: 'none',
    })
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function userMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function within(promise, label, timeoutMs = 5000) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

await check('keyless agent create, run, whenIdle, and dispose', async () => {
  const adapter = new ScriptedAdapter(['offline answer'])
  const ctx = await mount(adapter)
  const statuses = []
  const id = SessionId('v0-agent-create')
  let handle
  try {
    handle = await ctx.agents.create({
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'scripted' },
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (agent === handle.agent) statuses.push(status)
    })

    assert.equal(ctx.agents.get(id), handle.agent)
    assert.equal(ctx.sessions.get(id), handle.agent.session)
    handle.agent.followup(userMessage('hello offline agent'))
    await within(handle.agent.whenIdle(), 'agent completion')

    assert.deepEqual(statuses, ['running', 'idle'])
    assert.equal(adapter.requests.length, 1)
    assert.equal(adapter.requests[0].provider, 'mock')
    assert.equal(adapter.requests[0].model, 'scripted')
    const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
    assert.deepEqual(turnEnd?.data.reason, { kind: 'completed' })
    assert.equal(
      handle.agent.session.events.some(event => event.type === 'assistant/message'),
      true,
    )

    await handle.dispose()
    handle = undefined
    assert.equal(ctx.agents.get(id), undefined)
    assert.equal(ctx.sessions.get(id), undefined)
  } finally {
    if (handle !== undefined) await handle.dispose()
    await ctx.fiber.dispose()
  }
})

await check('keyless agent cancellation propagates and reaches idle', async () => {
  const adapter = new ScriptedAdapter(['hang'])
  const ctx = await mount(adapter)
  let handle
  try {
    handle = await ctx.agents.create({
      sessionId: SessionId('v0-agent-cancel'),
      agentOptions: { provider: 'mock', model: 'scripted' },
    })
    handle.agent.followup(userMessage('wait until cancelled'))
    await within(adapter.started.promise, 'mock stream start')

    const idle = handle.agent.whenIdle()
    handle.agent.cancel({ kind: 'user' })
    await within(idle, 'agent cancellation')

    assert.equal(handle.agent.status, 'idle')
    const turnEnd = handle.agent.session.events.findLast(event => event.type === 'turn/end')
    assert.deepEqual(turnEnd?.data.reason, {
      kind: 'aborted',
      reason: { kind: 'user' },
    })
  } finally {
    if (handle !== undefined) await handle.dispose()
    await ctx.fiber.dispose()
  }
})

await check('JSONL session resumes in a fresh Context without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v0-agent-'))
  const id = SessionId('v0-agent-resume')
  let ctx1
  let ctx2
  let handle1
  let handle2
  try {
    ctx1 = await mount(new ScriptedAdapter(['first answer']), root)
    handle1 = await ctx1.agents.create({
      sessionId: id,
      agentOptions: { provider: 'mock', model: 'scripted' },
    })
    handle1.agent.followup(userMessage('first question'))
    await within(handle1.agent.whenIdle(), 'first persistent turn')
    const firstEventCount = handle1.agent.session.events.length
    await ctx1.sessions.flush(handle1.agent.session)
    await handle1.dispose()
    handle1 = undefined
    await ctx1.fiber.dispose()
    ctx1 = undefined

    ctx2 = await mount(new ScriptedAdapter(['second answer']), root)
    handle2 = await ctx2.agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: 'mock', model: 'scripted' },
    })
    assert.equal(handle2.agent.session.firstLiveSeq, firstEventCount)
    assert.equal(handle2.agent.session.events.at(-1)?.type, 'session/end-seed')

    handle2.agent.followup(userMessage('second question'))
    await within(handle2.agent.whenIdle(), 'resumed persistent turn')
    assert.deepEqual(
      handle2.agent.session.events
        .filter(event => event.type === 'turn/start')
        .map(event => event.data.turn),
      [1, 2],
    )
    assert.deepEqual(
      handle2.agent.session.events.map(event => event.seq),
      handle2.agent.session.events.map((_event, index) => index),
    )
  } finally {
    if (handle2 !== undefined) await handle2.dispose()
    if (ctx2 !== undefined) await ctx2.fiber.dispose()
    if (handle1 !== undefined) await handle1.dispose()
    if (ctx1 !== undefined) await ctx1.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

const failed = checks.filter(result => !result.ok)
for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}`)
  if (!result.ok) console.error(result.error)
}
console.log(`\n${checks.length - failed.length}/${checks.length} agent checks passed`)
if (failed.length > 0) process.exitCode = 1
