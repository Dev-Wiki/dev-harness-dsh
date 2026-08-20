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
  readonly sourceTaskRefs: readonly string[]
  readonly handoff?: AuditHandoff
}

export interface AuditTaskObservation {
  readonly taskId: string
  readonly status: 'pending' | 'in-progress' | 'needs-verification' | 'completed' | 'blocked' | 'stale'
  readonly resultRef?: string
}

export interface AuditOutputObservation {
  readonly path: string
  readonly fingerprint: string
}

export interface AuditObservation {
  readonly contractVersion: 1
  readonly runId: string
  readonly executionStatus: 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'CANCELLED'
  readonly status: 'ACTIVE' | 'COMPLETED' | 'STALE'
  readonly needsReverification: boolean
  readonly revision: number
  readonly repositoryRoot: string
  readonly baseSha: string
  readonly branch: string
  readonly contextFingerprint: string
  readonly scope: readonly string[]
  readonly snapshotRef: string
  readonly auditOutputRoot: string
  readonly registryRef: string
  readonly reportRef: string
  readonly dashboardRef: string
  readonly artifactsValidated: true
  readonly discoverabilityStatus: 'linked' | 'docs-refresh-required'
  readonly docsHandoffRef?: string
  readonly tasks: readonly AuditTaskObservation[]
  readonly crossModuleStatus: 'pending' | 'in-progress' | 'completed' | 'blocked'
  readonly crossModuleEvidenceRef?: string
  readonly workspaceVerified: true
  readonly quiescent: true
  readonly businessDirtyFiles: readonly string[]
  readonly auditOutputs: readonly AuditOutputObservation[]
  readonly findings: readonly AuditFindingObservation[]
}

export interface AuditRequest {
  readonly cwd: string
  readonly orchestrationRunId: string
  readonly auditRunId: string
  readonly expectedHead: string
  readonly expectedBranch: string
  readonly contextFingerprint: string
  readonly scope: readonly string[]
  readonly signal: AbortSignal
}

export interface AuditResumeRequest extends AuditRequest {
  readonly expectedRevision?: number
  readonly expectedSnapshotRef?: string
}

