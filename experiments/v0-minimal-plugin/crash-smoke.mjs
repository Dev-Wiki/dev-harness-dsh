import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const childScript = join(fixtureDir, 'crash-agent-child.mjs')
const sessionId = SessionId('v0-agent-crash')

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RecoveryAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream() {
    yield *textResponse('recovered answer')
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

async function waitForMarker(marker, expected) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const content = await readFile(marker, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (content === expected) return
    if (content !== undefined && !expected.startsWith(content)) {
      throw new Error(`unexpected crash marker ${JSON.stringify(content)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`crash child did not publish ${JSON.stringify(expected)}`)
}

async function mountRecovery(root) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(CheckpointPolicy)
  ctx.llm.registerAdapter(['mock'], new RecoveryAdapter())
  return ctx
}

if (process.platform === 'win32') {
  console.log('SKIP  hard-crash recovery requires POSIX SIGKILL')
} else {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v0-crash-'))
  const marker = join(root, 'failpoint')
  await writeFile(marker, '')
  let child
  let ctx
  let handle
  try {
    child = spawn(process.execPath, [childScript, root, marker], {
      cwd: fixtureDir,
      env: {},
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    const exited = once(child, 'exit')
    await Promise.race([
      waitForMarker(marker, 'request-dispatched'),
      exited.then(([code, signal]) => {
        throw new Error(`crash child exited early: code=${code} signal=${signal}\n${stderr}`)
      }),
    ])

    assert.equal(child.kill('SIGKILL'), true)
    const [code, signal] = await within(exited, 'crash child SIGKILL')
    assert.equal(code, null)
    assert.equal(signal, 'SIGKILL')
    child = undefined

    ctx = await mountRecovery(root)
    handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: 'mock', model: 'scripted' },
    })
    const types = handle.agent.session.events.map(event => event.type)
    assert.deepEqual(types.slice(0, 10), [
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'user/message',
      'request/header',
      'request/context',
      'step/end',
      'turn/end',
      'session/end-seed',
    ])
    const interrupted = handle.agent.session.events
      .findLast(event => event.type === 'turn/end')
    assert.deepEqual(interrupted?.data.reason, { kind: 'interrupted' })

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue after crash' }],
      source: { kind: 'user' },
    }))
    await within(handle.agent.whenIdle(), 'post-crash resumed turn')
    assert.deepEqual(
      handle.agent.session.events
        .filter(event => event.type === 'turn/start')
        .map(event => event.data.turn),
      [1, 2],
    )
    console.log('PASS  SIGKILL checkpoint repair resumes with a continuous second turn')
  } finally {
    if (child !== undefined) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => undefined)
    }
    if (handle !== undefined) await handle.dispose()
    if (ctx !== undefined) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
