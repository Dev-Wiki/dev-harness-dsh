import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTO_FIX_CONTRACT_VERSION,
  AutoFixContractError,
  validateAutoFixObservation,
} from '../lib/index.js'

const expected = Object.freeze({
  runId: 'fix-run-1',
  findingId: 'AUD-001',
  handoffRef: 'handoff:defect-1',
  auditRunId: 'audit-run-1',
  auditSnapshotRef: 'audit-snapshot-1',
  findingRegistryRef: 'docs/audit/Findings.md',
  repositoryRoot: '/repo',
  baseSha: 'abc123',
  branch: 'main',
  workspaceFingerprint: 'd'.repeat(64),
  mode: 'fix',
})

function observation(overrides = {}) {
  return {
    contractVersion: AUTO_FIX_CONTRACT_VERSION,
    runId: expected.runId,
    findingId: expected.findingId,
    handoffRef: expected.handoffRef,
    auditRunId: expected.auditRunId,
    auditSnapshotRef: expected.auditSnapshotRef,
    findingRegistryRef: expected.findingRegistryRef,
    mode: 'fix',
    executionStatus: 'COMPLETED',
    completionStatus: 'DONE',
    revision: 9,
    stateDigest: 'c'.repeat(64),
    executionRef: 'autofix:execution:1',
    repositoryRoot: expected.repositoryRoot,
    baseSha: expected.baseSha,
    branch: expected.branch,
    workspaceSnapshotRef: 'autofix:snapshot:1',
    workspaceBaseFingerprint: 'd'.repeat(64),
    stage: 'report',
    changedFiles: ['src/fix.ts'],
    changeOutputs: [{ path: 'src/fix.ts', fingerprint: 'a'.repeat(64) }],
    workspaceVerified: true,
    quiescent: true,
    regressionRedRef: 'autofix:red:1',
    regressionGreenRef: 'autofix:green:1',
    reviewOutcome: 'PASS',
    reviewEvidenceRef: 'autofix:review:1',
    reviewReviewer: 'independent',
    reviewDiffHash: 'b'.repeat(64),
    finalVerificationRef: 'autofix:verify:1',
    finalVerificationObservedAt: '2026-08-20T12:00:00.000Z',
    finalVerificationDiffHash: 'b'.repeat(64),
    commits: [],
    ...overrides,
  }
}

test('accepts authoritative fix-only DONE and DONE_WITH_CONCERNS observations', () => {
  const done = validateAutoFixObservation(observation(), expected)
  assert.equal(done.completionStatus, 'DONE')
  assert.deepEqual(done.commits, [])

  const concerns = validateAutoFixObservation(observation({
    completionStatus: 'DONE_WITH_CONCERNS',
    residualRiskRef: 'autofix:risk:1',
  }), expected)
  assert.equal(concerns.residualRiskRef, 'autofix:risk:1')
})

test('rejects commits and incomplete completion evidence in fix mode', () => {
  assert.throws(
    () => validateAutoFixObservation(observation({ commits: [{
      sha: '1'.repeat(40),
      parentSha: '2'.repeat(40),
      changedFiles: ['src/fix.ts'],
      reviewDiffHash: 'b'.repeat(64),
      commitEvidenceRef: 'git-workflow:commit:invalid',
    }] }), expected),
    error => error instanceof AutoFixContractError && /must not create commits/u.test(error.message),
  )
  assert.throws(
    () => validateAutoFixObservation(observation({ regressionRedRef: undefined }), expected),
    /requires regressionRedRef/u,
  )
  assert.throws(
    () => validateAutoFixObservation(observation({
      completionStatus: 'DONE_WITH_CONCERNS',
    }), expected),
    /requires residualRiskRef/u,
  )
})

test('enforces status mapping, identity, and exact changed-file ownership', () => {
  assert.throws(
    () => validateAutoFixObservation(observation({ mode: 'commit' }), expected),
    /mode does not match Run authorization/u,
  )
  assert.throws(
    () => validateAutoFixObservation(observation({ findingId: 'AUD-999' }), expected),
    /findingId does not match/u,
  )
  assert.throws(
    () => validateAutoFixObservation(observation({ changedFiles: ['../escape.ts'] }), expected),
    /repository-relative/u,
  )
  assert.throws(
    () => validateAutoFixObservation(observation({ changedFiles: ['src/other.ts'] }), expected),
    /cover changedFiles exactly/u,
  )
  assert.throws(
    () => validateAutoFixObservation(observation({
      executionStatus: 'BLOCKED',
      completionStatus: 'BLOCKED',
    }), expected),
    /blockerRef/u,
  )
})

test('accepts only quiescent resumable checkpoints for non-terminal execution', () => {
  const running = validateAutoFixObservation(observation({
    executionStatus: 'RUNNING',
    completionStatus: undefined,
    stage: 'implement',
    changedFiles: [],
    changeOutputs: [],
    regressionRedRef: undefined,
    regressionGreenRef: undefined,
    reviewDiffHash: undefined,
    finalVerificationRef: undefined,
    finalVerificationObservedAt: undefined,
    finalVerificationDiffHash: undefined,
    reviewOutcome: undefined,
    reviewEvidenceRef: undefined,
    reviewReviewer: undefined,
  }), expected)
  assert.equal(running.executionStatus, 'RUNNING')
  assert.throws(
    () => validateAutoFixObservation(observation({ quiescent: false }), expected),
    /workspaceVerified and quiescent/u,
  )
})

test('accepts one authorization-bound commit and rejects duplicate or stale commit evidence', () => {
  const commitExpected = { ...expected, mode: 'commit' }
  const sha = '1'.repeat(40)
  const parentSha = expected.baseSha.padEnd(40, '0')
  commitExpected.baseSha = parentSha
  const value = observation({
    mode: 'commit',
    baseSha: parentSha,
    changeOutputs: [],
    postCommitHead: sha,
    postCommitWorkspaceFingerprint: 'e'.repeat(64),
    commits: [{
      sha,
      parentSha,
      changedFiles: ['src/fix.ts'],
      reviewDiffHash: 'b'.repeat(64),
      commitEvidenceRef: 'git-workflow:commit:1',
    }],
  })
  const validated = validateAutoFixObservation(value, commitExpected)
  assert.equal(validated.commits[0].sha, sha)
  assert.throws(
    () => validateAutoFixObservation({ ...value, mode: 'fix' }, commitExpected),
    /mode does not match/u,
  )
  assert.throws(
    () => validateAutoFixObservation({ ...value, commits: [...value.commits, ...value.commits] }, commitExpected),
    /duplicate object ids|exactly one commit/u,
  )
  assert.throws(
    () => validateAutoFixObservation({
      ...value,
      commits: [{ ...value.commits[0], reviewDiffHash: 'f'.repeat(64) }],
    }, commitExpected),
    /bind to the reviewed diff/u,
  )
})
