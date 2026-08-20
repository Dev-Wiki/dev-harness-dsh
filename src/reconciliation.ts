import { isAbsolute, posix } from 'node:path'

export const FINAL_RECONCILIATION_CONTRACT_VERSION = 1 as const
export const RECONCILIATION_EXECUTION_STATUSES = ['RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'] as const
export const RECONCILIATION_FINDING_STATUSES = ['resolved', 'remaining', 'rejected', 'stale'] as const

export type ReconciliationExecutionStatus = typeof RECONCILIATION_EXECUTION_STATUSES[number]
export type ReconciliationFindingStatus = typeof RECONCILIATION_FINDING_STATUSES[number]

export interface FinalReconciliationRequest {
  readonly cwd: string
  readonly orchestrationRunId: string
  readonly reconciliationRunId: string
  readonly originalAuditRunId: string
  readonly originalSnapshotRef: string
  readonly originalFindingIds: readonly string[]
  readonly expectedHead: string
  readonly expectedBranch: string
  readonly expectedWorkspaceFingerprint: string
  readonly contextFingerprint: string
  readonly signal: AbortSignal
}

export interface FinalReconciliationResumeRequest extends FinalReconciliationRequest {
  readonly expectedRevision: number
  readonly expectedRunRef: string
  readonly expectedFreshSnapshotRef: string
}

export interface FinalReconciliationAdapter {
  readonly name: string
  start(request: FinalReconciliationRequest): Promise<unknown>
  resume(request: FinalReconciliationResumeRequest): Promise<unknown>
}

export interface ReconciledFindingObservation {
  readonly findingId: string
  readonly status: ReconciliationFindingStatus
  readonly evidenceRef: string
}

export interface FinalReconciliationObservation {
  readonly contractVersion: typeof FINAL_RECONCILIATION_CONTRACT_VERSION
  readonly runId: string
  readonly revision: number
  readonly executionStatus: ReconciliationExecutionStatus
  readonly repositoryRoot: string
  readonly head: string
  readonly branch: string
  readonly workspaceFingerprint: string
  readonly contextFingerprint: string
  readonly originalAuditRunId: string
  readonly originalSnapshotRef: string
  readonly freshSnapshotRef: string
  readonly runRef: string
  readonly registryRef: string
  readonly reportRef: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly evidenceRef?: string
  readonly blockerRef?: string
  readonly findings: readonly ReconciledFindingObservation[]
  readonly businessDirtyFiles: readonly string[]
  readonly auditOutputs: readonly { path: string; fingerprint: string }[]
  readonly workspaceVerified: true
  readonly quiescent: true
}

export class FinalReconciliationContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FinalReconciliationContractError'
  }
}

export function validateFinalReconciliationObservation(
  value: unknown,
  expected: {
    readonly runId: string
    readonly repositoryRoot: string
    readonly head: string
    readonly branch: string
    readonly workspaceFingerprint: string
    readonly contextFingerprint: string
    readonly originalAuditRunId: string
    readonly originalSnapshotRef: string
    readonly originalFindingIds: readonly string[]
  },
): FinalReconciliationObservation {
  const record = object(value, 'Final Reconciliation observation')
  if (record.contractVersion !== FINAL_RECONCILIATION_CONTRACT_VERSION) fail('unsupported contractVersion')
  exact(record, 'runId', expected.runId)
  exact(record, 'repositoryRoot', expected.repositoryRoot)
  exact(record, 'head', expected.head)
  exact(record, 'branch', expected.branch)
  exact(record, 'workspaceFingerprint', expected.workspaceFingerprint)
  exact(record, 'contextFingerprint', expected.contextFingerprint)
  exact(record, 'originalAuditRunId', expected.originalAuditRunId)
  exact(record, 'originalSnapshotRef', expected.originalSnapshotRef)
  const revision = integer(record, 'revision')
  const executionStatus = enumeration(record, 'executionStatus', RECONCILIATION_EXECUTION_STATUSES)
  const freshSnapshotRef = string(record, 'freshSnapshotRef')
  if (freshSnapshotRef === expected.originalSnapshotRef) fail('Final Reconciliation requires a fresh Audit snapshot')
  const runRef = string(record, 'runRef')
  const registryRef = auditPath(record, 'registryRef', 'Findings.md')
  const reportRef = auditPath(record, 'reportRef', 'Report.md')
  if (posix.dirname(registryRef) !== posix.dirname(reportRef)) fail('Registry and Report must share one Audit root')
  const startedAt = timestamp(record, 'startedAt')
  const finishedAt = optionalTimestamp(record, 'finishedAt')
  const evidenceRef = optionalString(record, 'evidenceRef')
  const blockerRef = optionalString(record, 'blockerRef')
  const findings = findingObservations(
    record.findings,
    executionStatus === 'COMPLETED' ? expected.originalFindingIds : [],
    registryRef,
  )
  const businessDirtyFiles = uniqueStrings(record.businessDirtyFiles, 'businessDirtyFiles')
  const auditOutputs = outputs(record.auditOutputs, posix.dirname(registryRef))
  if (record.workspaceVerified !== true || record.quiescent !== true) {
    fail('Final Reconciliation checkpoint must be workspaceVerified and quiescent')
  }
  if (executionStatus === 'RUNNING') {
    if (finishedAt !== undefined || evidenceRef !== undefined || blockerRef !== undefined || findings.length !== 0) {
      fail('RUNNING reconciliation must not claim terminal results')
    }
  } else if (executionStatus === 'COMPLETED') {
    if (finishedAt === undefined || evidenceRef === undefined || blockerRef !== undefined) {
      fail('COMPLETED reconciliation requires finishedAt and evidenceRef')
    }
    if (findings.some(finding => finding.status === 'stale')) {
      fail('COMPLETED reconciliation cannot contain stale original Findings')
    }
  } else if (executionStatus === 'BLOCKED') {
    if (finishedAt === undefined || blockerRef === undefined) fail('BLOCKED reconciliation requires finishedAt and blockerRef')
  } else if (executionStatus === 'FAILED') {
    if (finishedAt === undefined || evidenceRef === undefined) fail('FAILED reconciliation requires finishedAt and evidenceRef')
  } else if (finishedAt !== undefined || evidenceRef !== undefined || blockerRef !== undefined || findings.length !== 0) {
    fail('CANCELLED reconciliation must not claim terminal results')
  }
  if (finishedAt !== undefined && Date.parse(finishedAt) < Date.parse(startedAt)) fail('finishedAt cannot precede startedAt')
  return Object.freeze({
    contractVersion: FINAL_RECONCILIATION_CONTRACT_VERSION,
    runId: expected.runId,
    revision,
    executionStatus,
    repositoryRoot: expected.repositoryRoot,
    head: expected.head,
    branch: expected.branch,
    workspaceFingerprint: expected.workspaceFingerprint,
    contextFingerprint: expected.contextFingerprint,
    originalAuditRunId: expected.originalAuditRunId,
    originalSnapshotRef: expected.originalSnapshotRef,
    freshSnapshotRef,
    runRef,
    registryRef,
    reportRef,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
    ...(blockerRef === undefined ? {} : { blockerRef }),
    findings,
    businessDirtyFiles,
    auditOutputs,
    workspaceVerified: true,
    quiescent: true,
  })
}

