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
    requiredSkills: ['dev-harness-codebase-audit'],
  })

  try {
    assert.equal(ctx.devHarness instanceof Plugin.DevHarnessRuntime, true)
    assert.deepEqual(ctx.devHarness.requiredSkills, ['dev-harness-codebase-audit'])
    assert.equal(Object.isFrozen(ctx.devHarness.requiredSkills), true)
  } finally {
    await fiber.dispose()
    assert.equal(ctx.get('devHarness'), undefined)
    await ctx.fiber.dispose()
  }
})
