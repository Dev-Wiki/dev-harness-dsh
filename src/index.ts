import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

import { registerCommands, resumeCommand, runCommand, statusCommand } from './commands.js'

export * from './commands.js'
export * from './audit.js'
export * from './router.js'
export * from './skills.js'
export * from './state.js'

export const name = 'dev-harness-dsh'
export const inject = ['commands', 'skills']

export const Config = z.object({
  additionalRequiredSkills: z.array(z.string()).default([]),
})

export interface Config {
  additionalRequiredSkills?: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    devHarness: DevHarnessRuntime
  }
}

/** Plugin-owned orchestration service. K1 adds state and commands to this seam. */
export class DevHarnessRuntime extends Service {
  readonly requiredSkills: readonly string[]

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'devHarness')
    this.requiredSkills = mergeRequiredSkills(config.additionalRequiredSkills ?? [])
  }

  run(invocation: import('@deepseek-ai/dsh-commands').CommandInvocation) {
    return runCommand(this.ctx, this.requiredSkills, invocation)
  }

  resume(invocation: import('@deepseek-ai/dsh-commands').CommandInvocation) {
    return resumeCommand(this.ctx, this.requiredSkills, invocation)
  }

  status(invocation: import('@deepseek-ai/dsh-commands').CommandInvocation) {
    return statusCommand(invocation)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const runtime = new DevHarnessRuntime(ctx, config)
  registerCommands(ctx, runtime)
}

const CORE_REQUIRED_SKILLS = Object.freeze([
  'dev-harness-codebase-audit',
  'dev-harness-auto-fix',
  'dev-harness-git-workflow',
  'dev-harness-commands',
])

function mergeRequiredSkills(additional: readonly string[]): readonly string[] {
  const names = new Set(CORE_REQUIRED_SKILLS)
  for (const name of additional) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      throw new TypeError(`invalid required Skill name: ${name}`)
    }
    names.add(name)
  }
  return Object.freeze([...names].sort())
}
