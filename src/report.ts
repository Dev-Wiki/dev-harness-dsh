import type { RunState } from './state.js'

export const RUN_SUMMARY_CONTRACT_VERSION = 1 as const
export type SuccessfulOverallStatus = 'DONE' | 'DONE_WITH_CONCERNS'

export interface RunSummary {
  readonly contractVersion: typeof RUN_SUMMARY_CONTRACT_VERSION
  readonly runId: string
  readonly generatedAt: string
  readonly overallStatus: SuccessfulOverallStatus
  readonly authorizationRef: string
  readonly audit: {
    readonly runId: string
    readonly snapshotRef: string
    readonly registryRef: string
    readonly reportRef: string
    readonly confirmed: number
    readonly rejected: number
    readonly unresolved: number
  }
  readonly remediation: readonly {
    readonly findingId: string
    readonly runId: string
    readonly status: string
    readonly executionRef: string
    readonly finalVerificationRef?: string
    readonly residualRiskRef?: string
  }[]
  readonly commits: readonly {
    readonly sha: string
    readonly autoFixRunId: string
    readonly evidenceRef: string
  }[]
  readonly fullVerification: {
    readonly runId: string
    readonly snapshotRef: string
    readonly runRef: string
    readonly status: 'PASS'
    readonly evidenceRef: string
  }
  readonly qa: {
    readonly attempts: readonly {
      readonly attempt: number
      readonly runId: string
      readonly adapterName: string
      readonly resultStatus: string
      readonly evidenceRef: string
    }[]
    readonly findingRefs: readonly string[]
  }
  readonly finalReconciliation: {
    readonly runId: string
    readonly originalSnapshotRef: string
    readonly freshSnapshotRef: string
    readonly registryRef: string
    readonly reportRef: string
    readonly evidenceRef: string
    readonly resolved: number
    readonly remaining: number
    readonly rejected: number
  }
  readonly residualRiskRefs: readonly string[]
  readonly remainingFindingRefs: readonly string[]
  readonly manualActionRefs: readonly string[]
}

export class RunSummaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunSummaryError'
  }
}

