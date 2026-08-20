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
  type AutoFixSource,
} from './autofix.js'
import { autoFixExecutionMode } from './authorization.js'
import {
  QaContractError,
  selectQaAdapter,
  validateQaObservation,
  type QaAdapter,
  type QaObservation,
} from './qa/index.js'
import {
  FinalReconciliationContractError,
  validateFinalReconciliationObservation,
  type FinalReconciliationAdapter,
  type FinalReconciliationObservation,
} from './reconciliation.js'
import { assertRunSummaryMatchesState, createRunSummary } from './report.js'
import {
  FULL_VERIFICATION_COMMAND,
  FullVerificationContractError,
  validateFullVerificationObservation,
  type FullVerificationAdapter,
  type FullVerificationObservation,
} from './verification.js'
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
  const source = autoFixSource(state, finding.findingId, finding.handoffRef)

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
        const qaFinding = next.qa.findings.find(candidate => candidate.findingId === finding.findingId)
        if (qaFinding !== undefined) qaFinding.status = 'IN_REMEDIATION'
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
    source,
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
    source: request.source,
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

export async function advanceFullVerification(options: {
  readonly cwd: string
  readonly runId: string
  readonly adapter: FullVerificationAdapter
  readonly signal: AbortSignal
}): Promise<RunState> {
  throwIfAborted(options.signal)
  let state = await loadRun(options.cwd, options.runId)
  if (!['REMEDIATE', 'FULL_VERIFY'].includes(state.phase)) {
    throw new OrchestratorError(`Full Verification cannot advance from phase ${state.phase}`)
  }
  if (nextAutoFixFinding(state) !== undefined) {
    throw new OrchestratorError('Full Verification cannot start while Auto Fix findings remain')
  }
  if (
    state.phase === 'FULL_VERIFY'
    && state.status === 'RUNNING'
    && state.fullVerification?.status === 'PASS'
  ) return state
  if (['PAUSED', 'BLOCKED'].includes(state.status)) {
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
    throw new OrchestratorError(`Full Verification cannot advance a ${state.status} run`)
  }

  let before: WorktreeBoundary
  if (state.fullVerificationLease === undefined) {
    await validateResume(state, options.cwd)
    before = await captureWorktreeBoundary(options.cwd)
    const verificationRunId = state.fullVerification?.verificationRunId
      ?? stableVerificationRunId(state.runId, state.verificationCycle)
    const snapshotRef = state.fullVerification?.snapshotRef
      ?? stableVerificationSnapshot(state.repo.head, before.fingerprint)
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = 'FULL_VERIFY'
        next.fullVerificationLease = {
          verificationRunId,
          adapterName: options.adapter.name,
          snapshotRef,
          beforeFingerprint: before.fingerprint,
          beforeChangedPaths: { ...before.changedPaths },
          status: 'OPEN',
        }
      },
    })
  } else {
    if (state.fullVerificationLease.adapterName !== options.adapter.name) {
      throw new OrchestratorError('open Full Verification lease belongs to another Adapter')
    }
    before = {
      worktreeRoot: state.repo.worktreeRoot,
      fingerprint: state.fullVerificationLease.beforeFingerprint,
      changedPaths: state.fullVerificationLease.beforeChangedPaths,
    }
    assertReadOnlyVerificationWorkspace(before, await captureWorktreeBoundary(options.cwd))
  }

  const lease = state.fullVerificationLease
  if (lease === undefined) throw new OrchestratorError('Full Verification lease was not persisted')
  const request = {
    cwd: state.repo.worktreeRoot,
    orchestrationRunId: state.runId,
    verificationRunId: lease.verificationRunId,
    command: FULL_VERIFICATION_COMMAND,
    expectedHead: state.repo.head,
    expectedBranch: state.repo.branch,
    expectedWorkspaceFingerprint: lease.beforeFingerprint,
    expectedSnapshotRef: lease.snapshotRef,
    signal: options.signal,
  }
  throwIfAborted(options.signal)
  const rawObservation = state.fullVerification === undefined
    ? await options.adapter.start(request)
    : await options.adapter.resume({
        ...request,
        expectedRevision: state.fullVerification.revision,
        expectedRunRef: state.fullVerification.runRef,
      })
  throwIfAborted(options.signal)
  const observation = validateFullVerificationObservation(rawObservation, {
    runId: lease.verificationRunId,
    repositoryRoot: state.repo.worktreeRoot,
    head: state.repo.head,
    branch: state.repo.branch,
    workspaceFingerprint: lease.beforeFingerprint,
    snapshotRef: lease.snapshotRef,
  })
  assertMonotonicVerification(state, observation)
  const after = await captureWorktreeBoundary(options.cwd)
  assertReadOnlyVerificationWorkspace(before, after)
  await validateResume(state, options.cwd)

  return await updateRun({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'FULL_VERIFY'
      next.fullVerification = {
        verificationRunId: observation.runId,
        executionStatus: observation.executionStatus,
        ...(observation.resultStatus === undefined ? {} : { status: observation.resultStatus }),
        revision: observation.revision,
        command: observation.command,
        runRef: observation.runRef,
        snapshotRef: observation.snapshotRef,
        workspaceFingerprint: observation.workspaceFingerprint,
        ...(observation.evidenceRef === undefined ? {} : { evidenceRef: observation.evidenceRef }),
      }
      delete next.fullVerificationLease
      delete next.blocker
      if (observation.executionStatus === 'RUNNING') {
        next.status = 'PAUSED'
      } else if (observation.executionStatus === 'CANCELLED') {
        next.status = 'CANCELLED'
      } else if (observation.executionStatus === 'FAILED') {
        next.status = 'FAILED'
        next.blocker = { code: 'FULL_VERIFICATION_EXECUTION_FAILED', message: observation.evidenceRef! }
      } else if (observation.resultStatus === 'PASS') {
        next.status = 'RUNNING'
      } else if (observation.resultStatus === 'FAIL') {
        next.status = 'FAILED'
        next.blocker = { code: 'FULL_VERIFICATION_FAILED', message: observation.evidenceRef! }
      } else if (observation.resultStatus === 'ENTRY_MISSING') {
        next.status = 'BLOCKED'
        next.blocker = { code: 'FULL_VERIFICATION_ENTRY_MISSING', message: observation.evidenceRef! }
      } else {
        next.status = 'BLOCKED'
        next.blocker = { code: 'FULL_VERIFICATION_ENVIRONMENT_UNAVAILABLE', message: observation.evidenceRef! }
      }
    },
  })
}

