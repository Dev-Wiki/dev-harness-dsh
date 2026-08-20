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

function observation(overrides = {}) {
  return {
    runId: 'audit-1',
    status: 'COMPLETED',
    needsReverification: false,
    revision: 7,
    repositoryRoot: root,
    baseSha: head,
    snapshotRef: 'snapshot-current',
    registryRef: 'docs/audit/Findings.md',
    reportRef: 'docs/audit/Report.md',
    crossModuleStatus: 'completed',
    findings: [
      {
        id: 'AUD-001',
        status: 'confirmed',
        severity: 'P1',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-001',
        handoff: { target: 'dev-harness-auto-fix', ref: 'handoff:defect-1' },
      },
      {
        id: 'AUD-002',
        status: 'confirmed',
        severity: 'P2',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-002',
        handoff: { target: 'dev-harness-planning', ref: 'handoff:architecture-2' },
      },
      {
        id: 'AUD-003',
        status: 'needs-verification',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-003',
      },
      {
        id: 'AUD-004',
        status: 'rejected',
        snapshotRef: 'snapshot-current',
        evidenceRef: 'docs/audit/Findings.md#aud-004',
      },
    ],
    ...overrides,
  }
}

test('validates a completed Audit snapshot and routes only confirmed defects to Auto Fix', () => {
  const parsed = validateAuditObservation(observation(), { repositoryRoot: root, head })
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
      () => validateAuditObservation(value, { repositoryRoot: root, head }),
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
      () => validateAuditObservation(value, { repositoryRoot: root, head }),
      AuditContractError,
    )
  }
})

test('router refuses active or reverification-required Audit observations', () => {
  const active = validateAuditObservation(observation({
    status: 'ACTIVE',
    crossModuleStatus: 'in-progress',
  }), { repositoryRoot: root, head })
  assert.throws(() => routeAuditFindings(active), FindingRouterError)

  const stale = validateAuditObservation(observation({
    status: 'STALE',
    needsReverification: true,
  }), { repositoryRoot: root, head })
  assert.throws(() => routeAuditFindings(stale), FindingRouterError)
})
