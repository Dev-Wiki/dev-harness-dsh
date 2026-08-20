import assert from 'node:assert/strict'
import test from 'node:test'

import { validateFinalReconciliationObservation } from '../lib/index.js'

const expected = {
  runId: 'reconcile-1',
  repositoryRoot: '/repo',
  head: 'a'.repeat(40),
  branch: 'main',
  workspaceFingerprint: 'b'.repeat(64),
  contextFingerprint: 'c'.repeat(64),
  originalAuditRunId: 'audit-1',
  originalSnapshotRef: 'audit:snapshot:original',
  originalFindingIds: ['AUD-001', 'AUD-002'],
}

function observation(overrides = {}) {
  return {
    contractVersion: 1,
    runId: expected.runId,
    revision: 1,
    executionStatus: 'COMPLETED',
    repositoryRoot: expected.repositoryRoot,
    head: expected.head,
    branch: expected.branch,
    workspaceFingerprint: expected.workspaceFingerprint,
    contextFingerprint: expected.contextFingerprint,
    originalAuditRunId: expected.originalAuditRunId,
    originalSnapshotRef: expected.originalSnapshotRef,
    freshSnapshotRef: 'audit:snapshot:fresh',
    runRef: 'reconciliation:run:1',
    registryRef: 'docs/audit/Findings.md',
    reportRef: 'docs/audit/Report.md',
    startedAt: '2026-08-20T12:00:00.000Z',
    finishedAt: '2026-08-20T12:01:00.000Z',
    evidenceRef: 'docs/audit/Report.md#final-reconciliation',
    findings: [
      { findingId: 'AUD-001', status: 'resolved', evidenceRef: 'docs/audit/Findings.md#aud-001' },
      { findingId: 'AUD-002', status: 'remaining', evidenceRef: 'docs/audit/Findings.md#aud-002' },
    ],
    businessDirtyFiles: ['source.ts'],
    auditOutputs: [{ path: 'docs/audit/Findings.md', fingerprint: 'd'.repeat(64) }],
    workspaceVerified: true,
    quiescent: true,
    ...overrides,
  }
}

test('accepts a fresh exact reconciliation of original Finding identities', () => {
  const result = validateFinalReconciliationObservation(observation(), expected)
  assert.deepEqual(result.findings.map(finding => finding.status), ['resolved', 'remaining'])
  assert.equal(result.freshSnapshotRef, 'audit:snapshot:fresh')
})

test('rejects reused snapshots, missing identities, stale completion, and false terminal evidence', () => {
  assert.throws(
    () => validateFinalReconciliationObservation(observation({ freshSnapshotRef: expected.originalSnapshotRef }), expected),
    /fresh Audit snapshot/u,
  )
  assert.throws(
    () => validateFinalReconciliationObservation(observation({ findings: [observation().findings[0]] }), expected),
    /exact original Finding id set/u,
  )
  assert.throws(
    () => validateFinalReconciliationObservation(observation({
      findings: [
        { findingId: 'AUD-001', status: 'stale', evidenceRef: 'docs/audit/Findings.md#aud-001' },
        observation().findings[1],
      ],
    }), expected),
    /cannot contain stale/u,
  )
  assert.throws(
    () => validateFinalReconciliationObservation(observation({ executionStatus: 'RUNNING' }), expected),
    /must not claim terminal/u,
  )
})
