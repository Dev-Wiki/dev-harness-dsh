import assert from 'node:assert/strict'
import { once } from 'node:events'

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

const checks = []

async function check(label, fn) {
  try {
    await fn()
    checks.push({ label, ok: true })
  } catch (error) {
    checks.push({ label, ok: false, error })
  }
}

async function within(promise, label, timeoutMs = 10000) {
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

class StubProvider {
  name = 'stub'
  capabilities = {
    outputSchema: true,
    depthLimit: false,
    toolFilter: false,
    persona: false,
  }
  inheritsParentContext = false
  runs = []
  started = Promise.withResolvers()

  constructor({ manual = false } = {}) {
    this.manual = manual
  }

  async start(request) {
    const terminal = Promise.withResolvers()
    const index = this.runs.length
    const record = {
      request,
      disposed: false,
      settle: terminal.resolve,
    }
    this.runs.push(record)
    this.started.resolve(record)
    request.signal.addEventListener('abort', () => {
      terminal.resolve({ output: [], stopReason: 'aborted' })
    }, { once: true })
    if (!this.manual) {
      queueMicrotask(() => terminal.resolve({
        output: [{ type: 'text', text: 'offline reply' }],
        stopReason: 'completed',
      }))
    }
    return {
      id: SessionId(`v0-workflow-child-${index}`),
      localAgent: undefined,
      result: terminal.promise,
      dispose: async () => {
        record.disposed = true
        terminal.resolve({ output: [], stopReason: 'aborted' })
      },
    }
  }
}

function parentAgent() {
  return {
    id: SessionId('v0-workflow-parent'),
    options: {},
  }
}

async function setup(provider) {
  const ctx = new Context()
  const subagentFiber = await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider(provider)
  const engineFiber = await ctx.plugin(WorkerThreadWorkflowEngine, {
    provider: 'stub',
    maxConcurrentAgents: 2,
    disposeGraceMs: 100,
  })
  return { ctx, engineFiber, subagentFiber }
}

async function disposeRunAndAssertWorkerExit(run) {
  const worker = run.worker
  assert.equal(typeof worker?.terminate, 'function')
  const exited = once(worker, 'exit')
  await run.dispose()
  await within(exited, 'workflow worker exit')
  assert.equal(worker.threadId, -1)
}

await check('worker workflow completes with paired events and disposes its child', async () => {
  const provider = new StubProvider()
  const { ctx, engineFiber, subagentFiber } = await setup(provider)
  const events = []
  for (const name of [
    'workflow/start',
    'workflow/phase',
    'workflow/log',
    'workflow/agent-start',
    'workflow/agent-end',
    'workflow/end',
  ]) {
    ctx.on(name, (...payload) => events.push({ name, payload }))
  }
  let run
  try {
    run = ctx.workflowEngine.start({
      meta: { name: 'v0-offline-complete', description: 'offline workflow smoke' },
      script: `
        phase('Work')
        log('offline')
        const answer = await agent('complete')
        return { answer }
      `,
      parent: parentAgent(),
    })
    const result = await within(run.result, 'workflow completion')
    assert.deepEqual(result, {
      value: { answer: 'offline reply' },
      stopReason: 'completed',
      agentsStarted: 1,
    })
    assert.deepEqual(
      events.map(event => event.name),
      [
        'workflow/start',
        'workflow/phase',
        'workflow/log',
        'workflow/agent-start',
        'workflow/agent-end',
        'workflow/end',
      ],
    )
    assert.equal(events[3].payload[1].seq, 1)
    assert.equal(events[4].payload[1].seq, 1)
    assert.equal(events[4].payload[1].outcome, 'completed')
    assert.equal(provider.runs[0].disposed, true)
    await disposeRunAndAssertWorkerExit(run)
    run = undefined
  } finally {
    if (run !== undefined) await run.dispose()
    await engineFiber.dispose()
    await subagentFiber.dispose()
    await ctx.fiber.dispose()
  }
})

await check('workflow cancel aborts the child and terminates the worker', async () => {
  const provider = new StubProvider({ manual: true })
  const { ctx, engineFiber, subagentFiber } = await setup(provider)
  const agentEnds = []
  ctx.on('workflow/agent-end', (_info, event) => agentEnds.push(event))
  let run
  try {
    run = ctx.workflowEngine.start({
      meta: { name: 'v0-offline-cancel', description: 'offline cancellation smoke' },
      script: "return await agent('hold until cancelled')",
      parent: parentAgent(),
    })
    const child = await within(provider.started.promise, 'workflow child start')
    run.cancel('v0 explicit stop')
    const result = await within(run.result, 'workflow cancellation')

    assert.equal(result.stopReason, 'cancelled')
    assert.match(result.error, /v0 explicit stop/)
    assert.equal(child.request.signal.aborted, true)
    assert.deepEqual(agentEnds.map(event => event.outcome), ['cancelled'])
    await disposeRunAndAssertWorkerExit(run)
    run = undefined
    assert.equal(child.disposed, true)
  } finally {
    if (run !== undefined) await run.dispose()
    await engineFiber.dispose()
    await subagentFiber.dispose()
    await ctx.fiber.dispose()
  }
})

await check('holder fiber owns run disposal while engine disposal removes the service', async () => {
  const provider = new StubProvider({ manual: true })
  const { ctx, engineFiber, subagentFiber } = await setup(provider)
  let heldRun
  const holderPlugin = (holderContext) => {
    heldRun = holderContext.workflowEngine.start({
      meta: { name: 'v0-holder', description: 'holder-owned workflow smoke' },
      script: "return await agent('held child')",
      parent: parentAgent(),
    })
    return () => heldRun.dispose()
  }
  holderPlugin.inject = ['workflowEngine']
  let holderFiber
  let heldWorker
  try {
    holderFiber = await ctx.plugin(holderPlugin)
    await within(provider.started.promise, 'holder child start')
    heldWorker = heldRun.worker
    const exited = once(heldWorker, 'exit')
    const result = heldRun.result

    await holderFiber.dispose()
    holderFiber = undefined
    assert.notEqual(heldRun.disposed, undefined)
    await within(exited, 'holder worker exit')
    assert.equal(heldWorker.threadId, -1)
    assert.equal((await within(result, 'holder run settlement')).stopReason, 'cancelled')
    assert.notEqual(ctx.get('workflowEngine'), undefined)

    await engineFiber.dispose()
    assert.equal(ctx.get('workflowEngine'), undefined)
  } finally {
    if (holderFiber !== undefined) await holderFiber.dispose()
    if (heldRun !== undefined) await heldRun.dispose()
    await engineFiber.dispose()
    await subagentFiber.dispose()
    await ctx.fiber.dispose()
  }
})

const failed = checks.filter(result => !result.ok)
for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}`)
  if (!result.ok) console.error(result.error)
}
console.log(`\n${checks.length - failed.length}/${checks.length} workflow checks passed`)
if (failed.length > 0) process.exitCode = 1