export function createRunSummary(state: RunState, now: Date = new Date()): RunSummary {
  const audit = state.auditResult
  if (
    state.auditRunId === undefined
    || audit?.status !== 'COMPLETED'
    || audit.executionStatus !== 'COMPLETED'
  ) fail('Run Summary requires a completed initial Audit')
  const verification = state.fullVerification
  if (
    verification?.executionStatus !== 'COMPLETED'
    || verification.status !== 'PASS'
    || verification.evidenceRef === undefined
  ) fail('Run Summary requires a Full Verification PASS with evidence')
  const latestQa = state.qa.runs.find(run => run.attempt === state.qa.currentAttempt)
  if (
    latestQa?.executionStatus !== 'COMPLETED'
    || latestQa.resultStatus !== 'PASS'
    || latestQa.evidenceRef === undefined
  ) fail('Run Summary requires an authoritative QA PASS with evidence')
  if (state.qa.findings.some(finding => finding.status !== 'RESOLVED')) {
    fail('Run Summary cannot include unresolved QaFindings')
  }
  const reconciliation = state.finalReconciliation
  if (reconciliation?.executionStatus !== 'COMPLETED' || reconciliation.evidenceRef === undefined) {
    fail('Run Summary requires completed Final Reconciliation evidence')
  }
  if (reconciliation.findings.length !== state.findings.length) {
    fail('Run Summary requires exact reconciliation coverage')
  }
  const residualRiskRefs = unique(state.fixRuns.flatMap(run => run.residualRiskRef === undefined ? [] : [run.residualRiskRef]))
  const remainingFindingRefs = unique(reconciliation.findings
    .filter(finding => finding.status === 'remaining')
    .map(finding => finding.evidenceRef))
  const manualActionRefs = unique(state.findings.flatMap(finding =>
    finding.status === 'confirmed'
      && finding.route !== 'auto-fix'
      && finding.route !== 'closed'
      && finding.handoffRef !== undefined
      ? [finding.handoffRef]
      : []))
  const overallStatus: SuccessfulOverallStatus = (
    residualRiskRefs.length > 0 || remainingFindingRefs.length > 0 || manualActionRefs.length > 0
  ) ? 'DONE_WITH_CONCERNS' : 'DONE'
  const summary: RunSummary = {
    contractVersion: RUN_SUMMARY_CONTRACT_VERSION,
    runId: state.runId,
    generatedAt: now.toISOString(),
    overallStatus,
    authorizationRef: `run:${state.runId}:authorization:v${state.authorization.schemaVersion}`,
    audit: {
      runId: state.auditRunId,
      snapshotRef: audit.snapshotRef,
      registryRef: audit.registryRef,
      reportRef: audit.reportRef,
      confirmed: state.findings.filter(finding => finding.status === 'confirmed').length,
      rejected: state.findings.filter(finding => finding.status === 'rejected').length,
      unresolved: state.findings.filter(finding => ['candidate', 'needs-verification', 'stale'].includes(finding.status)).length,
    },
    remediation: state.fixRuns.map(run => ({
      findingId: run.findingId,
      runId: run.autoFixRunId,
      status: run.status,
      executionRef: run.executionRef,
      ...(run.finalVerificationRef === undefined ? {} : { finalVerificationRef: run.finalVerificationRef }),
      ...(run.residualRiskRef === undefined ? {} : { residualRiskRef: run.residualRiskRef }),
    })),
    commits: state.commits.map(commit => ({
      sha: commit.sha,
      autoFixRunId: commit.autoFixRunId,
      evidenceRef: commit.evidenceRef,
    })),
    fullVerification: {
      runId: verification.verificationRunId,
      snapshotRef: verification.snapshotRef,
      runRef: verification.runRef,
      status: 'PASS',
      evidenceRef: verification.evidenceRef,
    },
    qa: {
      attempts: state.qa.runs.map(run => {
        if (run.resultStatus === undefined || run.evidenceRef === undefined) {
          fail(`QA attempt ${run.attempt} has no terminal result evidence`)
        }
        return {
          attempt: run.attempt,
          runId: run.qaRunId,
          adapterName: run.adapterName,
          resultStatus: run.resultStatus,
          evidenceRef: run.evidenceRef,
        }
      }),
      findingRefs: state.qa.findings.map(finding => finding.findingRef),
    },
    finalReconciliation: {
      runId: reconciliation.reconciliationRunId,
      originalSnapshotRef: reconciliation.originalSnapshotRef,
      freshSnapshotRef: reconciliation.freshSnapshotRef,
      registryRef: reconciliation.registryRef,
      reportRef: reconciliation.reportRef,
      evidenceRef: reconciliation.evidenceRef,
      resolved: reconciliation.findings.filter(finding => finding.status === 'resolved').length,
      remaining: reconciliation.findings.filter(finding => finding.status === 'remaining').length,
      rejected: reconciliation.findings.filter(finding => finding.status === 'rejected').length,
    },
    residualRiskRefs,
    remainingFindingRefs,
    manualActionRefs,
  }
  return validateRunSummary(summary, state.runId)
}

