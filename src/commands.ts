import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

import type { DevHarnessRuntime } from './index.js'
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
): Promise<CommandResult> {
  requireNoArgs(invocation.rawInput, 'harness-run')
  const cwd = requireCwd(invocation)
  await assertRequiredSkills(ctx, {
    cwd,
    scope: invocation.agent,
    signal: invocation.signal,
    required: requiredSkills,
  })
  const state = await createRun({ cwd })
  const preflight = await updateRun({
    cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'PREFLIGHT'
    },
  })
  return success(preflight)
}

export async function resumeCommand(
  ctx: Context,
  requiredSkills: readonly string[],
  invocation: CommandInvocation,
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
  if (state.status === 'RUNNING') return success(state)
  const resumed = await updateRun({
    cwd,
    runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.status = 'RUNNING'
      delete next.blocker
    },
  })
  return success(resumed)
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

function requireNoArgs(rawInput: string, command: string): void {
  if (rawInput.trim() !== '') throw new CommandInputError(`/${command} does not accept arguments`)
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
    }),
  }
}

class CommandInputError extends Error {}