export async function advanceQaRun(options: {
  readonly cwd: string
  readonly runId: string
  readonly adapters: readonly QaAdapter[]
  readonly signal: AbortSignal
}): Promise<RunState> {
  throwIfAborted(options.signal)
  let state = await loadRun(options.cwd, options.runId)
  if (!['FULL_VERIFY', 'QA'].includes(state.phase)) {
    throw new OrchestratorError(`QA cannot advance from phase ${state.phase}`)
  }
  const verification = state.fullVerification
  if (
    verification?.executionStatus !== 'COMPLETED'
    || verification.status !== 'PASS'
    || verification.workspaceFingerprint !== state.repo.worktreeFingerprint
  ) {
    throw new OrchestratorError('QA requires a current Full Verification PASS checkpoint')
  }
  const latestRun = state.qa.runs.find(run => run.attempt === state.qa.currentAttempt)
  if (state.phase === 'QA' && latestRun?.resultStatus === 'PASS') return state
  if (state.phase === 'QA' && latestRun?.resultStatus === 'MANUAL_REQUIRED') {
    if (state.status === 'NEEDS_USER') return state
    return await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.status = 'NEEDS_USER'
        next.blocker = { code: 'QA_MANUAL_REQUIRED', message: latestRun.evidenceRef! }
      },
    })
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
    throw new OrchestratorError(`QA cannot advance a ${state.status} run`)
  }

  let before: WorktreeBoundary
  if (state.qaLease === undefined) {
    await validateResume(state, options.cwd)
    before = await captureWorktreeBoundary(options.cwd)
    const resumable = latestRun?.executionStatus === 'RUNNING' ? latestRun : undefined
    const attempt = resumable?.attempt ?? state.qa.currentAttempt + 1
    if (attempt > state.qa.maxAttempts) {
      return await updateRun({
        cwd: options.cwd,
        runId: state.runId,
        expectedRevision: state.revision,
        mutate(next) {
          next.phase = 'QA'
          next.status = 'BLOCKED'
          next.blocker = { code: 'QA_RETRY_EXHAUSTED', message: `QA exhausted ${next.qa.maxAttempts} attempts` }
        },
      })
    }
    const selection = resumable === undefined
      ? selectQaAdapter(options.adapters, state.qaPreference)
      : (() => {
          const adapter = options.adapters.find(candidate => candidate.name === resumable.adapterName)
          if (
            adapter === undefined
            || adapter.kind !== resumable.adapterKind
            || adapter.verified !== true
            || adapter.verificationEvidenceRef !== resumable.adapterVerificationEvidenceRef
          ) {
            throw new OrchestratorError('resumable QA Adapter is unavailable or changed')
          }
          return { adapter, source: 'automatic' as const, reason: 'resuming persisted QA Adapter' }
        })()
    if (selection.adapter === undefined) {
      const qaRunId = stableQaRunId(state.runId, attempt, verification.snapshotRef, 'manual')
      return await updateRun({
        cwd: options.cwd,
        runId: state.runId,
        expectedRevision: state.revision,
        mutate(next) {
          next.phase = 'QA'
          next.status = 'NEEDS_USER'
          next.qa.currentAttempt = attempt
          next.qa.runs.push({
            qaRunId,
            attempt,
            adapterName: 'manual',
            adapterKind: 'manual',
            adapterVerificationEvidenceRef: 'qa:manual-contract:v1',
            revision: 1,
            executionStatus: 'COMPLETED',
            resultStatus: 'MANUAL_REQUIRED',
            runRef: `qa:manual:${qaRunId}`,
            verificationRunId: verification.verificationRunId,
            verificationSnapshotRef: verification.snapshotRef,
            workspaceFingerprint: before.fingerprint,
            evidenceRef: `qa:selection:${qaRunId}`,
            manualChecklist: [...MANUAL_QA_CHECKLIST],
          })
          next.blocker = { code: 'QA_MANUAL_REQUIRED', message: selection.reason }
        },
      })
    }
    const qaRunId = resumable?.qaRunId
      ?? stableQaRunId(state.runId, attempt, verification.snapshotRef, selection.adapter.name)
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = 'QA'
        next.qa.currentAttempt = attempt
        next.qaLease = {
          qaRunId,
          attempt,
          adapterName: selection.adapter!.name,
          adapterKind: selection.adapter!.kind,
          adapterVerificationEvidenceRef: selection.adapter!.verificationEvidenceRef,
          verificationRunId: verification.verificationRunId,
          verificationSnapshotRef: verification.snapshotRef,
          beforeFingerprint: before.fingerprint,
          beforeChangedPaths: { ...before.changedPaths },
          status: 'OPEN',
        }
      },
    })
  } else {
    before = {
      worktreeRoot: state.repo.worktreeRoot,
      fingerprint: state.qaLease.beforeFingerprint,
      changedPaths: state.qaLease.beforeChangedPaths,
    }
    assertReadOnlyQaWorkspace(before, await captureWorktreeBoundary(options.cwd))
  }

  const lease = state.qaLease
  if (lease === undefined) throw new OrchestratorError('QA lease was not persisted')
  const adapter = options.adapters.find(candidate => candidate.name === lease.adapterName)
  if (
    adapter === undefined
    || adapter.verified !== true
    || adapter.kind !== lease.adapterKind
    || adapter.verificationEvidenceRef !== lease.adapterVerificationEvidenceRef
  ) {
    throw new OrchestratorError('open QA lease Adapter is unavailable or changed')
  }
  const previous = state.qa.runs.find(run => run.attempt === lease.attempt)
  const request = {
    cwd: state.repo.worktreeRoot,
    orchestrationRunId: state.runId,
    qaRunId: lease.qaRunId,
    attempt: lease.attempt,
    verificationRunId: lease.verificationRunId,
    verificationSnapshotRef: lease.verificationSnapshotRef,
    expectedHead: state.repo.head,
    expectedBranch: state.repo.branch,
    expectedWorkspaceFingerprint: lease.beforeFingerprint,
    signal: options.signal,
  }
  throwIfAborted(options.signal)
  const rawObservation = previous === undefined
    ? await adapter.start(request)
    : await adapter.resume({ ...request, expectedRevision: previous.revision, expectedRunRef: previous.runRef })
  throwIfAborted(options.signal)
  const observation = validateQaObservation(rawObservation, {
    runId: lease.qaRunId,
    attempt: lease.attempt,
    adapterName: lease.adapterName,
    adapterKind: adapter.kind,
    adapterVerificationEvidenceRef: lease.adapterVerificationEvidenceRef,
    repositoryRoot: state.repo.worktreeRoot,
    head: state.repo.head,
    branch: state.repo.branch,
    workspaceFingerprint: lease.beforeFingerprint,
    verificationRunId: lease.verificationRunId,
    verificationSnapshotRef: lease.verificationSnapshotRef,
  })
  assertMonotonicQaObservation(previous, observation)
  const after = await captureWorktreeBoundary(options.cwd)
  assertReadOnlyQaWorkspace(before, after)
  await validateResume(state, options.cwd)

  return await updateRun({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      const run = {
        qaRunId: observation.runId,
        attempt: observation.attempt,
        adapterName: observation.adapterName,
        adapterKind: observation.adapterKind,
        adapterVerificationEvidenceRef: observation.adapterVerificationEvidenceRef,
        revision: observation.revision,
        executionStatus: observation.executionStatus,
        ...(observation.resultStatus === undefined ? {} : { resultStatus: observation.resultStatus }),
        runRef: observation.runRef,
        verificationRunId: observation.verificationRunId,
        verificationSnapshotRef: observation.verificationSnapshotRef,
        workspaceFingerprint: observation.workspaceFingerprint,
        ...(observation.evidenceRef === undefined ? {} : { evidenceRef: observation.evidenceRef }),
        ...(observation.blockerRef === undefined ? {} : { blockerRef: observation.blockerRef }),
        manualChecklist: [...observation.manualChecklist],
      }
      const runIndex = next.qa.runs.findIndex(candidate => candidate.attempt === observation.attempt)
      if (runIndex === -1) next.qa.runs.push(run)
      else next.qa.runs[runIndex] = run
      delete next.qaLease
      delete next.blocker
      if (observation.executionStatus === 'RUNNING') {
        next.status = 'PAUSED'
      } else if (observation.executionStatus === 'CANCELLED') {
        next.status = 'CANCELLED'
      } else if (observation.executionStatus === 'FAILED') {
        next.status = 'FAILED'
        next.blocker = { code: 'QA_EXECUTION_FAILED', message: observation.evidenceRef! }
      } else if (observation.executionStatus === 'BLOCKED') {
        next.status = 'BLOCKED'
        next.blocker = { code: 'QA_BLOCKED', message: observation.blockerRef! }
      } else if (observation.resultStatus === 'PASS') {
        next.status = 'RUNNING'
      } else if (observation.resultStatus === 'MANUAL_REQUIRED') {
        next.status = 'NEEDS_USER'
        next.blocker = { code: 'QA_MANUAL_REQUIRED', message: observation.evidenceRef! }
      } else {
        const created = createQaFindings(next, observation)
        if (observation.attempt >= next.qa.maxAttempts) {
          next.status = 'BLOCKED'
          next.blocker = { code: 'QA_RETRY_EXHAUSTED', message: `QA exhausted ${next.qa.maxAttempts} attempts` }
        } else {
          next.phase = 'REMEDIATE'
          next.status = 'RUNNING'
          next.currentFinding = created[0]?.findingId
          next.fullVerificationHistory.push(next.fullVerification!)
          delete next.fullVerification
          delete next.fullVerificationLease
          next.verificationCycle += 1
        }
      }
    },
  })
}

