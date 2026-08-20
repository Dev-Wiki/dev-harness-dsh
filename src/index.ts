import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

export * from './state.js'

export const name = 'dev-harness-dsh'
export const inject = ['commands', 'skills']

export const Config = z.object({
  requiredSkills: z.array(z.string()).default([
    'dev-harness-codebase-audit',
    'dev-harness-auto-fix',
    'dev-harness-git-workflow',
    'dev-harness-commands',
  ]),
})

export interface Config {
  requiredSkills?: string[]
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
    this.requiredSkills = Object.freeze([...(config.requiredSkills ?? [])])
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new DevHarnessRuntime(ctx, config)
}
