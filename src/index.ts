import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'

import { registerCommands, resumeCommand, runCommand, statusCommand } from './commands.js'
import { advanceAuditRun, advanceRemediationRun } from './orchestrator.js'
import type { AuditAdapter } from './audit.js'
import type { AutoFixAdapter } from './autofix.js'

export * from './commands.js'
export * from './audit.js'
export * from './autofix.js'
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
  private autoFixAdapter?: AutoFixAdapter

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
    const autoFixAdapter = this.autoFixAdapter
    return resumeCommand(
      this.ctx,
      this.requiredSkills,
      invocation,
      adapter === undefined && autoFixAdapter === undefined
        ? undefined
        : (state, signal) => {
            if (['PREFLIGHT', 'AUDIT'].includes(state.phase)) {
              if (adapter === undefined) return Promise.resolve(state)
              return advanceAuditRun({
                cwd: state.repo.worktreeRoot,
                runId: state.runId,
                signal,
                adapter,
              })
            }
            if (['ROUTE', 'REMEDIATE'].includes(state.phase)) {
              if (autoFixAdapter === undefined) return Promise.resolve(state)
              return advanceRemediationRun({
                cwd: state.repo.worktreeRoot,
                runId: state.runId,
                signal,
                adapter: autoFixAdapter,
              })
            }
            return Promise.resolve(state)
          },
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

  registerAutoFixAdapter(adapter: AutoFixAdapter): () => void {
    if (this.autoFixAdapter !== undefined) throw new Error('an Auto Fix Adapter is already registered')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(adapter.name)) throw new TypeError('invalid Auto Fix Adapter name')
    this.autoFixAdapter = adapter
    return () => {
      if (this.autoFixAdapter === adapter) this.autoFixAdapter = undefined
    }
  }

  advanceRemediation(cwd: string, runId: string, signal: AbortSignal) {
    if (this.autoFixAdapter === undefined) throw new Error('no Auto Fix Adapter is registered')
    return advanceRemediationRun({ cwd, runId, signal, adapter: this.autoFixAdapter })
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