export async function advanceFinalReconciliation(options: {
  readonly cwd: string
  readonly runId: string
  readonly adapter: FinalReconciliationAdapter
  readonly signal: AbortSignal
}): Promise<RunState> {
  throwIfAborted(options.signal)
  let state = await loadRun(options.cwd, options.runId)
  if (!['QA', 'FINAL_RECONCILE'].includes(state.phase)) {
    throw new OrchestratorError(`Final Reconciliation cannot advance from phase ${state.phase}`)
  }
  const latestQa = state.qa.runs.find(run => run.attempt === state.qa.currentAttempt)
  if (latestQa?.executionStatus !== 'COMPLETED' || latestQa.resultStatus !== 'PASS') {
    throw new OrchestratorError('Final Reconciliation requires an authoritative QA PASS')
  }
  if (state.fullVerification?.executionStatus !== 'COMPLETED' || state.fullVerification.status !== 'PASS') {
    throw new OrchestratorError('Final Reconciliation requires the current Full Verification PASS')
  }
  if (
    state.phase === 'QA'
    && (
      state.fullVerification.workspaceFingerprint !== state.repo.worktreeFingerprint
      || latestQa.workspaceFingerprint !== state.repo.worktreeFingerprint
    )
  ) throw new OrchestratorError('Final Reconciliation requires QA and Full Verification on the current workspace')
  if (state.qa.findings.some(finding => finding.status !== 'RESOLVED')) {
    throw new OrchestratorError('Final Reconciliation cannot start with unresolved QaFindings')
  }
  if (
    state.auditRunId === undefined
    || state.auditResult?.status !== 'COMPLETED'
    || state.auditResult.executionStatus !== 'COMPLETED'
  ) throw new OrchestratorError('Final Reconciliation requires the completed initial Audit')
  const originalAuditRunId = state.auditRunId
  const originalAuditResult = state.auditResult
  if (
    state.phase === 'FINAL_RECONCILE'
    && state.status === 'RUNNING'
    && state.finalReconciliation?.executionStatus === 'COMPLETED'
  ) return state
  if (['PAUSED', 'BLOCKED'].includes(state.status)) {
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
  if (['FAILED', 'CANCELLED', 'DONE', 'DONE_WITH_CONCERNS', 'NEEDS_USER'].includes(state.status)) {
    throw new OrchestratorError(`Final Reconciliation cannot advance a ${state.status} run`)
  }

  let before: WorktreeBoundary
  if (state.finalReconciliationLease === undefined) {
    await validateResume(state, options.cwd)
    before = await captureWorktreeBoundary(options.cwd)
    const reconciliationRunId = state.finalReconciliation?.reconciliationRunId
      ?? stableReconciliationRunId(state.runId, originalAuditResult.snapshotRef, before.fingerprint)
    const allowedRoot = await resolveAuditRoot(state.repo.worktreeRoot)
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = 'FINAL_RECONCILE'
        next.finalAuditRunId = reconciliationRunId
        next.finalReconciliationLease = {
          reconciliationRunId,
          adapterName: options.adapter.name,
          allowedRoot,
          originalAuditRunId,
          originalSnapshotRef: originalAuditResult.snapshotRef,
          originalFindingIds: state.findings.map(finding => finding.findingId).sort(),
          beforeFingerprint: before.fingerprint,
          beforeChangedPaths: { ...before.changedPaths },
          status: 'OPEN',
        }
      },
    })
  } else {
    if (state.finalReconciliationLease.adapterName !== options.adapter.name) {
      throw new OrchestratorError('open Final Reconciliation lease belongs to another Adapter')
    }
    before = {
      worktreeRoot: state.repo.worktreeRoot,
      fingerprint: state.finalReconciliationLease.beforeFingerprint,
      changedPaths: state.finalReconciliationLease.beforeChangedPaths,
    }
  }

  const lease = state.finalReconciliationLease
  if (lease === undefined) throw new OrchestratorError('Final Reconciliation lease was not persisted')
  const request = {
    cwd: state.repo.worktreeRoot,
    orchestrationRunId: state.runId,
    reconciliationRunId: lease.reconciliationRunId,
    originalAuditRunId: lease.originalAuditRunId,
    originalSnapshotRef: lease.originalSnapshotRef,
    originalFindingIds: lease.originalFindingIds,
    expectedHead: state.repo.head,
    expectedBranch: state.repo.branch,
    expectedWorkspaceFingerprint: lease.beforeFingerprint,
    contextFingerprint: state.contextFingerprint,
    signal: options.signal,
  }
  throwIfAborted(options.signal)
  const rawObservation = state.finalReconciliation === undefined
    ? await options.adapter.start(request)
    : await options.adapter.resume({
        ...request,
        expectedRevision: state.finalReconciliation.revision,
        expectedRunRef: state.finalReconciliation.runRef,
        expectedFreshSnapshotRef: state.finalReconciliation.freshSnapshotRef,
      })
  throwIfAborted(options.signal)
  const observation = validateFinalReconciliationObservation(rawObservation, {
    runId: lease.reconciliationRunId,
    repositoryRoot: state.repo.worktreeRoot,
    head: state.repo.head,
    branch: state.repo.branch,
    workspaceFingerprint: lease.beforeFingerprint,
    contextFingerprint: state.contextFingerprint,
    originalAuditRunId: lease.originalAuditRunId,
    originalSnapshotRef: lease.originalSnapshotRef,
    originalFindingIds: lease.originalFindingIds,
  })
  assertMonotonicReconciliation(state, observation)
  const after = await captureWorktreeBoundary(options.cwd)
  const changedPaths = diffWorktreeBoundaries(before, after)
  assertFinalReconciliationWorkspace(lease.allowedRoot, before, after, changedPaths, observation)
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
      next.phase = 'FINAL_RECONCILE'
      next.finalAuditRunId = observation.runId
      next.finalReconciliation = {
        reconciliationRunId: observation.runId,
        revision: observation.revision,
        executionStatus: observation.executionStatus,
        runRef: observation.runRef,
        originalAuditRunId: observation.originalAuditRunId,
        originalSnapshotRef: observation.originalSnapshotRef,
        freshSnapshotRef: observation.freshSnapshotRef,
        registryRef: observation.registryRef,
        reportRef: observation.reportRef,
        workspaceFingerprint: after.fingerprint,
        ...(observation.evidenceRef === undefined ? {} : { evidenceRef: observation.evidenceRef }),
        ...(observation.blockerRef === undefined ? {} : { blockerRef: observation.blockerRef }),
        findings: observation.findings.map(finding => ({ ...finding })),
      }
      delete next.finalReconciliationLease
      delete next.blocker
      if (observation.executionStatus === 'RUNNING') {
        next.status = 'PAUSED'
      } else if (observation.executionStatus === 'BLOCKED') {
        next.status = 'BLOCKED'
        next.blocker = { code: 'FINAL_RECONCILIATION_BLOCKED', message: observation.blockerRef! }
      } else if (observation.executionStatus === 'FAILED') {
        next.status = 'FAILED'
        next.blocker = { code: 'FINAL_RECONCILIATION_FAILED', message: observation.evidenceRef! }
      } else if (observation.executionStatus === 'CANCELLED') {
        next.status = 'CANCELLED'
      } else {
        next.status = 'RUNNING'
      }
    },
  })
}

