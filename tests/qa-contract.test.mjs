import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defineExternalSkillQaAdapter,
  defineNativeQaAdapter,
  selectQaAdapter,
  validateQaObservation,
} from '../lib/index.js'

const expected = Object.freeze({
  runId: 'qa-run-1',
  attempt: 1,
  adapterName: 'qa-external',
  adapterKind: 'external-skill',
  repositoryRoot: '/repo',
  head: 'a'.repeat(40),
  branch: 'main',
  workspaceFingerprint: 'b'.repeat(64),
  verificationRunId: 'verify-1',
  verificationSnapshotRef: 'verification-snapshot-1',
})

function observation(overrides = {}) {
  return {
    contractVersion: 1,
    runId: expected.runId,
    attempt: expected.attempt,
    revision: 1,
    adapterName: expected.adapterName,
    adapterKind: expected.adapterKind,
    executionStatus: 'COMPLETED',
    resultStatus: 'PASS',
    repositoryRoot: expected.repositoryRoot,
    head: expected.head,
    branch: expected.branch,
    workspaceFingerprint: expected.workspaceFingerprint,
    verificationRunId: expected.verificationRunId,
    verificationSnapshotRef: expected.verificationSnapshotRef,
    runRef: 'qa:run:1',
    startedAt: '2026-08-20T12:00:00.000Z',
    finishedAt: '2026-08-20T12:01:00.000Z',
    evidenceRef: 'qa:evidence:1',
    scenarios: [{ scenarioId: 'login', status: 'PASS', evidenceRef: 'qa:scenario:login' }],
    findings: [],
    manualChecklist: [],
    workspaceVerified: true,
    quiescent: true,
    ...overrides,
  }
}

test('validates PASS, FAIL with QaFinding, and MANUAL_REQUIRED without conflating them', () => {
  assert.equal(validateQaObservation(observation(), expected).resultStatus, 'PASS')
  const failed = validateQaObservation(observation({
    resultStatus: 'FAIL',
    scenarios: [{ scenarioId: 'login', status: 'FAIL', evidenceRef: 'qa:scenario:login-fail' }],
    findings: [{
      symptom: 'Login button does nothing',
      expected: 'Login request starts',
      steps: ['Open login', 'Press submit'],
      environment: 'Chromium fixture',
      evidenceRef: 'qa:failure:login',
    }],
  }), expected)
  assert.equal(failed.findings[0].symptom, 'Login button does nothing')
  const manual = validateQaObservation(observation({
    resultStatus: 'MANUAL_REQUIRED',
    scenarios: [{ scenarioId: 'visual', status: 'MANUAL_REQUIRED', manualSteps: ['Compare layout'] }],
    manualChecklist: ['Compare layout'],
  }), expected)
  assert.equal(manual.resultStatus, 'MANUAL_REQUIRED')
})

test('rejects false PASS, incomplete QaFinding, and terminal claims on RUNNING', () => {
  assert.throws(
    () => validateQaObservation(observation({
      scenarios: [{ scenarioId: 'login', status: 'FAIL', evidenceRef: 'qa:fail' }],
    }), expected),
    /PASS requires every scenario PASS/u,
  )
  assert.throws(
    () => validateQaObservation(observation({
      resultStatus: 'FAIL',
      scenarios: [{ scenarioId: 'login', status: 'FAIL', evidenceRef: 'qa:fail' }],
      findings: [],
    }), expected),
    /QaFinding input/u,
  )
  assert.throws(
    () => validateQaObservation(observation({ executionStatus: 'RUNNING' }), expected),
    /must not claim terminal/u,
  )
})

test('selects explicit adapters first, then verified kind priority, else manual fallback', () => {
  const noop = { name: 'qa-native', async start() {}, async resume() {} }
  const native = defineNativeQaAdapter(noop)
  const external = defineExternalSkillQaAdapter({ ...noop, name: 'qa-external' })
  const cli = { ...noop, name: 'qa-cli', kind: 'cli-api', verified: true }
  assert.equal(selectQaAdapter([native, cli, external]).adapter.name, 'qa-external')
  assert.equal(selectQaAdapter([external, native], 'qa-native').source, 'user-specified')
  assert.equal(selectQaAdapter([external], 'missing').source, 'manual-fallback')
  assert.equal(selectQaAdapter([]).source, 'manual-fallback')
  assert.throws(
    () => selectQaAdapter([{ ...cli, name: 'unverified', verified: false }]),
    /not verified/u,
  )
})