export interface AuditAdapter {
  readonly name: string
  /** Start must be idempotent for request.auditRunId so an OPEN lease can recover after a crash. */
  start(request: AuditRequest): Promise<AuditObservation>
  /** Resume must serialize one auditRunId and never move revision or snapshot identity backwards. */
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
  expected: {
    readonly runId?: string
    readonly repositoryRoot: string
    readonly head: string
    readonly branch: string
    readonly contextFingerprint: string
  },
): AuditObservation {
  const record = requireRecord(value, 'Audit observation')
  if (record.contractVersion !== 1) throw new AuditContractError('unsupported Audit contractVersion')
  const runId = requireString(record, 'runId')
  if (!AUDIT_RUN_ID.test(runId)) throw new AuditContractError('Audit runId has invalid syntax')
  if (expected.runId !== undefined && runId !== expected.runId) {
    throw new AuditContractError('Audit runId does not match the requested run')
  }
  const executionStatus = requireEnum(record, 'executionStatus', [
    'RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED',
  ] as const)
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
  const branch = requireString(record, 'branch')
  if (branch !== expected.branch) throw new AuditContractError('Audit branch does not match the orchestration snapshot')
  const contextFingerprint = requireString(record, 'contextFingerprint')
  if (contextFingerprint !== expected.contextFingerprint) {
    throw new AuditContractError('Audit Context fingerprint does not match the orchestration snapshot')
  }
  const scope = requireStringArray(record, 'scope')
  if (scope.length === 0) throw new AuditContractError('Audit scope must not be empty')
  const snapshotRef = requireString(record, 'snapshotRef')
  const registryRef = requireAuditPath(record, 'registryRef', 'Findings.md')
  const reportRef = requireAuditPath(record, 'reportRef', 'Report.md')
  const dashboardRef = requireAuditPath(record, 'dashboardRef', 'Dashboard.md')
  if (posix.dirname(registryRef) !== posix.dirname(reportRef)) {
    throw new AuditContractError('Audit Registry and Report must share one audit root')
  }
  if (posix.dirname(registryRef) !== posix.dirname(dashboardRef)) {
    throw new AuditContractError('Audit Dashboard must share the Registry audit root')
  }
  const auditOutputRoot = requireString(record, 'auditOutputRoot')
  if (auditOutputRoot !== posix.dirname(registryRef)) {
    throw new AuditContractError('Audit output root does not match artifact paths')
  }
  if (record.artifactsValidated !== true) throw new AuditContractError('Audit artifacts are not validated')
  const discoverabilityStatus = requireEnum(record, 'discoverabilityStatus', [
    'linked', 'docs-refresh-required',
  ] as const)
  const docsHandoffRef = optionalString(record, 'docsHandoffRef')
  if (discoverabilityStatus === 'docs-refresh-required' && docsHandoffRef === undefined) {
    throw new AuditContractError('docs-refresh-required Audit requires a Docs handoff ref')
  }
  const tasks = parseTasks(record.tasks, auditOutputRoot)
  const crossModuleStatus = requireEnum(record, 'crossModuleStatus', [
    'pending',
    'in-progress',
    'completed',
    'blocked',
  ] as const)
  const crossModuleEvidenceRef = optionalString(record, 'crossModuleEvidenceRef')
  if (crossModuleStatus === 'completed' && crossModuleEvidenceRef === undefined) {
    throw new AuditContractError('completed cross-module reconciliation requires an evidence ref')
  }
  if (record.workspaceVerified !== true || record.quiescent !== true) {
    throw new AuditContractError('Audit workspace must be verified and quiescent')
  }
  const businessDirtyFiles = requireStringArray(record, 'businessDirtyFiles')
  const auditOutputs = parseAuditOutputs(record.auditOutputs, auditOutputRoot)
  const rawFindings = record.findings
  if (!Array.isArray(rawFindings)) throw new AuditContractError('Audit findings must be an array')
  const seen = new Set<string>()
  const findings = rawFindings.map((finding, index) => {
    const parsed = parseFinding(finding, snapshotRef, `${registryRef}#`, auditOutputRoot, index)
    if (seen.has(parsed.id)) throw new AuditContractError(`duplicate Audit finding id: ${parsed.id}`)
    seen.add(parsed.id)
    return parsed
  })
  if (status === 'COMPLETED' && crossModuleStatus !== 'completed') {
    throw new AuditContractError('completed Audit requires completed cross-module reconciliation')
  }
  if (status === 'COMPLETED' && tasks.length === 0) {
    throw new AuditContractError('completed Audit requires task checkpoints')
  }
  if (status === 'COMPLETED' && tasks.some(task => !['completed', 'blocked'].includes(task.status))) {
    throw new AuditContractError('completed Audit contains unfinished tasks')
  }
  const hasBlockedTask = tasks.some(task => task.status === 'blocked')
  if (status === 'COMPLETED' && hasBlockedTask !== (executionStatus === 'BLOCKED')) {
    throw new AuditContractError('Audit execution status does not reflect blocked tasks')
  }
  if (status === 'COMPLETED' && !hasBlockedTask && executionStatus !== 'COMPLETED') {
    throw new AuditContractError('completed Audit must report completed execution')
  }
  if (status === 'COMPLETED' && needsReverification) {
    throw new AuditContractError('completed Audit cannot require reverification')
  }
  if (status === 'STALE' && !needsReverification) {
    throw new AuditContractError('stale Audit must require reverification')
  }
  return Object.freeze({
    contractVersion: 1,
    runId,
    executionStatus,
    status,
    needsReverification,
    revision,
    repositoryRoot,
    baseSha,
    branch,
    contextFingerprint,
    scope: Object.freeze(scope),
    snapshotRef,
    auditOutputRoot,
    registryRef,
    reportRef,
    dashboardRef,
    artifactsValidated: true,
    discoverabilityStatus,
    ...(docsHandoffRef === undefined ? {} : { docsHandoffRef }),
    tasks: Object.freeze(tasks),
    crossModuleStatus,
    ...(crossModuleEvidenceRef === undefined ? {} : { crossModuleEvidenceRef }),
    workspaceVerified: true,
    quiescent: true,
    businessDirtyFiles: Object.freeze(businessDirtyFiles),
    auditOutputs: Object.freeze(auditOutputs),
    findings: Object.freeze(findings),
  })
}

