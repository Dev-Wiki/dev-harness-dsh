import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import CommandRuntime, { parseCommand } from '@deepseek-ai/dsh-commands'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { SkillRegistry, isSkillName } from '@deepseek-ai/dsh-skill'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { WorkflowEngine, WorkflowError } from '@deepseek-ai/dsh-workflow'

import * as fixture from './lib/index.js'

const checks = []
function check(label, fn) {
  try {
    fn()
    checks.push({ label, ok: true })
  } catch (error) {
    checks.push({ label, ok: false, error })
  }
}

check('rc.8 public exports load', () => {
  assert.equal(typeof Context, 'function')
  assert.equal(typeof CommandRuntime, 'function')
  assert.equal(typeof parseCommand, 'function')
  assert.equal(typeof AgentRegistry, 'function')
  assert.equal(typeof agentEvents, 'function')
  assert.equal(typeof SkillRegistry, 'function')
  assert.equal(typeof isSkillName, 'function')
  assert.equal(typeof ToolRuntime, 'function')
  assert.equal(typeof defineTool, 'function')
  assert.equal(typeof WorkflowEngine, 'function')
  assert.equal(typeof WorkflowError, 'function')
})

check('fixture exports the Cordis plugin surface', () => {
  assert.equal(fixture.name, 'dev-harness-dsh-v0-fixture')
  assert.deepEqual(fixture.inject, ['commands'])
  assert.equal(typeof fixture.Config, 'function')
  assert.equal(typeof fixture.apply, 'function')
  assert.equal('default' in fixture, false)
})

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(CommandRuntime)

const session = ctx.sessions.create(SessionId('v0-fixture'))
const agent = { id: session.id, session }
const fiber = await ctx.plugin(fixture, { probe: true })

check('plugin registration becomes visible', () => {
  assert.equal(ctx.commands.find(agent, 'harness-status')?.name, 'harness-status')
})

const execution = await ctx.commands.execute(
  agent,
  '/harness-status',
  [],
  new AbortController().signal,
)
check('human command executes outside a model turn', () => {
  assert.deepEqual(execution?.result, {
    kind: 'success',
    text: 'dev-harness-dsh fixture: probe=true',
  })
  assert.deepEqual(
    session.events
      .filter(event => event.type === 'command/run' || event.type === 'command/done')
      .map(event => event.type),
    ['command/run', 'command/done'],
  )
})

await fiber.dispose()
check('fiber disposal removes the command registration', () => {
  assert.equal(ctx.commands.find(agent, 'harness-status'), undefined)
})

const failed = checks.filter(check => !check.ok)
for (const result of checks) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}`)
  if (!result.ok) console.error(result.error)
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
