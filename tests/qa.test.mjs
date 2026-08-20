import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import * as Plugin from '../lib/index.js'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args])
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-harness-qa-'))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'QA Test')
  await git(cwd, 'config', 'user.email', 'qa@example.invalid')
  for (const [path, content] of [
    ['README.md', '# Fixture\n'],
    ['AGENTS.md', '# Agents\n'],
    ['ARCHITECTURE.md', '# Architecture\n'],
    ['HARNESS.md', '# Harness\n'],
    ['source.txt', 'baseline\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
  ]) await writeFile(join(cwd, path), content)
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', 'fixture')
  return cwd
}

async function verifiedRun(cwd, runId, options = {}) {
  let state = await Plugin.createRun({ cwd, runId, qaPreference: options.qaPreference })
  for (const phase of ['PREFLIGHT', 'AUDIT', 'ROUTE', 'REMEDIATE', 'FULL_VERIFY']) {
    state = await Plugin.updateRun({
      cwd,
      runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = phase
        if (phase === 'FULL_VERIFY') {
          next.fullVerification = {
            verificationRunId: `verify-${runId}-0`,
            executionStatus: 'COMPLETED',
            status: 'PASS',
            revision: 1,
            command: Plugin.FULL_VERIFICATION_COMMAND,
            runRef: `verification:run:${runId}:0`,
            snapshotRef: `verification:snapshot:${runId}:0`,
            workspaceFingerprint: next.repo.worktreeFingerprint,
            evidenceRef: `verification:evidence:${runId}:0`,
          }
        }
      },
    })
  }
  return state
}

function qaObservation(request, resultStatus, overrides = {}) {
  const running = resultStatus === undefined
  const fail = resultStatus === 'FAIL'
  return {
    contractVersion: 1,
    runId: request.qaRunId,
    attempt: request.attempt,
    revision: overrides.revision ?? 1,
    adapterName: overrides.adapterName ?? 'fixture-qa',
    adapterKind: 'cli-api',
    adapterVerificationEvidenceRef: 'qa:adapter-verification:fixture',
    executionStatus: running ? 'RUNNING' : 'COMPLETED',
    ...(running ? {} : { resultStatus }),
    repositoryRoot: request.cwd,
    head: request.expectedHead,
    branch: request.expectedBranch,
    workspaceFingerprint: request.expectedWorkspaceFingerprint,
    verificationRunId: request.verificationRunId,
    verificationSnapshotRef: request.verificationSnapshotRef,
    runRef: `qa:run:${request.qaRunId}`,
    startedAt: '2026-08-20T12:00:00.000Z',
    ...(running ? {} : {
      finishedAt: '2026-08-20T12:01:00.000Z',
      evidenceRef: `qa:evidence:${request.attempt}:${resultStatus}`,
    }),
    scenarios: running
      ? []
      : [{
          scenarioId: 'fixture-flow',
          status: resultStatus,
          evidenceRef: `qa:scenario:${request.attempt}:${resultStatus}`,
        }],
    findings: fail
      ? [{
          symptom: 'Fixture action remains broken',
          expected: 'Fixture action succeeds',
          steps: ['Open the fixture', 'Run the action'],
          environment: 'local CLI fixture',
          evidenceRef: `qa:failure:${request.attempt}`,
        }]
      : [],
    manualChecklist: [],
    workspaceVerified: true,
    quiescent: true,
  }
}

function verificationObservation(request) {
  return {
    contractVersion: 1,
    runId: request.verificationRunId,
    revision: 1,
    executionStatus: 'COMPLETED',
    resultStatus: 'PASS',
    command: request.command,
    repositoryRoot: request.cwd,
    head: request.expectedHead,
    branch: request.expectedBranch,
    workspaceFingerprint: request.expectedWorkspaceFingerprint,
    snapshotRef: request.expectedSnapshotRef,
    runRef: `verification:run:${request.verificationRunId}`,
    startedAt: '2026-08-20T12:00:00.000Z',
    finishedAt: '2026-08-20T12:01:00.000Z',
    evidenceRef: `verification:evidence:${request.verificationRunId}`,
    workspaceVerified: true,
    quiescent: true,
  }
}

