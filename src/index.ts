import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

import { registerCommands, resumeCommand, runCommand, statusCommand } from './commands.js'
import { advanceAuditRun } from './orchestrator.js'
import type { AuditAdapter } from './audit.js'

export * from './commands.js'
export * from './audit.js'
export * from './router.js'
export * from './orchestrator.js'
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
  private auditAdapter?: AuditAdapter

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'devHarness')
    this.requiredSkills = mergeRequiredSkills(config.additionalRequiredSkills ?? [])
  }

  run(invocation: import('@deepseek-ai/dsh-commands').CommandInvocation) {
    const adapter = this.auditAdapter
    return runCommand(
      this.ctx,
      this.requiredSkills,
      invocation,
      adapter === undefined
        ? undefined
        : (state, signal) => advanceAuditRun({
            cwd: state.repo.worktreeRoot,
            runId: state.runId,
            signal,
            adapter,
          }),
    )
  }

  resume(invocation: import('@deepseek-ai/dsh-commands').CommandInvocation) {
    const adapter = this.auditAdapter
    return resumeCommand(
      this.ctx,
      this.requiredSkills,
      invocation,
      adapter === undefined
        ? undefined
        : (state, signal) => advanceAuditRun({
            cwd: state.repo.worktreeRoot,
            runId: state.runId,
            signal,
            adapter,
          }),
    )
  }

  status(invocation: import('@deepseek-ai/dsh-commands').CommandInvocation) {
    return statusCommand(invocation)
  }

  registerAuditAdapter(adapter: AuditAdapter): () => void {
    if (this.auditAdapter !== undefined) throw new Error('an Audit Adapter is already registered')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(adapter.name)) throw new TypeError('invalid Audit Adapter name')
    this.auditAdapter = adapter
    return () => {
      if (this.auditAdapter === adapter) this.auditAdapter = undefined
    }
  }

  advanceAudit(cwd: string, runId: string, signal: AbortSignal) {
    if (this.auditAdapter === undefined) throw new Error('no Audit Adapter is registered')
    return advanceAuditRun({ cwd, runId, signal, adapter: this.auditAdapter })
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
