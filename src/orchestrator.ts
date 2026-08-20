import { lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  AuditContractError,
  validateAuditObservation,
  type AuditAdapter,
  type AuditObservation,
} from './audit.js'
import { routeAuditFindings } from './router.js'
import {
  AutoFixContractError,
  validateAutoFixObservation,
  type AutoFixAdapter,
  type AutoFixObservation,
} from './autofix.js'
import { autoFixExecutionMode } from './authorization.js'
import {
  adoptCommitBoundary,
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

export async function advanceRemediationRun(options: {
  readonly cwd: string
  readonly runId: string
  readonly adapter: AutoFixAdapter
  readonly signal: AbortSignal
}): Promise<RunState> {
  throwIfAborted(options.signal)
  let state = await loadRun(options.cwd, options.runId)
  if (!['ROUTE', 'REMEDIATE'].includes(state.phase)) {
    throw new OrchestratorError(`Remediation cannot advance from phase ${state.phase}`)
  }
  if (['PAUSED', 'BLOCKED', 'NEEDS_USER'].includes(state.status)) {
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.status = 'RUNNING'
        delete next.blocker
      },
    })
  }
  if (['FAILED', 'CANCELLED', 'DONE', 'DONE_WITH_CONCERNS'].includes(state.status)) {
    throw new OrchestratorError(`Remediation cannot advance a ${state.status} run`)
  }
  const finding = nextAutoFixFinding(state)
  if (finding === undefined) {
    if (state.phase === 'REMEDIATE' && state.currentFinding === undefined) return state
    return await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = 'REMEDIATE'
        delete next.currentFinding
      },
    })
  }
  if (finding.handoffRef === undefined) {
    throw new OrchestratorError(`Auto Fix finding ${finding.findingId} has no handoff reference`)
  }
  if (
    state.auditRunId === undefined
    || state.auditResult === undefined
    || state.auditResult.status !== 'COMPLETED'
    || state.auditResult.executionStatus !== 'COMPLETED'
  ) {
    throw new OrchestratorError('Remediation requires a completed Audit checkpoint')
  }
  const auditRunId = state.auditRunId
  const auditResult = state.auditResult

  const previousRun = state.fixRuns.find(run => run.findingId === finding.findingId)
  let before: WorktreeBoundary
  if (state.autoFixLease === undefined) {
    await validateResume(state, options.cwd)
    before = await captureWorktreeBoundary(options.cwd)
    const autoFixRunId = previousRun?.autoFixRunId ?? stableAutoFixRunId(state.runId, finding.findingId)
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = 'REMEDIATE'
        next.currentFinding = finding.findingId
        next.autoFixLease = {
          findingId: finding.findingId,
          autoFixRunId,
          adapterName: options.adapter.name,
          handoffRef: finding.handoffRef!,
          beforeFingerprint: before.fingerprint,
          beforeChangedPaths: { ...before.changedPaths },
          status: 'OPEN',
        }
      },
    })
  } else {
    if (state.autoFixLease.adapterName !== options.adapter.name) {
      throw new OrchestratorError('open Auto Fix mutation lease belongs to another Adapter')
    }
    if (
      state.autoFixLease.findingId !== finding.findingId
      || state.autoFixLease.handoffRef !== finding.handoffRef
    ) {
      throw new OrchestratorError('open Auto Fix mutation lease belongs to another Finding')
    }
    before = {
      worktreeRoot: state.repo.worktreeRoot,
      fingerprint: state.autoFixLease.beforeFingerprint,
      changedPaths: state.autoFixLease.beforeChangedPaths,
    }
  }

  const lease = state.autoFixLease
  if (lease === undefined) throw new OrchestratorError('Auto Fix mutation lease was not persisted')
  const checkpoint = state.autoFixCheckpoint?.findingId === finding.findingId
    ? state.autoFixCheckpoint
    : undefined
  const currentRun = state.fixRuns.find(run => run.findingId === finding.findingId)
  const workspaceBaseFingerprint = currentRun?.workspaceBaseFingerprint ?? lease.beforeFingerprint
  const request = {
    cwd: state.repo.worktreeRoot,
    orchestrationRunId: state.runId,
    autoFixRunId: lease.autoFixRunId,
    findingId: finding.findingId,
    handoffRef: finding.handoffRef,
    auditRunId,
    auditSnapshotRef: auditResult.snapshotRef,
    findingRegistryRef: auditResult.registryRef,
    mode: autoFixExecutionMode(state.authorization),
    expectedHead: state.repo.head,
    expectedBranch: state.repo.branch,
    expectedCurrentWorkspaceFingerprint: lease.beforeFingerprint,
    expectedWorkspaceBaseFingerprint: workspaceBaseFingerprint,
    signal: options.signal,
  }
  throwIfAborted(options.signal)
  const rawObservation = currentRun === undefined
    ? await options.adapter.start(request)
    : await options.adapter.resume({
        ...request,
        expectedRevision: currentRun.observationRevision,
        expectedWorkspaceSnapshotRef: currentRun.workspaceSnapshotRef,
      })
  throwIfAborted(options.signal)
  const observation = validateAutoFixObservation(rawObservation, {
    runId: lease.autoFixRunId,
    findingId: finding.findingId,
    handoffRef: finding.handoffRef,
    auditRunId,
    auditSnapshotRef: auditResult.snapshotRef,
    findingRegistryRef: auditResult.registryRef,
    repositoryRoot: state.repo.worktreeRoot,
    baseSha: state.repo.head,
    branch: state.repo.branch,
    workspaceFingerprint: workspaceBaseFingerprint,
    mode: request.mode,
  })
  assertMonotonicAutoFixObservation(currentRun, observation)

  const after = await captureWorktreeBoundary(options.cwd)
  const changedPaths = diffWorktreeBoundaries(before, after)
  const baseChangedPaths = checkpoint?.baseChangedPaths ?? lease.beforeChangedPaths
  if (observation.mode === 'commit' && observation.executionStatus === 'COMPLETED') {
    const commit = observation.commits[0]!
    assertCommittedAutoFixWorkspace(after, baseChangedPaths, observation)
    return await adoptCommitBoundary({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      before,
      boundary: after,
      commit: {
        sha: commit.sha,
        parentSha: commit.parentSha,
        autoFixRunId: observation.runId,
        changedFiles: [...commit.changedFiles],
        reviewDiffHash: commit.reviewDiffHash,
        evidenceRef: commit.commitEvidenceRef,
      },
      mutate(next) {
        applyAutoFixObservation(next, finding.findingId, observation, baseChangedPaths, before, after)
      },
    })
  }
  assertAutoFixWorkspace(
    before,
    after,
    changedPaths,
    baseChangedPaths,
    checkpoint?.outputs ?? [],
    observation,
  )
  state = await adoptWorktreeBoundary({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    before,
    boundary: after,
    acceptedPaths: changedPaths,
  })

  return await updateRun({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      applyAutoFixObservation(next, finding.findingId, observation, baseChangedPaths, before, after)
    },
  })
}

