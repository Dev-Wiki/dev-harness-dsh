import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AuditContractError,
  FindingRouterError,
  routeAuditFindings,
  validateAuditObservation,
} from '../lib/index.js'

const root = '/work/repository'
const head = 'opaque-head'
const expected = {
  repositoryRoot: root,
  head,
  branch: 'main',
  contextFingerprint: 'context-current',
}

function observation(overrides = {}) {
  return {
    contractVersion: 1,
    runId: 'audit-1',
    executionStatus: 'COMPLETED',
    status: 'COMPLETED',
    needsReverification: false,
    revision: 7,
    repositoryRoot: root,
    baseSha: head,
    branch: 'main',
    contextFingerprint: 'context-current',
    scope: ['repository'],
    snapshotRef: 'snapshot-current',
    auditOutputRoot: 'docs/audit',
    registryRef: 'docs/audit/Findings.md',
    reportRef: 'docs/audit/Report.md',
    dashboardRef: 'docs/audit/Dashboard.md',
    artifactsValidated: true,
    discoverabilityStatus: 'linked',
    tasks: [{ taskId: 'A01', status: 'completed', resultRef: 'docs/audit/results/A01.md' }],
    crossModuleStatus: 'completed',
    crossModuleEvidenceRef: 'docs/audit/Report.md#cross-module-findings',
    workspaceVerified: true,
    quiescent: true,
    businessDirtyFiles: [],
    auditOutputs: [
      { path: 'docs/audit/Dashboard.md', fingerprint: 'dashboard-hash' },
      { path: 'docs/audit/Findings.md', fingerprint: 'findings-hash' },
      { path: 'docs/audit/Report.md', fingerprint: 'report-hash' },
      { path: 'docs/audit/results/A01.md', fingerprint: 'result-hash' },
    ],
    findings: [
      {
        id: 'AUD-001',
        status: 'confirmed',
        severity: 'P1',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-001',
        sourceTaskRefs: ['docs/audit/results/A01.md'],
        handoff: { target: 'dev-harness-auto-fix', ref: 'handoff:defect-1' },
      },
      {
        id: 'AUD-002',
        status: 'confirmed',
        severity: 'P2',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-002',
        sourceTaskRefs: ['docs/audit/results/A01.md'],
        handoff: { target: 'dev-harness-planning', ref: 'handoff:architecture-2' },
      },
      {
        id: 'AUD-003',
        status: 'needs-verification',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-003',
        sourceTaskRefs: ['docs/audit/results/A01.md'],
      },
      {
        id: 'AUD-004',
        status: 'rejected',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-004',
        sourceTaskRefs: ['docs/audit/results/A01.md'],
      },
    ],
    ...overrides,
  }
}

test('validates a completed Audit snapshot and routes only confirmed defects to Auto Fix', () => {
  const parsed = validateAuditObservation(observation(), expected)
  const routed = routeAuditFindings(parsed)

  assert.equal(Object.isFrozen(parsed), true)
  assert.deepEqual(routed.findings, [
    { findingId: 'AUD-001', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect-1' },
    { findingId: 'AUD-002', status: 'confirmed', route: 'planning', handoffRef: 'handoff:architecture-2' },
    { findingId: 'AUD-003', status: 'needs-verification', route: 'unresolved' },
    { findingId: 'AUD-004', status: 'rejected', route: 'closed' },
  ])
  assert.deepEqual(routed.confirmedDefects, [routed.findings[0]])
})

test('rejects stale identity, incomplete reconciliation, duplicate ids, and stale snapshots', () => {
  const cases = [
    observation({ repositoryRoot: '/another/repository' }),
    observation({ baseSha: 'another-head' }),
    observation({ crossModuleStatus: 'blocked' }),
    observation({ findings: [observation().findings[0], observation().findings[0]] }),
    observation({ findings: [{ ...observation().findings[0], snapshotRef: 'old-snapshot' }] }),
  ]
  for (const value of cases) {
    assert.throws(
      () => validateAuditObservation(value, expected),
      AuditContractError,
    )
  }
})

test('rejects unknown paths, handoffs, and incomplete confirmed Findings', () => {
  const invalid = [
    observation({ registryRef: '../Findings.md' }),
    observation({ reportRef: 'docs/audit/nested/Report.md' }),
    observation({ findings: [{ ...observation().findings[0], severity: undefined }] }),
    observation({ findings: [{ ...observation().findings[0], handoff: undefined }] }),
    observation({ findings: [{
      ...observation().findings[0],
      handoff: { target: 'unknown-skill', ref: 'handoff:bad' },
    }] }),
  ]
  for (const value of invalid) {
    assert.throws(
      () => validateAuditObservation(value, expected),
      AuditContractError,
    )
  }
})

test('router refuses active or reverification-required Audit observations', () => {
  const active = validateAuditObservation(observation({
    status: 'ACTIVE',
    executionStatus: 'RUNNING',
    tasks: [{ taskId: 'A01', status: 'in-progress' }],
    crossModuleStatus: 'in-progress',
    crossModuleEvidenceRef: undefined,
  }), expected)
  assert.throws(() => routeAuditFindings(active), FindingRouterError)

  const stale = validateAuditObservation(observation({
    status: 'STALE',
    executionStatus: 'BLOCKED',
    needsReverification: true,
  }), expected)
  assert.throws(() => routeAuditFindings(stale), FindingRouterError)
})
