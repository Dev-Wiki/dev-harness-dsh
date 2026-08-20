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