function applyAutoFixObservation(
  next: RunState,
  findingId: string,
  observation: AutoFixObservation,
  baseChangedPaths: Readonly<Record<string, string>>,
  before: WorktreeBoundary,
  after: WorktreeBoundary,
): void {
  const status = observation.completionStatus ?? observation.executionStatus
  const reference = {
    findingId,
    autoFixRunId: observation.runId,
    status,
    observationRevision: observation.revision,
    stateDigest: observation.stateDigest,
    executionRef: observation.executionRef,
    workspaceSnapshotRef: observation.workspaceSnapshotRef,
    workspaceBaseFingerprint: observation.workspaceBaseFingerprint,
    ...(observation.finalVerificationRef === undefined
      ? {}
      : { finalVerificationRef: observation.finalVerificationRef }),
    ...(observation.reviewDiffHash === undefined
      ? {}
      : { reviewDiffHash: observation.reviewDiffHash }),
    ...(observation.residualRiskRef === undefined
      ? {}
      : { residualRiskRef: observation.residualRiskRef }),
  }
  const runIndex = next.fixRuns.findIndex(run => run.findingId === findingId)
  if (runIndex === -1) next.fixRuns.push(reference)
  else next.fixRuns[runIndex] = reference
  if (observation.commits.length === 1) {
    const commit = observation.commits[0]!
    if (next.commits.some(item => item.sha === commit.sha || item.autoFixRunId === observation.runId)) {
      throw new AutoFixContractError('Auto Fix commit was already recorded')
    }
    next.commits.push({
      sha: commit.sha,
      parentSha: commit.parentSha,
      autoFixRunId: observation.runId,
      changedFiles: [...commit.changedFiles],
      reviewDiffHash: commit.reviewDiffHash,
      evidenceRef: commit.commitEvidenceRef,
    })
  }
  next.autoFixCheckpoint = {
    findingId,
    autoFixRunId: observation.runId,
    observationRevision: observation.revision,
    stateDigest: observation.stateDigest,
    workspaceSnapshotRef: observation.workspaceSnapshotRef,
    baseChangedPaths: { ...baseChangedPaths },
    previousFingerprint: before.fingerprint,
    acceptedFingerprint: after.fingerprint,
    outputs: observation.changeOutputs.map(output => ({ ...output })),
  }
  delete next.autoFixLease
  delete next.blocker
  if (observation.executionStatus === 'RUNNING') {
    next.status = 'PAUSED'
    next.currentFinding = findingId
  } else if (observation.executionStatus === 'BLOCKED') {
    next.status = 'BLOCKED'
    next.currentFinding = findingId
    next.blocker = { code: 'AUTO_FIX_BLOCKED', message: observation.blockerRef! }
  } else if (observation.executionStatus === 'NEEDS_CONTEXT') {
    next.status = 'NEEDS_USER'
    next.currentFinding = findingId
    next.blocker = { code: 'AUTO_FIX_NEEDS_CONTEXT', message: observation.blockerRef! }
  } else if (observation.executionStatus === 'FAILED') {
    next.status = 'FAILED'
    next.currentFinding = findingId
    next.blocker = { code: 'AUTO_FIX_FAILED', message: observation.executionRef }
  } else if (observation.executionStatus === 'CANCELLED') {
    next.status = 'CANCELLED'
    next.currentFinding = findingId
  } else {
    next.status = 'RUNNING'
    const remaining = next.findings.find(candidate =>
      candidate.status === 'confirmed'
      && candidate.route === 'auto-fix'
      && !next.fixRuns.some(run =>
        run.findingId === candidate.findingId
        && ['DONE', 'DONE_WITH_CONCERNS'].includes(run.status)))
    if (remaining === undefined) delete next.currentFinding
    else next.currentFinding = remaining.findingId
  }
}

