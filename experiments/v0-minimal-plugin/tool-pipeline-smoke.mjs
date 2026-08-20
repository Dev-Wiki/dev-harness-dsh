import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  HarnessError,
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  defineContentToolFixture,
} from '@deepseek-ai/dsh-tools'

const TOOL_NAME = 'pipeline_probe'
const CALL_IDS = {
  success: 'call-success',
  error: 'call-error',
  cancelRunning: 'call-cancel-running',
  cancelBefore: 'call-cancel-before',
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

function toolCallResponse(rawCallId, mode) {
  const callId = CallId(rawCallId)
  const argumentsJson = JSON.stringify({ mode })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name: TOOL_NAME,
      argumentsDelta: argumentsJson,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: TOOL_NAME, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  requests = []

  constructor(script) {
    super()
    this.script = [...script]
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options) {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
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

async function mount(adapter, persistenceRoot) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, {
    root: persistenceRoot,
    compression: 'none',
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function durableCallId(event) {
  if (event.type === 'tool/call') return String(event.data.callId)
  if (event.type === 'tool/result') return String(event.data.message.source.callId)
  return undefined
}

function pairedToolEvents(events) {
  return events
    .filter(event => event.type === 'tool/call' || event.type === 'tool/result')
    .map(event => ({
      type: event.type,
      callId: durableCallId(event),
      ...(event.type === 'tool/call'
        ? { name: event.data.name, arguments: event.data.arguments }
        : {
            isError: event.data.message.content[0]?.isError,
            error: event.data.error,
          }),
    }))
}

const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-v0-tool-pipeline-'))
const sessionId = SessionId('v0-tool-pipeline')
const adapter = new ScriptedAdapter([
  toolCallResponse(CALL_IDS.success, 'success'),
  textResponse('success observed'),
  toolCallResponse(CALL_IDS.error, 'error'),
  textResponse('error observed'),
  toolCallResponse(CALL_IDS.cancelRunning, 'cancel-running'),
  toolCallResponse(CALL_IDS.cancelBefore, 'cancel-before'),
])
const bodyEntered = Promise.withResolvers()
const order = new Map(Object.values(CALL_IDS).map(callId => [callId, []]))
let ctx
let resumedCtx
let handle
let resumedHandle

function record(callId, step) {
  order.get(String(callId))?.push(step)
}

try {
  ctx = await mount(adapter, persistenceRoot)
  ctx.tools.register(defineContentToolFixture({
    name: TOOL_NAME,
    description: 'Exercise every Tool pipeline terminal path offline',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['success', 'error', 'cancel-running', 'cancel-before'],
      },
    },
    async execute(args, exec) {
      record(exec.callId, 'body')
      if (args.mode === 'error') {
        throw new HarnessError('probe exploded', 'PROBE_EXPLODED')
      }
      if (args.mode === 'cancel-running') {
        bodyEntered.resolve()
        await new Promise(resolve => {
          if (exec.signal.aborted) resolve()
          else exec.signal.addEventListener('abort', resolve, { once: true })
        })
        assert.equal(exec.signal.aborted, true)
      }
      return [{ type: 'text', text: `probe:${args.mode}` }]
    },
  }))

  ctx.on('tools/pre-execute', async (exec, next) => {
    record(exec.callId, 'pre')
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    record(exec.callId, 'execute:before')
    const result = await next()
    record(exec.callId, 'execute:after')
    return result
  })
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    record(exec.callId, 'post')
    return next()
  })
  ctx.on('tools/result', (exec) => {
    record(exec.callId, 'result')
  })

  handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: 'mock', model: 'scripted' },
  })
  ctx.on('session/event', (session, event) => {
    if (session !== handle?.agent.session) return
    if (event.type === 'tool/call') record(event.data.callId, 'durable:call')
    if (event.type === 'tool/result') record(event.data.message.source.callId, 'durable:result')
    if (
      event.type === 'assistant/message'
      && event.data.message.content.some(
        block => block.type === 'tool-call' && String(block.id) === CALL_IDS.cancelBefore,
      )
    ) {
      handle.agent.cancel({ kind: 'user' })
    }
  })

  handle.agent.followup(userMessage('run success'))
  await within(handle.agent.whenIdle(), 'successful tool turn')

  handle.agent.followup(userMessage('run structured failure'))
  await within(handle.agent.whenIdle(), 'failed tool turn')

  handle.agent.followup(userMessage('run then cancel'))
  await within(bodyEntered.promise, 'cancellable tool body entry')
  const cancelRunningIdle = handle.agent.whenIdle()
  handle.agent.cancel({ kind: 'user' })
  await within(cancelRunningIdle, 'running tool cancellation')

  handle.agent.followup(userMessage('cancel before dispatch'))
  await within(handle.agent.whenIdle(), 'pre-dispatch tool cancellation')

  const completeOrder = [
    'durable:call',
    'pre',
    'execute:before',
    'body',
    'execute:after',
    'post',
    'result',
    'durable:result',
  ]
  assert.deepEqual(order.get(CALL_IDS.success), completeOrder)
  assert.deepEqual(order.get(CALL_IDS.error), completeOrder)
  assert.deepEqual(order.get(CALL_IDS.cancelRunning), completeOrder)
  assert.deepEqual(order.get(CALL_IDS.cancelBefore), [
    'durable:call',
    'durable:result',
  ])

  const durable = pairedToolEvents(handle.agent.session.events)
  assert.deepEqual(durable.map(event => `${event.type}:${event.callId}`), [
    `tool/call:${CALL_IDS.success}`,
    `tool/result:${CALL_IDS.success}`,
    `tool/call:${CALL_IDS.error}`,
    `tool/result:${CALL_IDS.error}`,
    `tool/call:${CALL_IDS.cancelRunning}`,
    `tool/result:${CALL_IDS.cancelRunning}`,
    `tool/call:${CALL_IDS.cancelBefore}`,
    `tool/result:${CALL_IDS.cancelBefore}`,
  ])
  assert.deepEqual(
    durable.filter(event => event.type === 'tool/call').map(event => event.name),
    [TOOL_NAME, TOOL_NAME, TOOL_NAME, TOOL_NAME],
  )
  assert.equal(durable[1].isError, false)
  assert.deepEqual(durable[3].error, { name: 'HarnessError', code: 'PROBE_EXPLODED' })
  assert.deepEqual(durable[5].error, { name: 'AbortError', code: TOOL_ABORTED })
  assert.deepEqual(durable[7].error, {
    name: 'AbortError',
    code: TOOL_ABORTED_BEFORE_DISPATCH,
  })
  assert.deepEqual(
    handle.agent.session.events
      .filter(event => event.type === 'turn/end')
      .map(event => event.data.reason.kind),
    ['completed', 'completed', 'aborted', 'aborted'],
  )
  assert.equal(adapter.requests.length, 6)

  await ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  handle = undefined
  await ctx.fiber.dispose()
  ctx = undefined

  resumedCtx = await mount(new ScriptedAdapter([]), persistenceRoot)
  resumedHandle = await resumedCtx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions: { provider: 'mock', model: 'scripted' },
  })
  assert.deepEqual(
    pairedToolEvents(resumedHandle.agent.session.events).map(event => `${event.type}:${event.callId}`),
    durable.map(event => `${event.type}:${event.callId}`),
  )

  console.log('PASS  Tool pipeline success, error, cancellation, and replay stay paired')
  console.log('\n1/1 Tool pipeline checks passed')
} finally {
  if (resumedHandle !== undefined) await resumedHandle.dispose()
  if (resumedCtx !== undefined) await resumedCtx.fiber.dispose()
  if (handle !== undefined) await handle.dispose()
  if (ctx !== undefined) await ctx.fiber.dispose()
  await rm(persistenceRoot, { recursive: true, force: true })
}
