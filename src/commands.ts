import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

import type { DevHarnessRuntime } from './index.js'
import { AUTO_FIX_AUTHORIZATIONS, type AutoFixAuthorization } from './authorization.js'
import { SkillPreflightError, assertRequiredSkills } from './skills.js'
import {
  RunStateError,
  createRun,
  listRuns,
  loadRun,
  updateRun,
  validateResume,
  type RunState,
} from './state.js'

const KNOWN_COMMAND_ERRORS = new Set([
  'ACTIVE_RUN_EXISTS',
  'CONTEXT_MISMATCH',
  'CONTEXT_REQUIRED',
  'DEPENDENCY_MISMATCH',
  'HEAD_MISMATCH',
  'INVALID_RUN_ID',
  'RUN_EXISTS',
  'STATE_CORRUPT',
  'STATE_NOT_FOUND',
  'TERMINAL_RUN',
  'WORKTREE_MISMATCH',
])

export function registerCommands(ctx: Context, runtime: DevHarnessRuntime): void {
  ctx.commands.register({
    name: 'harness-run',
    description: 'Start a recoverable dev-harness run in this workspace.',
    input: { hint: '[fix-only|commit-each] [qa=<adapter-name>]' },
    handler: invocation => settleCommand(() => runtime.run(invocation)),
  })
  ctx.commands.register({
    name: 'harness-resume',
    description: 'Validate and resume a paused dev-harness run.',
    input: { hint: '<run-id>' },
    handler: invocation => settleCommand(() => runtime.resume(invocation)),
  })
  ctx.commands.register({
    name: 'harness-status',
    description: 'Show the current dev-harness run status.',
    input: { hint: '[run-id]' },
    handler: invocation => settleCommand(() => runtime.status(invocation)),
  })
}

export async function runCommand(
  ctx: Context,
  requiredSkills: readonly string[],
  invocation: CommandInvocation,
  advance?: (state: RunState, signal: AbortSignal) => Promise<RunState>,
): Promise<CommandResult> {
  const { authorization, qaPreference } = parseRunOptions(invocation.rawInput)
  const cwd = requireCwd(invocation)
  await assertRequiredSkills(ctx, {
    cwd,
    scope: invocation.agent,
    signal: invocation.signal,
    required: requiredSkills,
  })
  const state = await createRun({ cwd, authorization, qaPreference })
  const preflight = await updateRun({
    cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'PREFLIGHT'
    },
  })
  return success(advance === undefined ? preflight : await advance(preflight, invocation.signal))
}

export async function resumeCommand(
  ctx: Context,
  requiredSkills: readonly string[],
  invocation: CommandInvocation,
  advance?: (state: RunState, signal: AbortSignal) => Promise<RunState>,
): Promise<CommandResult> {
  const runId = requireOneArg(invocation.rawInput, 'harness-resume')
  const cwd = requireCwd(invocation)
  const state = await loadRun(cwd, runId)
  await validateResume(state, cwd)
  await assertRequiredSkills(ctx, {
    cwd,
    scope: invocation.agent,
    signal: invocation.signal,
    required: requiredSkills,
  })
  const resumed = state.status === 'RUNNING'
    ? state
    : await updateRun({
        cwd,
        runId,
        expectedRevision: state.revision,
        mutate(next) {
          next.status = 'RUNNING'
          delete next.blocker
        },
      })
  const final = advance !== undefined && ['PREFLIGHT', 'AUDIT', 'ROUTE', 'REMEDIATE', 'FULL_VERIFY', 'QA'].includes(resumed.phase)
    ? await advance(resumed, invocation.signal)
    : resumed
  return success(final)
}

export async function statusCommand(invocation: CommandInvocation): Promise<CommandResult> {
  const requested = optionalOneArg(invocation.rawInput, 'harness-status')
  const cwd = requireCwd(invocation)
  const state = requested === undefined
    ? selectCurrentRun(await listRuns(cwd))
    : await loadRun(cwd, requested)
  await validateResume(state, cwd)
  return success(state)
}

export async function cancelRun(cwd: string, runId: string): Promise<RunState> {
  const state = await loadRun(cwd, runId)
  if (state.status === 'CANCELLED') return state
  return await updateRun({
    cwd,
    runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.status = 'CANCELLED'
    },
  })
}

async function settleCommand(operation: () => Promise<CommandResult>): Promise<CommandResult> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof SkillPreflightError) {
      return { kind: 'error', text: `${error.code}: ${error.message}` }
    }
    if (error instanceof RunStateError && KNOWN_COMMAND_ERRORS.has(error.code)) {
      return { kind: 'error', text: `${error.code}: ${error.message}` }
    }
    if (error instanceof CommandInputError) {
      return { kind: 'error', text: error.message }
    }
    throw error
  }
}

function requireCwd(invocation: CommandInvocation): string {
  const cwd = invocation.agent.session.header.cwd
  if (cwd === undefined) throw new CommandInputError('the current session has no workspace cwd')
  return cwd
}

function parseRunOptions(rawInput: string): { authorization: AutoFixAuthorization; qaPreference?: string } {
  let authorization: AutoFixAuthorization = 'fix-only'
  let authorizationSeen = false
  let qaPreference: string | undefined
  for (const field of rawInput.trim().split(/\s+/u).filter(Boolean)) {
    if ((AUTO_FIX_AUTHORIZATIONS as readonly string[]).includes(field)) {
      if (authorizationSeen) throw new CommandInputError('/harness-run accepts one authorization mode')
      authorization = field as AutoFixAuthorization
      authorizationSeen = true
      continue
    }
    if (field.startsWith('qa=')) {
      const name = field.slice(3)
      if (qaPreference !== undefined) throw new CommandInputError('/harness-run accepts one QA Adapter preference')
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
        throw new CommandInputError('/harness-run qa must be a lowercase Adapter name')
      }
      qaPreference = name
      continue
    }
    throw new CommandInputError('/harness-run accepts fix-only or commit-each and an optional qa=<adapter-name>')
  }
  return { authorization, ...(qaPreference === undefined ? {} : { qaPreference }) }
}

function requireOneArg(rawInput: string, command: string): string {
  const value = optionalOneArg(rawInput, command)
  if (value === undefined) throw new CommandInputError(`/${command} requires a run id`)
  return value
}

function optionalOneArg(rawInput: string, command: string): string | undefined {
  const fields = rawInput.trim().split(/\s+/u).filter(Boolean)
  if (fields.length > 1) throw new CommandInputError(`/${command} accepts at most one run id`)
  return fields[0]
}

function selectCurrentRun(states: readonly RunState[]): RunState {
  if (states.length === 0) throw new CommandInputError('no dev-harness run exists in this worktree')
  const active = states.filter(state => !['FAILED', 'DONE', 'DONE_WITH_CONCERNS', 'CANCELLED'].includes(state.status))
  if (active.length === 1) return active[0]!
  if (active.length > 1) throw new RunStateError('STATE_CORRUPT', 'multiple active runs exist')
  return [...states].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
}

function success(state: RunState): CommandResult {
  return {
    kind: 'success',
    text: JSON.stringify({
      runId: state.runId,
      revision: state.revision,
      phase: state.phase,
      status: state.status,
      authorization: state.authorization,
    }),
  }
}

class CommandInputError extends Error {}