function nextAutoFixFinding(state: RunState) {
  const pending = state.findings.filter(finding =>
    finding.status === 'confirmed'
    && finding.route === 'auto-fix'
    && !state.fixRuns.some(run =>
      run.findingId === finding.findingId
      && ['DONE', 'DONE_WITH_CONCERNS'].includes(run.status)))
  return pending.find(finding => finding.findingId === state.currentFinding) ?? pending[0]
}

function stableAutoFixRunId(orchestrationRunId: string, findingId: string): string {
  const suffix = createHash('sha256').update(`${orchestrationRunId}\0${findingId}`).digest('hex').slice(0, 16)
  return `fix-${suffix}`
}

function assertMonotonicAutoFixObservation(
  previous: RunState['fixRuns'][number] | undefined,
  observation: AutoFixObservation,
): void {
  if (previous === undefined) return
  if (observation.runId !== previous.autoFixRunId) {
    throw new AutoFixContractError('Auto Fix Adapter changed run identity')
  }
  if (observation.revision < previous.observationRevision) {
    throw new AutoFixContractError('Auto Fix Adapter revision moved backwards')
  }
  if (
    observation.revision === previous.observationRevision
    && observation.stateDigest !== previous.stateDigest
  ) {
    throw new AutoFixContractError('Auto Fix Adapter changed state at the same revision')
  }
  if (
    observation.revision === previous.observationRevision
    && (observation.completionStatus ?? observation.executionStatus) !== previous.status
  ) {
    throw new AutoFixContractError('Auto Fix Adapter changed status at the same revision')
  }
  if (observation.workspaceSnapshotRef !== previous.workspaceSnapshotRef) {
    throw new AutoFixContractError('Auto Fix Adapter changed workspace snapshot during resume')
  }
}

