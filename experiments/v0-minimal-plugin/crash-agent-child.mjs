import { writeFile } from 'node:fs/promises'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as CheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const [persistenceRoot, marker] = process.argv.slice(2)
if (persistenceRoot === undefined || marker === undefined) {
  throw new Error('usage: crash-agent-child.mjs <persistence-root> <marker>')
}

function waitForKill() {
  return new Promise(() => {
    setInterval(() => {}, 60_000)
  })
}

class CrashAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream() {
    await writeFile(marker, 'request-dispatched')
    yield await waitForKill()
  }
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(JsonlSessionPersistence, {
  root: persistenceRoot,
  compression: 'none',
})
await ctx.plugin(CheckpointPolicy)
ctx.llm.registerAdapter(['crash'], new CrashAdapter())

const handle = await ctx.agents.create({
  sessionId: SessionId('v0-agent-crash'),
  agentOptions: { provider: 'crash', model: 'crash' },
})
handle.agent.followup(createUserMessage({
  content: [{ type: 'text', text: 'exercise the hard-crash checkpoint' }],
  source: { kind: 'user' },
}))
await waitForKill()