export function validateRunSummary(value: unknown, expectedRunId?: string): RunSummary {
  const record = object(value, 'Run Summary')
  if (record.contractVersion !== RUN_SUMMARY_CONTRACT_VERSION) fail('unsupported Run Summary contractVersion')
  const runId = string(record, 'runId')
  if (expectedRunId !== undefined && runId !== expectedRunId) fail('Run Summary runId does not match state')
  const generatedAt = string(record, 'generatedAt')
  if (!Number.isFinite(Date.parse(generatedAt))) fail('generatedAt must be an ISO-compatible timestamp')
  const overallStatus = enumeration(record, 'overallStatus', ['DONE', 'DONE_WITH_CONCERNS'] as const)
  const authorizationRef = string(record, 'authorizationRef')
  const auditRecord = object(record.audit, 'audit')
  const remediation = objectArray(record.remediation, 'remediation').map(item => Object.freeze({
    findingId: string(item, 'findingId'),
    runId: string(item, 'runId'),
    status: string(item, 'status'),
    executionRef: string(item, 'executionRef'),
    ...(optionalString(item, 'finalVerificationRef') === undefined ? {} : { finalVerificationRef: optionalString(item, 'finalVerificationRef') }),
    ...(optionalString(item, 'residualRiskRef') === undefined ? {} : { residualRiskRef: optionalString(item, 'residualRiskRef') }),
  }))
  const commits = objectArray(record.commits, 'commits').map(item => Object.freeze({
    sha: string(item, 'sha'),
    autoFixRunId: string(item, 'autoFixRunId'),
    evidenceRef: string(item, 'evidenceRef'),
  }))
  const verification = object(record.fullVerification, 'fullVerification')
  if (verification.status !== 'PASS') fail('Run Summary Full Verification must be PASS')
  const qaRecord = object(record.qa, 'qa')
  const attempts = objectArray(qaRecord.attempts, 'qa.attempts').map(item => Object.freeze({
    attempt: integer(item, 'attempt'),
    runId: string(item, 'runId'),
    adapterName: string(item, 'adapterName'),
    resultStatus: string(item, 'resultStatus'),
    evidenceRef: string(item, 'evidenceRef'),
  }))
  const reconciliation = object(record.finalReconciliation, 'finalReconciliation')
  const residualRiskRefs = stringArray(record.residualRiskRefs, 'residualRiskRefs')
  const remainingFindingRefs = stringArray(record.remainingFindingRefs, 'remainingFindingRefs')
  const manualActionRefs = stringArray(record.manualActionRefs, 'manualActionRefs')
  const hasConcerns = residualRiskRefs.length > 0 || remainingFindingRefs.length > 0 || manualActionRefs.length > 0
  if ((overallStatus === 'DONE_WITH_CONCERNS') !== hasConcerns) fail('Overall status does not match concern references')
  return Object.freeze({
    contractVersion: RUN_SUMMARY_CONTRACT_VERSION,
    runId,
    generatedAt,
    overallStatus,
    authorizationRef,
    audit: Object.freeze({
      runId: string(auditRecord, 'runId'),
      snapshotRef: string(auditRecord, 'snapshotRef'),
      registryRef: string(auditRecord, 'registryRef'),
      reportRef: string(auditRecord, 'reportRef'),
      confirmed: integer(auditRecord, 'confirmed'),
      rejected: integer(auditRecord, 'rejected'),
      unresolved: integer(auditRecord, 'unresolved'),
    }),
    remediation: Object.freeze(remediation),
    commits: Object.freeze(commits),
    fullVerification: Object.freeze({
      runId: string(verification, 'runId'),
      snapshotRef: string(verification, 'snapshotRef'),
      runRef: string(verification, 'runRef'),
      status: 'PASS',
      evidenceRef: string(verification, 'evidenceRef'),
    }),
    qa: Object.freeze({ attempts: Object.freeze(attempts), findingRefs: stringArray(qaRecord.findingRefs, 'qa.findingRefs') }),
    finalReconciliation: Object.freeze({
      runId: string(reconciliation, 'runId'),
      originalSnapshotRef: string(reconciliation, 'originalSnapshotRef'),
      freshSnapshotRef: string(reconciliation, 'freshSnapshotRef'),
      registryRef: string(reconciliation, 'registryRef'),
      reportRef: string(reconciliation, 'reportRef'),
      evidenceRef: string(reconciliation, 'evidenceRef'),
      resolved: integer(reconciliation, 'resolved'),
      remaining: integer(reconciliation, 'remaining'),
      rejected: integer(reconciliation, 'rejected'),
    }),
    residualRiskRefs,
    remainingFindingRefs,
    manualActionRefs,
  })
}

export function assertRunSummaryMatchesState(summary: RunSummary, state: RunState): void {
  const expected = createRunSummary(state, new Date(summary.generatedAt))
  if (JSON.stringify(summary) !== JSON.stringify(expected)) fail('persisted Run Summary does not match authoritative state')
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort())
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function objectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value.map((item, index) => object(item, `${label}[${index}]`))
}

function string(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`)
  return value as string
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : string(record, key)
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

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail(`${label} must be an array of non-empty strings`)
  }
  if (new Set(value).size !== value.length) fail(`${label} must contain unique values`)
  return Object.freeze([...(value as string[])])
}

function fail(message: string): never {
  throw new RunSummaryError(message)
}
