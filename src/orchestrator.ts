import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AuditContractError,
  validateAuditObservation,
  type AuditAdapter,
  type AuditObservation,
} from './audit.js'
import { routeAuditFindings } from './router.js'
import {
  adoptWorktreeBoundary,
  captureWorktreeBoundary,
  diffWorktreeBoundaries,
  loadRun,
  updateRun,
  validateResume,
  type RunState,
  type WorktreeBoundary,
} from './state.js'

export class OrchestratorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OrchestratorError'
  }
}

export async function advanceAuditRun(options: {
  readonly cwd: string
  readonly runId: string
  readonly adapter: AuditAdapter
  readonly signal: AbortSignal
}): Promise<RunState> {
  throwIfAborted(options.signal)
  let state = await loadRun(options.cwd, options.runId)
  if (!['PREFLIGHT', 'AUDIT'].includes(state.phase)) {
    throw new OrchestratorError(`Audit cannot advance from phase ${state.phase}`)
  }

  let before: WorktreeBoundary
  if (state.auditLease === undefined) {
    await validateResume(state, options.cwd)
    before = await captureWorktreeBoundary(options.cwd)
    const auditRunId = state.auditRunId ?? `audit-${state.runId}`
    const allowedRoot = await resolveAuditRoot(state.repo.worktreeRoot)
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.auditRunId = auditRunId
        next.auditLease = {
          auditRunId,
          adapterName: options.adapter.name,
          allowedRoot,
          beforeFingerprint: before.fingerprint,
          beforeChangedPaths: { ...before.changedPaths },
          status: 'OPEN',
        }
      },
    })
  } else {
    if (state.auditLease.adapterName !== options.adapter.name) {
      throw new OrchestratorError('open Audit mutation lease belongs to another Adapter')
    }
    before = {
      worktreeRoot: state.repo.worktreeRoot,
      fingerprint: state.auditLease.beforeFingerprint,
      changedPaths: state.auditLease.beforeChangedPaths,
    }
  }

  const lease = state.auditLease
  if (lease === undefined) throw new OrchestratorError('Audit mutation lease was not persisted')
  const request = {
    cwd: state.repo.worktreeRoot,
    orchestrationRunId: state.runId,
    auditRunId: lease.auditRunId,
    expectedHead: state.repo.head,
    expectedBranch: state.repo.branch,
    contextFingerprint: state.contextFingerprint,
    scope: Object.freeze(['repository']),
    signal: options.signal,
  }
  throwIfAborted(options.signal)
  const rawObservation = state.auditResult === undefined
    ? await options.adapter.start(request)
    : await options.adapter.resume({
        ...request,
        expectedRevision: state.auditResult.revision,
        expectedSnapshotRef: state.auditResult.snapshotRef,
      })
  throwIfAborted(options.signal)
  const observation = validateAuditObservation(rawObservation, {
    runId: lease.auditRunId,
    repositoryRoot: state.repo.worktreeRoot,
    head: state.repo.head,
    branch: state.repo.branch,
    contextFingerprint: state.contextFingerprint,
  })
  assertMonotonicObservation(state, observation)

  await assertAuditRootDirectory(state.repo.worktreeRoot, lease.allowedRoot)
  const after = await captureWorktreeBoundary(options.cwd)
  const changedPaths = diffWorktreeBoundaries(before, after)
  assertAuditWorkspace(lease.allowedRoot, before, after, changedPaths, observation)
  state = await adoptWorktreeBoundary({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    before,
    boundary: after,
    acceptedPaths: changedPaths,
  })

  state = await updateRun({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'AUDIT'
      next.auditRunId = observation.runId
      next.auditResult = {
        status: observation.status,
        executionStatus: observation.executionStatus,
        revision: observation.revision,
        snapshotRef: observation.snapshotRef,
        registryRef: observation.registryRef,
        reportRef: observation.reportRef,
        crossModuleStatus: observation.crossModuleStatus,
      }
      next.auditCheckpoint = {
        auditRunId: observation.runId,
        adapterRevision: observation.revision,
        snapshotRef: observation.snapshotRef,
        previousFingerprint: before.fingerprint,
        acceptedFingerprint: after.fingerprint,
        outputs: observation.auditOutputs.map(output => ({ ...output })),
      }
      delete next.auditLease
      delete next.blocker
      if (observation.status === 'STALE' || observation.needsReverification) {
        next.status = 'BLOCKED'
        next.blocker = { code: 'AUDIT_STALE', message: 'Audit snapshot requires reverification' }
      } else if (observation.executionStatus === 'BLOCKED') {
        next.status = 'BLOCKED'
        next.blocker = { code: 'AUDIT_BLOCKED', message: 'Audit completed with blocked tasks' }
      } else if (observation.executionStatus === 'FAILED') {
        next.status = 'FAILED'
        next.blocker = { code: 'AUDIT_FAILED', message: 'Audit execution failed' }
      } else if (observation.executionStatus === 'CANCELLED') {
        next.status = 'CANCELLED'
      } else if (observation.status === 'ACTIVE') {
        next.status = 'PAUSED'
      } else {
        next.status = 'RUNNING'
      }
    },
  })

  if (observation.status !== 'COMPLETED' || observation.executionStatus !== 'COMPLETED') return state
  const routed = routeAuditFindings(observation)
  return await updateRun({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'ROUTE'
      next.findings = routed.findings.map(finding => ({ ...finding }))
      next.currentFinding = routed.confirmedDefects[0]?.findingId
    },
  })
}

