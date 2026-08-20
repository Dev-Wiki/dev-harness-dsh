import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FULL_VERIFICATION_COMMAND,
  FullVerificationContractError,
  validateFullVerificationObservation,
} from '../lib/index.js'

const expected = Object.freeze({
  runId: 'verify-run-1',
  repositoryRoot: '/repo',
  head: 'a'.repeat(40),
  branch: 'main',
  workspaceFingerprint: 'b'.repeat(64),
  snapshotRef: 'verify:snapshot:1',
})

function observation(overrides = {}) {
  return {
    contractVersion: 1,
    runId: expected.runId,
    revision: 1,
    executionStatus: 'COMPLETED',
    resultStatus: 'PASS',
    command: FULL_VERIFICATION_COMMAND,
    repositoryRoot: expected.repositoryRoot,
    head: expected.head,
    branch: expected.branch,
    workspaceFingerprint: expected.workspaceFingerprint,
    snapshotRef: expected.snapshotRef,
    runRef: 'verification:run:1',
    startedAt: '2026-08-20T12:00:00.000Z',
    finishedAt: '2026-08-20T12:01:00.000Z',
    evidenceRef: 'verification:evidence:1',
    workspaceVerified: true,
    quiescent: true,
    ...overrides,
  }
}

test('accepts PASS and distinguishes failure, missing entry, and unavailable environment', () => {
  for (const resultStatus of ['PASS', 'FAIL', 'ENTRY_MISSING', 'ENVIRONMENT_UNAVAILABLE']) {
    assert.equal(validateFullVerificationObservation(observation({ resultStatus }), expected).resultStatus, resultStatus)
  }
  assert.equal(validateFullVerificationObservation(observation({
    executionStatus: 'FAILED',
    resultStatus: 'EXECUTION_FAILED',
  }), expected).executionStatus, 'FAILED')
})

test('requires the canonical full command, exact snapshot identity, and fresh terminal evidence', () => {
  assert.throws(
    () => validateFullVerificationObservation(observation({ command: 'npm test' }), expected),
    error => error instanceof FullVerificationContractError && /command does not match/u.test(error.message),
  )
  assert.throws(
    () => validateFullVerificationObservation(observation({ workspaceFingerprint: 'c'.repeat(64) }), expected),
    /workspaceFingerprint does not match/u,
  )
  assert.throws(
    () => validateFullVerificationObservation(observation({ evidenceRef: undefined }), expected),
    /requires finishedAt and evidenceRef/u,
  )
  assert.throws(
    () => validateFullVerificationObservation(observation({
      finishedAt: '2026-08-20T11:59:00.000Z',
    }), expected),
    /cannot precede/u,
  )
})

test('accepts only quiescent RUNNING checkpoints without terminal claims', () => {
  const running = validateFullVerificationObservation(observation({
    executionStatus: 'RUNNING',
    resultStatus: undefined,
    finishedAt: undefined,
    evidenceRef: undefined,
  }), expected)
  assert.equal(running.executionStatus, 'RUNNING')
  assert.throws(
    () => validateFullVerificationObservation(observation({ quiescent: false }), expected),
    /workspaceVerified and quiescent/u,
  )
})