function assertAutoFixWorkspace(
  before: WorktreeBoundary,
  after: WorktreeBoundary,
  changedPaths: readonly string[],
  baseChangedPaths: Readonly<Record<string, string>>,
  previousOutputs: readonly { path: string; fingerprint: string }[],
  observation: AutoFixObservation,
): void {
  const outputMap = new Map(observation.changeOutputs.map(output => [output.path, output.fingerprint]))
  for (const path of changedPaths) {
    if (outputMap.get(path) !== after.changedPaths[path]) {
      throw new AutoFixContractError(`Auto Fix mutated an undeclared path: ${path}`)
    }
  }
  for (const [path, fingerprint] of outputMap) {
    if (baseChangedPaths[path] !== undefined) {
      throw new AutoFixContractError(`Auto Fix claimed a preexisting changed path: ${path}`)
    }
    if (after.changedPaths[path] !== fingerprint) {
      throw new AutoFixContractError(`Auto Fix output fingerprint mismatch: ${path}`)
    }
  }
  for (const previous of previousOutputs) {
    if (outputMap.get(previous.path) !== after.changedPaths[previous.path]) {
      throw new AutoFixContractError(`Auto Fix dropped ownership of a prior output: ${previous.path}`)
    }
  }
  for (const [path, fingerprint] of Object.entries(baseChangedPaths)) {
    if (after.changedPaths[path] !== fingerprint) {
      throw new AutoFixContractError(`Auto Fix altered a preexisting changed path: ${path}`)
    }
  }
  if (before.fingerprint === after.fingerprint && changedPaths.length > 0) {
    throw new AutoFixContractError('Auto Fix mutation boundary is internally inconsistent')
  }
}

function assertCommittedAutoFixWorkspace(
  after: WorktreeBoundary,
  baseChangedPaths: Readonly<Record<string, string>>,
  observation: AutoFixObservation,
): void {
  if (observation.postCommitWorkspaceFingerprint !== after.fingerprint) {
    throw new AutoFixContractError('post-commit workspace fingerprint does not match Git')
  }
  const afterPaths = Object.keys(after.changedPaths).sort()
  const basePaths = Object.keys(baseChangedPaths).sort()
  if (JSON.stringify(afterPaths) !== JSON.stringify(basePaths)) {
    throw new AutoFixContractError('commit mode left uncommitted Auto Fix changes or altered dirty-file scope')
  }
  for (const [path, fingerprint] of Object.entries(baseChangedPaths)) {
    if (after.changedPaths[path] !== fingerprint) {
      throw new AutoFixContractError(`commit mode altered a preexisting changed path: ${path}`)
    }
  }
  for (const path of observation.changedFiles) {
    if (baseChangedPaths[path] !== undefined) {
      throw new AutoFixContractError(`commit mode included a preexisting changed path: ${path}`)
    }
  }
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
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'orchestration aborted')
}
