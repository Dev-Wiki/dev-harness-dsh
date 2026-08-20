import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import * as Plugin from '../lib/index.js'

test('production plugin exposes a fiber-owned orchestration service', async () => {
  const ctx = new Context()
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(Plugin, {
    additionalRequiredSkills: ['project-extra'],
  })

  try {
    assert.equal(ctx.devHarness instanceof Plugin.DevHarnessRuntime, true)
    assert.deepEqual(ctx.devHarness.requiredSkills, [
      'dev-harness-auto-fix',
      'dev-harness-codebase-audit',
      'dev-harness-commands',
      'dev-harness-git-workflow',
      'project-extra',
    ])
    assert.equal(Object.isFrozen(ctx.devHarness.requiredSkills), true)
  } finally {
    await fiber.dispose()
    assert.equal(ctx.get('devHarness'), undefined)
    await ctx.fiber.dispose()
  }
})

test('core required Skills cannot be configured away', async () => {
  const ctx = new Context()
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(Plugin, { additionalRequiredSkills: [] })
  try {
    assert.equal(ctx.devHarness.requiredSkills.includes('dev-harness-codebase-audit'), true)
    assert.equal(ctx.devHarness.requiredSkills.includes('dev-harness-auto-fix'), true)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('QA registration accepts only named verified Adapters and owns their lifecycle', async () => {
  const ctx = new Context()
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(Plugin)
  const adapter = {
    name: 'fixture-qa',
    kind: 'cli-api',
    verified: true,
    verificationEvidenceRef: 'qa:adapter-verification:fixture',
    async start() {},
    async resume() {},
  }
  try {
    assert.throws(
      () => ctx.devHarness.registerQaAdapter({ ...adapter, name: 'unverified', verified: false }),
      /not verified/u,
    )
    const unregister = ctx.devHarness.registerQaAdapter(adapter)
    assert.throws(() => ctx.devHarness.registerQaAdapter(adapter), /already registered/u)
    unregister()
    const unregisterAgain = ctx.devHarness.registerQaAdapter(adapter)
    unregisterAgain()
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('Final Reconciliation registration is singular and fiber-owned', async () => {
  const ctx = new Context()
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(Plugin)
  const adapter = { name: 'fixture-reconciliation', async start() {}, async resume() {} }
  try {
    const unregister = ctx.devHarness.registerFinalReconciliationAdapter(adapter)
    assert.throws(
      () => ctx.devHarness.registerFinalReconciliationAdapter(adapter),
      /already registered/u,
    )
    unregister()
    const unregisterAgain = ctx.devHarness.registerFinalReconciliationAdapter(adapter)
    unregisterAgain()
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
