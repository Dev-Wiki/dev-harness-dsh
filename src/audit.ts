import { isAbsolute, posix } from 'node:path'

const AUDIT_RUN_ID = /^[A-Za-z0-9._-]+$/u
const FINDING_ID = /^AUD-[0-9]{3,}$/u

export const AUDIT_FINDING_STATUSES = [
  'candidate',
  'needs-verification',
  'confirmed',
  'rejected',
  'stale',
  'resolved',
] as const

export type AuditFindingStatus = typeof AUDIT_FINDING_STATUSES[number]

export const AUDIT_HANDOFF_TARGETS = [
  'dev-harness-auto-fix',
  'dev-harness-planning',
  'dev-harness-docs',
  'dev-harness-commands',
  'dev-harness-git-workflow',
  'manual',
] as const

export type AuditHandoffTarget = typeof AUDIT_HANDOFF_TARGETS[number]

export interface AuditHandoff {
  readonly target: AuditHandoffTarget
  readonly ref: string
}

export interface AuditFindingObservation {
  readonly id: string
  readonly status: AuditFindingStatus
  readonly severity?: 'P0' | 'P1' | 'P2' | 'P3'
  readonly snapshotRef: string
  readonly evidenceRef: string
  readonly handoff?: AuditHandoff
}

export interface AuditObservation {
  readonly runId: string
  readonly status: 'ACTIVE' | 'COMPLETED' | 'STALE'
  readonly needsReverification: boolean
  readonly revision: number
  readonly repositoryRoot: string
  readonly baseSha: string
  readonly snapshotRef: string
  readonly registryRef: string
  readonly reportRef: string
  readonly crossModuleStatus: 'pending' | 'in-progress' | 'completed' | 'blocked'
  readonly findings: readonly AuditFindingObservation[]
}

export interface AuditRequest {
  readonly cwd: string
  readonly orchestrationRunId: string
  readonly expectedHead: string
  readonly signal: AbortSignal
}

export interface AuditResumeRequest extends AuditRequest {
  readonly auditRunId: string
  readonly expectedRevision: number
  readonly expectedSnapshotRef: string
}

export interface AuditAdapter {
  readonly name: string
  start(request: AuditRequest): Promise<AuditObservation>
  resume(request: AuditResumeRequest): Promise<AuditObservation>
}

export class AuditContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuditContractError'
  }
}

export function validateAuditObservation(
  value: unknown,
  expected: { readonly repositoryRoot: string; readonly head: string },
): AuditObservation {
  const record = requireRecord(value, 'Audit observation')
  const runId = requireString(record, 'runId')
  if (!AUDIT_RUN_ID.test(runId)) throw new AuditContractError('Audit runId has invalid syntax')
  const status = requireEnum(record, 'status', ['ACTIVE', 'COMPLETED', 'STALE'] as const)
  const needsReverification = requireBoolean(record, 'needsReverification')
  const revision = requireInteger(record, 'revision')
  const repositoryRoot = requireString(record, 'repositoryRoot')
  if (repositoryRoot !== expected.repositoryRoot) {
    throw new AuditContractError('Audit repository root does not match the orchestration worktree')
  }
  const baseSha = requireString(record, 'baseSha')
  if (baseSha !== expected.head) {
    throw new AuditContractError('Audit base SHA does not match the orchestration snapshot')
  }
  const snapshotRef = requireString(record, 'snapshotRef')
  const registryRef = requireAuditPath(record, 'registryRef', 'Findings.md')
  const reportRef = requireAuditPath(record, 'reportRef', 'Report.md')
  if (posix.dirname(registryRef) !== posix.dirname(reportRef)) {
    throw new AuditContractError('Audit Registry and Report must share one audit root')
  }
  const crossModuleStatus = requireEnum(record, 'crossModuleStatus', [
    'pending',
    'in-progress',
    'completed',
    'blocked',
  ] as const)
  const rawFindings = record.findings
  if (!Array.isArray(rawFindings)) throw new AuditContractError('Audit findings must be an array')
  const seen = new Set<string>()
  const findings = rawFindings.map((finding, index) => {
    const parsed = parseFinding(finding, snapshotRef, `${registryRef}#`, index)
    if (seen.has(parsed.id)) throw new AuditContractError(`duplicate Audit finding id: ${parsed.id}`)
    seen.add(parsed.id)
    return parsed
  })
  if (status === 'COMPLETED' && crossModuleStatus !== 'completed') {
    throw new AuditContractError('completed Audit requires completed cross-module reconciliation')
  }
  if (status === 'COMPLETED' && needsReverification) {
    throw new AuditContractError('completed Audit cannot require reverification')
  }
  if (status === 'STALE' && !needsReverification) {
    throw new AuditContractError('stale Audit must require reverification')
  }
  return Object.freeze({
    runId,
    status,
    needsReverification,
    revision,
    repositoryRoot,
    baseSha,
    snapshotRef,
    registryRef,
    reportRef,
    crossModuleStatus,
    findings: Object.freeze(findings),
  })
}