function assertMonotonicObservation(state: RunState, observation: AuditObservation): void {
  if (state.auditRunId !== undefined && observation.runId !== state.auditRunId) {
    throw new AuditContractError('Audit Adapter changed run identity')
  }
  if (state.auditResult !== undefined) {
    if (observation.revision < state.auditResult.revision) {
      throw new AuditContractError('Audit Adapter revision moved backwards')
    }
    if (observation.snapshotRef !== state.auditResult.snapshotRef) {
      throw new AuditContractError('Audit Adapter changed snapshot identity during resume')
    }
  }
}

function assertAuditWorkspace(
  allowedRoot: string,
  before: WorktreeBoundary,
  after: WorktreeBoundary,
  changedPaths: readonly string[],
  observation: AuditObservation,
): void {
  if (observation.auditOutputRoot !== allowedRoot) {
    throw new AuditContractError('Audit output root does not match the mutation lease')
  }
  for (const path of changedPaths) {
    if (!path.startsWith(`${allowedRoot}/`)) {
      throw new AuditContractError(`Audit mutated a path outside its output root: ${path}`)
    }
  }
  const outputMap = new Map(observation.auditOutputs.map(output => [output.path, output.fingerprint]))
  for (const path of changedPaths) {
    if (outputMap.get(path) !== after.changedPaths[path]) {
      throw new AuditContractError(`Audit output fingerprint mismatch: ${path}`)
    }
  }
  for (const [path, fingerprint] of outputMap) {
    if (after.changedPaths[path] !== fingerprint) {
      throw new AuditContractError(`Audit Adapter reported a non-current output: ${path}`)
    }
  }
  const businessDirtyFiles = Object.keys(after.changedPaths)
    .filter(path => !path.startsWith(`${allowedRoot}/`))
    .sort()
  if (JSON.stringify(businessDirtyFiles) !== JSON.stringify([...observation.businessDirtyFiles].sort())) {
    throw new AuditContractError('Audit business dirty-file observation does not match the worktree')
  }
  if (before.fingerprint === after.fingerprint && changedPaths.length > 0) {
    throw new AuditContractError('Audit mutation boundary is internally inconsistent')
  }
}

async function resolveAuditRoot(worktreeRoot: string): Promise<string> {
  const candidates: string[] = []
  for (const name of ['docs', 'doc']) {
    try {
      const info = await lstat(join(worktreeRoot, name))
      if (info.isDirectory() && !info.isSymbolicLink()) candidates.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (candidates.length !== 1) {
    throw new OrchestratorError('repository must have exactly one canonical doc or docs root')
  }
  return `${candidates[0]}/audit`
}

async function assertAuditRootDirectory(worktreeRoot: string, auditRoot: string): Promise<void> {
  const info = await lstat(join(worktreeRoot, auditRoot))
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new AuditContractError('Audit output root must be a real directory')
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'Audit orchestration aborted')
}