export async function advanceRunSummary(options: {
  readonly cwd: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly now?: Date
}): Promise<RunState> {
  throwIfAborted(options.signal)
  let state = await loadRun(options.cwd, options.runId)
  if (!['FINAL_RECONCILE', 'REPORT'].includes(state.phase)) {
    throw new OrchestratorError(`Run Summary cannot advance from phase ${state.phase}`)
  }
  await validateResume(state, options.cwd)
  if (state.phase === 'FINAL_RECONCILE') {
    if (state.finalReconciliation?.executionStatus !== 'COMPLETED') {
      throw new OrchestratorError('Run Summary requires completed Final Reconciliation')
    }
    const summary = createRunSummary(state, options.now)
    state = await updateRun({
      cwd: options.cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = 'REPORT'
        next.summary = summary
      },
      now: options.now,
    })
  }
  if (state.summary === undefined) throw new OrchestratorError('REPORT phase has no persisted Run Summary')
  assertRunSummaryMatchesState(state.summary, state)
  return await updateRun({
    cwd: options.cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'DONE'
      next.status = state.summary!.overallStatus
    },
    now: options.now,
  })
}

function stableReconciliationRunId(runId: string, originalSnapshotRef: string, workspaceFingerprint: string): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${originalSnapshotRef}\0${workspaceFingerprint}`)
    .digest('hex')
    .slice(0, 16)
  return `reconcile-${digest}`
}

function assertMonotonicReconciliation(state: RunState, observation: FinalReconciliationObservation): void {
  const previous = state.finalReconciliation
  if (previous === undefined) return
  if (observation.runId !== previous.reconciliationRunId || observation.runRef !== previous.runRef) {
    throw new FinalReconciliationContractError('Final Reconciliation Adapter changed run identity')
  }
  if (observation.revision < previous.revision) {
    throw new FinalReconciliationContractError('Final Reconciliation revision moved backwards')
  }
  if (observation.revision === previous.revision && observation.executionStatus !== previous.executionStatus) {
    throw new FinalReconciliationContractError('Final Reconciliation changed status at the same revision')
  }
  if (observation.freshSnapshotRef !== previous.freshSnapshotRef) {
    throw new FinalReconciliationContractError('Final Reconciliation changed fresh snapshot during resume')
  }
}

function assertFinalReconciliationWorkspace(
  allowedRoot: string,
  before: WorktreeBoundary,
  after: WorktreeBoundary,
  changedPaths: readonly string[],
  observation: FinalReconciliationObservation,
): void {
  if (!observation.registryRef.startsWith(`${allowedRoot}/`) || !observation.reportRef.startsWith(`${allowedRoot}/`)) {
    throw new FinalReconciliationContractError('Final Reconciliation output root does not match the mutation lease')
  }
  for (const path of changedPaths) {
    if (!path.startsWith(`${allowedRoot}/`)) {
      throw new FinalReconciliationContractError(`Final Reconciliation mutated a path outside its output root: ${path}`)
    }
  }
  const outputMap = new Map(observation.auditOutputs.map(output => [output.path, output.fingerprint]))
  for (const path of changedPaths) {
    if (outputMap.get(path) !== after.changedPaths[path]) {
      throw new FinalReconciliationContractError(`Final Reconciliation output fingerprint mismatch: ${path}`)
    }
  }
  for (const [path, fingerprint] of outputMap) {
    if (after.changedPaths[path] !== fingerprint) {
      throw new FinalReconciliationContractError(`Final Reconciliation reported a non-current output: ${path}`)
    }
  }
  const businessDirtyFiles = Object.keys(after.changedPaths)
    .filter(path => !path.startsWith(`${allowedRoot}/`))
    .sort()
  if (JSON.stringify(businessDirtyFiles) !== JSON.stringify([...observation.businessDirtyFiles].sort())) {
    throw new FinalReconciliationContractError('Final Reconciliation business dirty-file scope does not match Git')
  }
}

const MANUAL_QA_CHECKLIST = Object.freeze([
  'Exercise the user-visible scenarios affected by the change.',
  'Record expected versus observed behavior for every scenario.',
  'Attach durable evidence and report failures with reproduction steps.',
])

function stableQaRunId(runId: string, attempt: number, verificationSnapshotRef: string, adapterName: string): string {
  const digest = createHash('sha256')
    .update(`${runId}\0${attempt}\0${verificationSnapshotRef}\0${adapterName}`)
    .digest('hex')
    .slice(0, 16)
  return `qa-${digest}`
}

function assertMonotonicQaObservation(
  previous: RunState['qa']['runs'][number] | undefined,
  observation: QaObservation,
): void {
  if (previous === undefined) return
  if (observation.runId !== previous.qaRunId || observation.runRef !== previous.runRef) {
    throw new QaContractError('QA Adapter changed run identity')
  }
  if (observation.revision < previous.revision) throw new QaContractError('QA Adapter revision moved backwards')
  if (
    observation.revision === previous.revision
    && (
      observation.executionStatus !== previous.executionStatus
      || observation.resultStatus !== previous.resultStatus
    )
  ) throw new QaContractError('QA Adapter changed status at the same revision')
  if (
    observation.verificationRunId !== previous.verificationRunId
    || observation.verificationSnapshotRef !== previous.verificationSnapshotRef
  ) throw new QaContractError('QA Adapter changed Full Verification identity')
}

function assertReadOnlyQaWorkspace(before: WorktreeBoundary, after: WorktreeBoundary): void {
  if (before.worktreeRoot !== after.worktreeRoot || before.fingerprint !== after.fingerprint) {
    throw new QaContractError('QA changed the Git worktree')
  }
  const beforeEntries = Object.entries(before.changedPaths).sort(([left], [right]) => left.localeCompare(right))
  const afterEntries = Object.entries(after.changedPaths).sort(([left], [right]) => left.localeCompare(right))
  if (JSON.stringify(beforeEntries) !== JSON.stringify(afterEntries)) {
    throw new QaContractError('QA changed dirty-file scope')
  }
}

function createQaFindings(next: RunState, observation: QaObservation): RunState['qa']['findings'] {
  const created = observation.findings.map((finding, index) => {
    const findingId = `QAF-${String(observation.attempt).padStart(3, '0')}-${String(index + 1).padStart(3, '0')}`
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([finding.symptom, finding.expected, finding.steps, finding.environment]))
      .digest('hex')
    const findingRef = `qa:finding:${observation.runId}:${index + 1}`
    const item: RunState['qa']['findings'][number] = {
      findingId,
      status: 'OPEN',
      fingerprint,
      symptom: finding.symptom,
      expected: finding.expected,
      steps: [...finding.steps],
      environment: finding.environment,
      evidenceRef: finding.evidenceRef,
      qaRunId: observation.runId,
      qaAttempt: observation.attempt,
      adapterName: observation.adapterName,
      qaSnapshotRef: observation.runRef,
      findingRef,
      handoffRef: `qa:handoff:${observation.runId}:${index + 1}`,
    }
    next.qa.findings.push(item)
    return item
  })
  return created
}

function stableVerificationRunId(orchestrationRunId: string, cycle: number): string {
  return `verify-${createHash('sha256').update(`${orchestrationRunId}\0${cycle}`).digest('hex').slice(0, 16)}`
}

function stableVerificationSnapshot(head: string, workspaceFingerprint: string): string {
  const digest = createHash('sha256').update(`${head}\0${workspaceFingerprint}`).digest('hex')
  return `verification-snapshot-${digest}`
}

function assertMonotonicVerification(state: RunState, observation: FullVerificationObservation): void {
  const previous = state.fullVerification
  if (previous === undefined) return
  if (observation.runId !== previous.verificationRunId || observation.runRef !== previous.runRef) {
    throw new FullVerificationContractError('Verification Adapter changed run identity')
  }
  if (observation.revision < previous.revision) {
    throw new FullVerificationContractError('Verification Adapter revision moved backwards')
  }
  if (
    observation.revision === previous.revision
    && (
      observation.executionStatus !== previous.executionStatus
      || observation.resultStatus !== previous.status
    )
  ) {
    throw new FullVerificationContractError('Verification Adapter changed status at the same revision')
  }
  if (observation.snapshotRef !== previous.snapshotRef) {
    throw new FullVerificationContractError('Verification Adapter changed snapshot during resume')
  }
}

function assertReadOnlyVerificationWorkspace(before: WorktreeBoundary, after: WorktreeBoundary): void {
  if (before.worktreeRoot !== after.worktreeRoot || before.fingerprint !== after.fingerprint) {
    throw new FullVerificationContractError('Full Verification changed the Git worktree')
  }
  const beforeEntries = Object.entries(before.changedPaths).sort(([left], [right]) => left.localeCompare(right))
  const afterEntries = Object.entries(after.changedPaths).sort(([left], [right]) => left.localeCompare(right))
  if (JSON.stringify(beforeEntries) !== JSON.stringify(afterEntries)) {
    throw new FullVerificationContractError('Full Verification changed dirty-file scope')
  }
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
  const qaFinding = next.qa.findings.find(candidate => candidate.findingId === findingId)
  if (observation.executionStatus === 'RUNNING') {
    next.status = 'PAUSED'
    next.currentFinding = findingId
  } else if (observation.executionStatus === 'BLOCKED') {
    if (qaFinding !== undefined) qaFinding.status = 'BLOCKED'
    next.status = 'BLOCKED'
    next.currentFinding = findingId
    next.blocker = { code: 'AUTO_FIX_BLOCKED', message: observation.blockerRef! }
  } else if (observation.executionStatus === 'NEEDS_CONTEXT') {
    if (qaFinding !== undefined) qaFinding.status = 'BLOCKED'
    next.status = 'NEEDS_USER'
    next.currentFinding = findingId
    next.blocker = { code: 'AUTO_FIX_NEEDS_CONTEXT', message: observation.blockerRef! }
  } else if (observation.executionStatus === 'FAILED') {
    if (qaFinding !== undefined) qaFinding.status = 'BLOCKED'
    next.status = 'FAILED'
    next.currentFinding = findingId
    next.blocker = { code: 'AUTO_FIX_FAILED', message: observation.executionRef }
  } else if (observation.executionStatus === 'CANCELLED') {
    next.status = 'CANCELLED'
    next.currentFinding = findingId
  } else {
    if (qaFinding !== undefined) qaFinding.status = 'RESOLVED'
    next.status = 'RUNNING'
    const remaining = nextAutoFixFinding(next)
    if (remaining === undefined) delete next.currentFinding
    else next.currentFinding = remaining.findingId
  }
}

function nextAutoFixFinding(state: RunState) {
  const auditPending = state.findings.filter(finding =>
    finding.status === 'confirmed'
    && finding.route === 'auto-fix'
    && !state.fixRuns.some(run =>
      run.findingId === finding.findingId
      && ['DONE', 'DONE_WITH_CONCERNS'].includes(run.status)))
  const qaPending = state.qa.findings.filter(finding =>
    ['OPEN', 'IN_REMEDIATION'].includes(finding.status)
    && !state.fixRuns.some(run =>
      run.findingId === finding.findingId
      && ['DONE', 'DONE_WITH_CONCERNS'].includes(run.status)))
  const pending = [...auditPending, ...qaPending]
  return pending.find(finding => finding.findingId === state.currentFinding) ?? pending[0]
}

function autoFixSource(state: RunState, findingId: string, handoffRef: string): AutoFixSource {
  const qaFinding = state.qa.findings.find(candidate => candidate.findingId === findingId)
  if (qaFinding !== undefined) {
    return {
      kind: 'qa-finding',
      findingId,
      handoffRef,
      qaRunId: qaFinding.qaRunId,
      qaAttempt: qaFinding.qaAttempt,
      qaSnapshotRef: qaFinding.qaSnapshotRef,
      qaFindingRef: qaFinding.findingRef,
    }
  }
  if (
    state.auditRunId === undefined
    || state.auditResult === undefined
    || state.auditResult.status !== 'COMPLETED'
    || state.auditResult.executionStatus !== 'COMPLETED'
  ) throw new OrchestratorError('Audit finding remediation requires a completed Audit checkpoint')
  return {
    kind: 'audit-finding',
    findingId,
    handoffRef,
    auditRunId: state.auditRunId,
    auditSnapshotRef: state.auditResult.snapshotRef,
    findingRegistryRef: state.auditResult.registryRef,
  }
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