function parseFinding(
  value: unknown,
  snapshotRef: string,
  registryPrefix: string,
  index: number,
): AuditFindingObservation {
  const record = requireRecord(value, `findings[${index}]`)
  const id = requireString(record, 'id')
  if (!FINDING_ID.test(id)) throw new AuditContractError(`invalid Audit finding id: ${id}`)
  const status = requireEnum(record, 'status', AUDIT_FINDING_STATUSES)
  const findingSnapshot = requireString(record, 'snapshotRef')
  if (findingSnapshot !== snapshotRef) {
    throw new AuditContractError(`Audit finding ${id} is not bound to the current snapshot`)
  }
  const evidenceRef = requireString(record, 'evidenceRef')
  if (!evidenceRef.startsWith(registryPrefix)) {
    throw new AuditContractError(`Audit finding ${id} evidenceRef must point into the Registry`)
  }
  const severity = record.severity === undefined
    ? undefined
    : requireEnum(record, 'severity', ['P0', 'P1', 'P2', 'P3'] as const)
  const handoff = record.handoff === undefined ? undefined : parseHandoff(record.handoff, id)
  if (status === 'confirmed') {
    if (severity === undefined) throw new AuditContractError(`confirmed finding ${id} requires severity`)
    if (handoff === undefined) throw new AuditContractError(`confirmed finding ${id} requires an explicit handoff`)
  }
  return Object.freeze({
    id,
    status,
    ...(severity === undefined ? {} : { severity }),
    snapshotRef: findingSnapshot,
    evidenceRef,
    ...(handoff === undefined ? {} : { handoff }),
  })
}

function parseHandoff(value: unknown, findingId: string): AuditHandoff {
  const record = requireRecord(value, `${findingId}.handoff`)
  return Object.freeze({
    target: requireEnum(record, 'target', AUDIT_HANDOFF_TARGETS),
    ref: requireString(record, 'ref'),
  })
}

function requireAuditPath(record: Record<string, unknown>, key: string, basename: string): string {
  const value = requireString(record, key)
  if (value.includes('\\') || isAbsolute(value) || value.split('/').includes('..')) {
    throw new AuditContractError(`${key} must be a repository-relative POSIX path`)
  }
  const normalized = posix.normalize(value)
  const parts = normalized.split('/')
  if (!['doc', 'docs'].includes(parts[0] ?? '') || parts[1] !== 'audit' || posix.basename(normalized) !== basename) {
    throw new AuditContractError(`${key} must identify ${basename} below doc/audit or docs/audit`)
  }
  return normalized
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuditContractError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new AuditContractError(`${key} must be a non-empty string`)
  return value
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new AuditContractError(`${key} must be a boolean`)
  return value
}

function requireInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AuditContractError(`${key} must be a non-negative safe integer`)
  }
  return value as number
}

function requireEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  allowed: T,
): T[number] {
  const value = requireString(record, key)
  if (!allowed.includes(value)) throw new AuditContractError(`${key} has an unknown value: ${value}`)
  return value as T[number]
}
