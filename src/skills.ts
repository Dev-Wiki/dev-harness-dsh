import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

export type SkillPreflightErrorCode = 'SKILL_CATALOG_INCOMPLETE' | 'REQUIRED_SKILLS_MISSING'

export class SkillPreflightError extends Error {
  readonly code: SkillPreflightErrorCode
  readonly missing: readonly string[]

  constructor(code: SkillPreflightErrorCode, message: string, missing: readonly string[] = []) {
    super(message)
    this.name = 'SkillPreflightError'
    this.code = code
    this.missing = Object.freeze([...missing])
  }
}

export interface SkillPreflightResult {
  readonly available: readonly string[]
  readonly required: readonly string[]
}

export async function assertRequiredSkills(
  ctx: Context,
  options: {
    readonly cwd: string
    readonly scope: CommandInvocation['agent']
    readonly signal: AbortSignal
    readonly required: readonly string[]
  },
): Promise<SkillPreflightResult> {
  throwIfAborted(options.signal)
  const snapshot = await ctx.skills.snapshot({
    cwd: options.cwd,
    scope: options.scope,
    signal: options.signal,
  })
  throwIfAborted(options.signal)
  if (!snapshot.complete) {
    throw new SkillPreflightError(
      'SKILL_CATALOG_INCOMPLETE',
      'Skill catalog discovery is incomplete; refusing to continue',
    )
  }
  const available = Object.freeze(snapshot.skills.map(skill => skill.name).sort())
  const availableSet = new Set(available)
  const missing = Object.freeze(options.required.filter(name => !availableSet.has(name)).sort())
  if (missing.length > 0) {
    throw new SkillPreflightError(
      'REQUIRED_SKILLS_MISSING',
      `required Skills are unavailable: ${missing.join(', ')}`,
      missing,
    )
  }
  return {
    available,
    required: Object.freeze([...options.required]),
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'operation aborted')
}