function parseFinding(
  value: unknown,
  snapshotRef: string,
  registryPrefix: string,
  auditRoot: string,
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
  const sourceTaskRefs = requireStringArray(record, 'sourceTaskRefs')
  if (sourceTaskRefs.some(ref => !ref.startsWith(`${auditRoot}/results/`))) {
    throw new AuditContractError(`Audit finding ${id} source Task ref escapes the result root`)
  }
  const severity = record.severity === undefined
    ? undefined
    : requireEnum(record, 'severity', ['P0', 'P1', 'P2', 'P3'] as const)
  const handoff = record.handoff === undefined ? undefined : parseHandoff(record.handoff, id)
  if (status === 'confirmed') {
    if (severity === undefined) throw new AuditContractError(`confirmed finding ${id} requires severity`)
    if (handoff === undefined) throw new AuditContractError(`confirmed finding ${id} requires an explicit handoff`)
    if (sourceTaskRefs.length === 0) throw new AuditContractError(`confirmed finding ${id} requires source Task refs`)
  }
  return Object.freeze({
    id,
    status,
    ...(severity === undefined ? {} : { severity }),
    snapshotRef: findingSnapshot,
    evidenceRef,
    sourceTaskRefs: Object.freeze(sourceTaskRefs),
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

function parseTasks(value: unknown, auditRoot: string): AuditTaskObservation[] {
  if (!Array.isArray(value)) throw new AuditContractError('Audit tasks must be an array')
  const seen = new Set<string>()
  return value.map((item, index) => {
    const record = requireRecord(item, `tasks[${index}]`)
    const taskId = requireString(record, 'taskId')
    if (!/^[A-Za-z0-9._-]+$/u.test(taskId) || seen.has(taskId)) {
      throw new AuditContractError(`invalid or duplicate Audit task id: ${taskId}`)
    }
    seen.add(taskId)
    const status = requireEnum(record, 'status', [
      'pending', 'in-progress', 'needs-verification', 'completed', 'blocked', 'stale',
    ] as const)
    const resultRef = optionalString(record, 'resultRef')
    if (resultRef !== undefined && !resultRef.startsWith(`${auditRoot}/results/`)) {
      throw new AuditContractError(`Audit task ${taskId} resultRef escapes the result root`)
    }
    return Object.freeze({ taskId, status, ...(resultRef === undefined ? {} : { resultRef }) })
  })
}

function parseAuditOutputs(value: unknown, auditRoot: string): AuditOutputObservation[] {
  if (!Array.isArray(value)) throw new AuditContractError('Audit outputs must be an array')
  const seen = new Set<string>()
  return value.map((item, index) => {
    const record = requireRecord(item, `auditOutputs[${index}]`)
    const path = requireString(record, 'path')
    if (!path.startsWith(`${auditRoot}/`) || path.includes('\\') || path.split('/').includes('..') || seen.has(path)) {
      throw new AuditContractError(`invalid or duplicate Audit output path: ${path}`)
    }
    seen.add(path)
    return Object.freeze({ path, fingerprint: requireString(record, 'fingerprint') })
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

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (record[key] === undefined) return undefined
  return requireString(record, key)
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new AuditContractError(`${key} must be an array of non-empty strings`)
  }
  return [...new Set(value as string[])]
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