function autoFixObservation(request, boundary) {
  return {
    contractVersion: 2,
    runId: request.autoFixRunId,
    source: request.source,
    mode: request.mode,
    executionStatus: 'COMPLETED',
    completionStatus: 'DONE',
    revision: 1,
    stateDigest: 'a'.repeat(64),
    executionRef: `autofix:execution:${request.source.findingId}`,
    repositoryRoot: request.cwd,
    baseSha: request.expectedHead,
    branch: request.expectedBranch,
    workspaceSnapshotRef: `autofix:snapshot:${request.source.findingId}`,
    workspaceBaseFingerprint: request.expectedWorkspaceBaseFingerprint,
    stage: 'report',
    changedFiles: ['qa-fix.txt'],
    changeOutputs: [{ path: 'qa-fix.txt', fingerprint: boundary.changedPaths['qa-fix.txt'] }],
    workspaceVerified: true,
    quiescent: true,
    regressionRedRef: 'autofix:red:qaf',
    regressionGreenRef: 'autofix:green:qaf',
    reviewOutcome: 'PASS',
    reviewEvidenceRef: 'autofix:review:qaf',
    reviewReviewer: 'independent',
    reviewDiffHash: 'b'.repeat(64),
    finalVerificationRef: 'autofix:verify:qaf',
    finalVerificationObservedAt: '2026-08-20T12:02:00.000Z',
    finalVerificationDiffHash: 'b'.repeat(64),
    commits: [],
  }
}