function findingObservations(
  value: unknown,
  expectedIds: readonly string[],
  registryRef: string,
): readonly ReconciledFindingObservation[] {
  const findings = array(value, 'findings').map((item, index) => {
    const record = object(item, `findings[${index}]`)
    const findingId = string(record, 'findingId')
    const status = enumeration(record, 'status', RECONCILIATION_FINDING_STATUSES)
    const evidenceRef = string(record, 'evidenceRef')
    if (!evidenceRef.startsWith(`${registryRef}#`)) fail(`${findingId} evidenceRef must point into the Audit Registry`)
    return Object.freeze({ findingId, status, evidenceRef })
  })
  const actual = findings.map(finding => finding.findingId).sort()
  const expected = [...expectedIds].sort()
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('Final Reconciliation must cover the exact original Finding id set')
  }
  return Object.freeze(findings)
}

function outputs(value: unknown, auditRoot: string): readonly { path: string; fingerprint: string }[] {
  const items = array(value, 'auditOutputs').map((item, index) => {
    const record = object(item, `auditOutputs[${index}]`)
    const path = string(record, 'path')
    if (!path.startsWith(`${auditRoot}/`) || path.includes('\\') || path.split('/').includes('..')) {
      fail(`invalid Audit output path: ${path}`)
    }
    return Object.freeze({ path, fingerprint: string(record, 'fingerprint') })
  })
  if (new Set(items.map(item => item.path)).size !== items.length) fail('Audit output paths must be unique')
  return Object.freeze(items)
}

function auditPath(record: Record<string, unknown>, key: string, basename: string): string {
  const value = string(record, key)
  if (isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) fail(`${key} must be repository-relative`)
  const normalized = posix.normalize(value)
  const parts = normalized.split('/')
  if (!['doc', 'docs'].includes(parts[0] ?? '') || parts[1] !== 'audit' || posix.basename(normalized) !== basename) {
    fail(`${key} must identify ${basename} below doc/audit or docs/audit`)
  }
  return normalized
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value as unknown[]
}

function string(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`)
  return value as string
}

function exact(record: Record<string, unknown>, key: string, expected: string): void {
  if (string(record, key) !== expected) fail(`${key} does not match the reconciliation request`)
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${key} must be an integer >= 0`)
  return value as number
}

function enumeration<const T extends readonly string[]>(record: Record<string, unknown>, key: string, values: T): T[number] {
  const value = string(record, key)
  if (!(values as readonly string[]).includes(value)) fail(`unknown ${key}: ${value}`)
  return value as T[number]
}

function uniqueStrings(value: unknown, label: string): readonly string[] {
  const items = array(value, label).map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) fail(`${label}[${index}] must be a non-empty string`)
    return item as string
  })
  if (new Set(items).size !== items.length) fail(`${label} must contain unique values`)
  return Object.freeze(items)
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : string(record, key)
}

function timestamp(record: Record<string, unknown>, key: string): string {
  const value = string(record, key)
  if (!Number.isFinite(Date.parse(value))) fail(`${key} must be an ISO-compatible timestamp`)
  return value
}

function optionalTimestamp(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : timestamp(record, key)
}

function fail(message: string): never {
  throw new FinalReconciliationContractError(message)
}
