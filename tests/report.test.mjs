import assert from 'node:assert/strict'
import test from 'node:test'

import { createRunSummary, validateRunSummary } from '../lib/index.js'

function state(overrides = {}) {
  return {
    runId: 'summary-run',
    authorization: { schemaVersion: 1, autoFix: 'fix-only' },
    auditRunId: 'audit-summary',
    auditResult: { status: 'COMPLETED', executionStatus: 'COMPLETED', snapshotRef: 'audit:original', registryRef: 'docs/audit/Findings.md', reportRef: 'docs/audit/Report.md' },
    findings: [{ findingId: 'AUD-001', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect' }],
    fixRuns: [{ findingId: 'AUD-001', autoFixRunId: 'fix-1', status: 'DONE', executionRef: 'fix:execution:1', finalVerificationRef: 'fix:verify:1' }],
    commits: [],
    fullVerification: { executionStatus: 'COMPLETED', status: 'PASS', evidenceRef: 'verify:evidence:1', verificationRunId: 'verify-1', snapshotRef: 'verify:snapshot:1', runRef: 'verify:run:1' },
    qa: {
      currentAttempt: 1,
      runs: [{ attempt: 1, qaRunId: 'qa-1', adapterName: 'fixture-qa', executionStatus: 'COMPLETED', resultStatus: 'PASS', evidenceRef: 'qa:evidence:1' }],
      findings: [],
    },
    finalReconciliation: {
      executionStatus: 'COMPLETED',
      evidenceRef: 'reconcile:evidence:1',
      reconciliationRunId: 'reconcile-1',
      originalSnapshotRef: 'audit:original',
      freshSnapshotRef: 'audit:fresh',
      registryRef: 'docs/audit/Findings.md',
      reportRef: 'docs/audit/Report.md',
      findings: [{ findingId: 'AUD-001', status: 'resolved', evidenceRef: 'docs/audit/Findings.md#aud-001' }],
    },
    ...overrides,
  }
}

test('creates a traceable DONE summary from authoritative downstream references', () => {
  const summary = createRunSummary(state(), new Date('2026-08-20T12:00:00.000Z'))
  assert.equal(summary.overallStatus, 'DONE')
  assert.equal(summary.audit.runId, 'audit-summary')
  assert.equal(summary.remediation[0].runId, 'fix-1')
  assert.equal(summary.fullVerification.status, 'PASS')
  assert.equal(summary.qa.attempts[0].evidenceRef, 'qa:evidence:1')
  assert.equal(summary.finalReconciliation.freshSnapshotRef, 'audit:fresh')
  assert.deepEqual(validateRunSummary(summary, 'summary-run'), summary)
})

test('maps residual risks, remaining Findings, and non-fix handoffs to DONE_WITH_CONCERNS', () => {
  const input = state()
  input.findings.push({ findingId: 'AUD-002', status: 'confirmed', route: 'planning', handoffRef: 'handoff:planning' })
  input.fixRuns[0].status = 'DONE_WITH_CONCERNS'
  input.fixRuns[0].residualRiskRef = 'fix:risk:1'
  input.finalReconciliation.findings = [
    { findingId: 'AUD-001', status: 'remaining', evidenceRef: 'docs/audit/Findings.md#aud-001' },
    { findingId: 'AUD-002', status: 'resolved', evidenceRef: 'docs/audit/Findings.md#aud-002' },
  ]
  const summary = createRunSummary(input)
  assert.equal(summary.overallStatus, 'DONE_WITH_CONCERNS')
  assert.deepEqual(summary.residualRiskRefs, ['fix:risk:1'])
  assert.deepEqual(summary.remainingFindingRefs, ['docs/audit/Findings.md#aud-001'])
  assert.deepEqual(summary.manualActionRefs, ['handoff:planning'])
})

test('refuses incomplete QA, verification, reconciliation, and inconsistent overall claims', () => {
  assert.throws(() => createRunSummary(state({ fullVerification: undefined })), /Full Verification PASS/u)
  assert.throws(() => createRunSummary(state({ finalReconciliation: undefined })), /Final Reconciliation/u)
  const noQa = state()
  noQa.qa.runs[0].resultStatus = 'MANUAL_REQUIRED'
  assert.throws(() => createRunSummary(noQa), /authoritative QA PASS/u)
  const valid = createRunSummary(state())
  assert.throws(
    () => validateRunSummary({ ...valid, overallStatus: 'DONE_WITH_CONCERNS' }),
    /does not match concern/u,
  )
})