test('manual fallback produces a durable checklist and never claims PASS', async () => {
  const cwd = await repository()
  try {
    const initial = await verifiedRun(cwd, 'qa-manual', { qaPreference: 'missing-browser' })
    const manual = await Plugin.advanceQaRun({ cwd, runId: initial.runId, adapters: [], signal: new AbortController().signal })
    assert.equal(manual.phase, 'QA')
    assert.equal(manual.status, 'NEEDS_USER')
    assert.equal(manual.blocker.code, 'QA_MANUAL_REQUIRED')
    assert.equal(manual.qa.currentAttempt, 1)
    assert.equal(manual.qa.runs[0].resultStatus, 'MANUAL_REQUIRED')
    assert.equal(manual.qa.runs[0].manualChecklist.length, 3)
    assert.notEqual(manual.qa.runs[0].resultStatus, 'PASS')
    const resumed = await Plugin.advanceQaRun({ cwd, runId: initial.runId, adapters: [], signal: new AbortController().signal })
    assert.equal(resumed.qa.currentAttempt, 1)
    assert.equal(resumed.qa.runs.length, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('resumes one persisted automatic QA attempt and enforces a read-only worktree', async () => {
  const cwd = await repository()
  const adapter = {
    name: 'fixture-qa',
    kind: 'cli-api',
    verified: true,
    verificationEvidenceRef: 'qa:adapter-verification:fixture',
    async start(request) {
      return qaObservation(request)
    },
    async resume(request) {
      assert.equal(request.expectedRevision, 1)
      return qaObservation(request, 'PASS', { revision: 2 })
    },
  }
  try {
    const initial = await verifiedRun(cwd, 'qa-resume')
    const paused = await Plugin.advanceQaRun({ cwd, runId: initial.runId, adapters: [adapter], signal: new AbortController().signal })
    assert.equal(paused.status, 'PAUSED')
    assert.equal(paused.qa.currentAttempt, 1)
    const passed = await Plugin.advanceQaRun({ cwd, runId: initial.runId, adapters: [adapter], signal: new AbortController().signal })
    assert.equal(passed.status, 'RUNNING')
    assert.equal(passed.qa.runs[0].resultStatus, 'PASS')
    assert.equal(passed.qa.currentAttempt, 1)

    const mutating = {
      ...adapter,
      name: 'mutating-qa',
      async start(request) {
        await writeFile(join(request.cwd, 'qa-mutated.txt'), 'not allowed\n')
        return qaObservation(request, 'PASS', { adapterName: 'mutating-qa' })
      },
    }
    const other = await verifiedRun(await repository(), 'qa-read-only')
    try {
      await assert.rejects(
        Plugin.advanceQaRun({ cwd: other.repo.worktreeRoot, runId: other.runId, adapters: [mutating], signal: new AbortController().signal }),
        error => error instanceof Plugin.QaContractError && /changed the Git worktree/u.test(error.message),
      )
    } finally {
      await rm(other.repo.worktreeRoot, { recursive: true, force: true })
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('routes QaFinding through authorized Auto Fix, a fresh Full Verification, and QA retry', async () => {
  const cwd = await repository()
  const qaAdapter = {
    name: 'fixture-qa',
    kind: 'cli-api',
    verified: true,
    verificationEvidenceRef: 'qa:adapter-verification:fixture',
    async start(request) {
      return qaObservation(request, request.attempt === 1 ? 'FAIL' : 'PASS')
    },
    async resume() {
      throw new Error('not expected')
    },
  }
  let receivedSource
  const autoFixAdapter = {
    name: 'fixture-auto-fix',
    async start(request) {
      receivedSource = request.source
      await writeFile(join(request.cwd, 'qa-fix.txt'), 'fixed\n')
      return autoFixObservation(request, await Plugin.captureWorktreeBoundary(request.cwd))
    },
    async resume() {
      throw new Error('not expected')
    },
  }
  const verificationAdapter = {
    name: 'fixture-verification',
    async start(request) {
      return verificationObservation(request)
    },
    async resume() {
      throw new Error('not expected')
    },
  }
  try {
    const initial = await verifiedRun(cwd, 'qa-loop')
    const failed = await Plugin.advanceQaRun({ cwd, runId: initial.runId, adapters: [qaAdapter], signal: new AbortController().signal })
    assert.equal(failed.phase, 'REMEDIATE')
    assert.equal(failed.qa.findings[0].findingId, 'QAF-001-001')
    assert.equal(failed.findings.length, 0)
    assert.equal(failed.verificationCycle, 1)
    assert.equal(failed.fullVerification, undefined)
    assert.equal(failed.fullVerificationHistory.length, 1)

    const fixed = await Plugin.advanceRemediationRun({ cwd, runId: initial.runId, adapter: autoFixAdapter, signal: new AbortController().signal })
    assert.equal(receivedSource.kind, 'qa-finding')
    assert.equal(receivedSource.findingId, 'QAF-001-001')
    assert.equal('auditRunId' in receivedSource, false)
    assert.equal(fixed.qa.findings[0].status, 'RESOLVED')

    const verified = await Plugin.advanceFullVerification({ cwd, runId: initial.runId, adapter: verificationAdapter, signal: new AbortController().signal })
    assert.equal(verified.fullVerification.status, 'PASS')
    assert.notEqual(verified.fullVerification.verificationRunId, failed.fullVerificationHistory[0].verificationRunId)
    const passed = await Plugin.advanceQaRun({ cwd, runId: initial.runId, adapters: [qaAdapter], signal: new AbortController().signal })
    assert.equal(passed.qa.currentAttempt, 2)
    assert.equal(passed.qa.runs[1].resultStatus, 'PASS')
    assert.equal(passed.phase, 'QA')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('third QA failure blocks at the immutable retry limit', async () => {
  const cwd = await repository()
  const adapter = {
    name: 'fixture-qa',
    kind: 'cli-api',
    verified: true,
    verificationEvidenceRef: 'qa:adapter-verification:fixture',
    async start(request) {
      return qaObservation(request, 'FAIL')
    },
    async resume() {
      throw new Error('not expected')
    },
  }
  try {
    let state = await verifiedRun(cwd, 'qa-exhaust')
    state = await Plugin.updateRun({
      cwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.qa.currentAttempt = 2
        next.qa.runs.push(
          { qaRunId: 'prior-1', attempt: 1, adapterName: 'fixture-qa', adapterKind: 'cli-api', adapterVerificationEvidenceRef: 'qa:adapter-verification:fixture', revision: 1, executionStatus: 'COMPLETED', resultStatus: 'FAIL', runRef: 'qa:prior:1', verificationRunId: 'verify:prior:1', verificationSnapshotRef: 'snapshot:prior:1', workspaceFingerprint: next.repo.worktreeFingerprint, evidenceRef: 'qa:evidence:prior:1', manualChecklist: [] },
          { qaRunId: 'prior-2', attempt: 2, adapterName: 'fixture-qa', adapterKind: 'cli-api', adapterVerificationEvidenceRef: 'qa:adapter-verification:fixture', revision: 1, executionStatus: 'COMPLETED', resultStatus: 'FAIL', runRef: 'qa:prior:2', verificationRunId: 'verify:prior:2', verificationSnapshotRef: 'snapshot:prior:2', workspaceFingerprint: next.repo.worktreeFingerprint, evidenceRef: 'qa:evidence:prior:2', manualChecklist: [] },
        )
      },
    })
    const blocked = await Plugin.advanceQaRun({ cwd, runId: state.runId, adapters: [adapter], signal: new AbortController().signal })
    assert.equal(blocked.qa.currentAttempt, Plugin.MAX_QA_ATTEMPTS)
    assert.equal(blocked.status, 'BLOCKED')
    assert.equal(blocked.blocker.code, 'QA_RETRY_EXHAUSTED')
    assert.equal(blocked.phase, 'QA')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
