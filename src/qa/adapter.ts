import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const QA_CONTRACT_VERSION = 1 as const
export const QA_ADAPTER_KINDS = ['external-skill', 'native-agent', 'cli-api'] as const
export type QaAdapterKind = typeof QA_ADAPTER_KINDS[number]

export const QA_EXECUTION_STATUSES = ['RUNNING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'] as const
export type QaExecutionStatus = typeof QA_EXECUTION_STATUSES[number]

export const QA_RESULT_STATUSES = ['PASS', 'FAIL', 'MANUAL_REQUIRED'] as const
export type QaResultStatus = typeof QA_RESULT_STATUSES[number]

const QA_EVIDENCE_REF_PATTERN = /^[a-z][a-z0-9+.-]*:[^\s]+$/u

/**
 * Validates a QA Adapter verification evidence reference.
 *
 * The reference must be a URI-form string (for example 'qa:...', 'https://...'
 * or 'file:///...'). A 'file:' reference must resolve to an existing regular
 * file when requireExistingFile is set, so 'verified' claims are at least
 * anchored to a concrete artifact instead of an arbitrary string.
 */
export function assertQaAdapterEvidenceRef(
  value: unknown,
  options: { readonly requireExistingFile?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('QA Adapter verification evidence reference must be a non-empty string')
  }
  if (!QA_EVIDENCE_REF_PATTERN.test(value)) {
    throw new TypeError(`QA Adapter verification evidence reference must be a URI reference: ${value}`)
  }
  if (options.requireExistingFile === true && value.startsWith('file:')) {
    let path: string
    try {
      path = fileURLToPath(value)
    } catch {
      throw new TypeError(`QA Adapter verification evidence reference is not a valid file URL: ${value}`)
    }
    if (!existsSync(path)) {
      throw new TypeError(`QA Adapter verification evidence file does not exist: ${path}`)
    }
  }
  return value
}

export const QA_SCENARIO_STATUSES = ['PASS', 'FAIL', 'MANUAL_REQUIRED', 'BLOCKED'] as const
export type QaScenarioStatus = typeof QA_SCENARIO_STATUSES[number]

export interface QaStartRequest {
  readonly cwd: string
  readonly orchestrationRunId: string
  readonly qaRunId: string
  readonly attempt: number
  readonly verificationRunId: string
  readonly verificationSnapshotRef: string
  readonly expectedHead: string
  readonly expectedBranch: string
  readonly expectedWorkspaceFingerprint: string
  readonly signal: AbortSignal
}

export interface QaResumeRequest extends QaStartRequest {
  readonly expectedRevision: number
  readonly expectedRunRef: string
}

export interface QaAdapter {
  readonly name: string
  readonly kind: QaAdapterKind
  readonly verified: true
  readonly verificationEvidenceRef: string
  start(request: QaStartRequest): Promise<unknown>
  resume(request: QaResumeRequest): Promise<unknown>
}

export interface QaScenarioObservation {
  readonly scenarioId: string
  readonly status: QaScenarioStatus
  readonly evidenceRef?: string
  readonly manualSteps?: readonly string[]
}

export interface QaFindingInput {
  readonly symptom: string
  readonly expected: string
  readonly steps: readonly string[]
  readonly environment: string
  readonly evidenceRef: string
}

export interface QaObservation {
  readonly contractVersion: typeof QA_CONTRACT_VERSION
  readonly runId: string
  readonly attempt: number
  readonly revision: number
  readonly adapterName: string
  readonly adapterKind: QaAdapterKind
  readonly adapterVerificationEvidenceRef: string
  readonly executionStatus: QaExecutionStatus
  readonly resultStatus?: QaResultStatus
  readonly repositoryRoot: string
  readonly head: string
  readonly branch: string
  readonly workspaceFingerprint: string
  readonly verificationRunId: string
  readonly verificationSnapshotRef: string
  readonly runRef: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly evidenceRef?: string
  readonly blockerRef?: string
  readonly scenarios: readonly QaScenarioObservation[]
  readonly findings: readonly QaFindingInput[]
  readonly manualChecklist: readonly string[]
  readonly workspaceVerified: true
  readonly quiescent: true
}

export class QaContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QaContractError'
  }
}

export function validateQaObservation(
  value: unknown,
  expected: {
    readonly runId: string
    readonly attempt: number
    readonly adapterName: string
    readonly adapterKind: QaAdapterKind
    readonly adapterVerificationEvidenceRef: string
    readonly repositoryRoot: string
    readonly head: string
    readonly branch: string
    readonly workspaceFingerprint: string
    readonly verificationRunId: string
    readonly verificationSnapshotRef: string
  },
): QaObservation {
  const record = requireRecord(value, 'QA observation')
  if (record.contractVersion !== QA_CONTRACT_VERSION) fail('unsupported contractVersion')
  exact(record, 'runId', expected.runId)
  exactInteger(record, 'attempt', expected.attempt)
  exact(record, 'adapterName', expected.adapterName)
  exact(record, 'adapterKind', expected.adapterKind)
  exact(record, 'adapterVerificationEvidenceRef', expected.adapterVerificationEvidenceRef)
  exact(record, 'repositoryRoot', expected.repositoryRoot)
  exact(record, 'head', expected.head)
  exact(record, 'branch', expected.branch)
  exact(record, 'workspaceFingerprint', expected.workspaceFingerprint)
  exact(record, 'verificationRunId', expected.verificationRunId)
  exact(record, 'verificationSnapshotRef', expected.verificationSnapshotRef)
  const revision = integer(record, 'revision')
  const executionStatus = enumeration(record, 'executionStatus', QA_EXECUTION_STATUSES)
  const resultStatus = optionalEnumeration(record, 'resultStatus', QA_RESULT_STATUSES)
  const runRef = string(record, 'runRef')
  const startedAt = timestamp(record, 'startedAt')
  const finishedAt = optionalTimestamp(record, 'finishedAt')
  const evidenceRef = optionalString(record, 'evidenceRef')
  const blockerRef = optionalString(record, 'blockerRef')
  const scenarios = parseScenarios(record.scenarios)
  const findings = parseFindings(record.findings)
  const manualChecklist = stringArray(record.manualChecklist, 'manualChecklist')
  if (record.workspaceVerified !== true || record.quiescent !== true) {
    fail('QA checkpoint must be workspaceVerified and quiescent')
  }

  if (executionStatus === 'RUNNING') {
    if (
      resultStatus !== undefined
      || finishedAt !== undefined
      || evidenceRef !== undefined
      || blockerRef !== undefined
      || scenarios.length !== 0
      || findings.length !== 0
      || manualChecklist.length !== 0
    ) fail('RUNNING QA must not claim terminal results')
  } else if (executionStatus === 'COMPLETED') {
    if (resultStatus === undefined || finishedAt === undefined || evidenceRef === undefined) {
      fail('COMPLETED QA requires resultStatus, finishedAt, and evidenceRef')
    }
    if (scenarios.length === 0) fail('COMPLETED QA requires at least one scenario')
    if (resultStatus === 'PASS') {
      if (scenarios.some(item => item.status !== 'PASS') || findings.length !== 0 || manualChecklist.length !== 0) {
        fail('PASS requires every scenario PASS and no findings or manual checklist')
      }
    } else if (resultStatus === 'FAIL') {
      if (!scenarios.some(item => item.status === 'FAIL') || findings.length === 0 || manualChecklist.length !== 0) {
        fail('FAIL requires a failed scenario and QaFinding input')
      }
    } else if (
      !scenarios.some(item => item.status === 'MANUAL_REQUIRED')
      || manualChecklist.length === 0
      || findings.length !== 0
    ) {
      fail('MANUAL_REQUIRED requires manual scenarios and a checklist')
    }
  } else if (executionStatus === 'BLOCKED') {
    if (resultStatus !== undefined || blockerRef === undefined || finishedAt === undefined) {
      fail('BLOCKED QA requires blockerRef and finishedAt without resultStatus')
    }
  } else if (executionStatus === 'FAILED') {
    if (resultStatus !== undefined || evidenceRef === undefined || finishedAt === undefined) {
      fail('FAILED QA requires evidenceRef and finishedAt without resultStatus')
    }
  } else if (resultStatus !== undefined) {
    fail('CANCELLED QA must not claim a result')
  }
  if (finishedAt !== undefined && Date.parse(finishedAt) < Date.parse(startedAt)) {
    fail('finishedAt cannot precede startedAt')
  }

  return Object.freeze({
    contractVersion: QA_CONTRACT_VERSION,
    runId: expected.runId,
    attempt: expected.attempt,
    revision,
    adapterName: expected.adapterName,
    adapterKind: expected.adapterKind,
    adapterVerificationEvidenceRef: expected.adapterVerificationEvidenceRef,
    executionStatus,
    ...(resultStatus === undefined ? {} : { resultStatus }),
    repositoryRoot: expected.repositoryRoot,
    head: expected.head,
    branch: expected.branch,
    workspaceFingerprint: expected.workspaceFingerprint,
    verificationRunId: expected.verificationRunId,
    verificationSnapshotRef: expected.verificationSnapshotRef,
    runRef,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
    ...(blockerRef === undefined ? {} : { blockerRef }),
    scenarios,
    findings,
    manualChecklist,
    workspaceVerified: true,
    quiescent: true,
  })
}

function parseScenarios(value: unknown): readonly QaScenarioObservation[] {
  const scenarios = array(value, 'scenarios').map((item, index) => {
    const record = requireRecord(item, `scenarios[${index}]`)
    const scenarioId = string(record, 'scenarioId')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(scenarioId)) fail(`invalid scenarioId: ${scenarioId}`)
    const status = enumeration(record, 'status', QA_SCENARIO_STATUSES)
    const evidenceRef = optionalString(record, 'evidenceRef')
    const manualSteps = record.manualSteps === undefined
      ? undefined
      : stringArray(record.manualSteps, `scenarios[${index}].manualSteps`)
    if (status === 'PASS' || status === 'FAIL') {
      if (evidenceRef === undefined || manualSteps !== undefined) fail(`${status} scenario requires evidence only`)
    } else if (status === 'MANUAL_REQUIRED') {
      if (manualSteps === undefined || manualSteps.length === 0) fail('MANUAL_REQUIRED scenario requires manualSteps')
    }
    return Object.freeze({
      scenarioId,
      status,
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
      ...(manualSteps === undefined ? {} : { manualSteps }),
    })
  })
  if (new Set(scenarios.map(item => item.scenarioId)).size !== scenarios.length) {
    fail('scenarioId values must be unique')
  }
  return Object.freeze(scenarios)
}

function parseFindings(value: unknown): readonly QaFindingInput[] {
  return Object.freeze(array(value, 'findings').map((item, index) => {
    const record = requireRecord(item, `findings[${index}]`)
    const steps = stringArray(record.steps, `findings[${index}].steps`)
    if (steps.length === 0) fail(`findings[${index}].steps must not be empty`)
    return Object.freeze({
      symptom: string(record, 'symptom'),
      expected: string(record, 'expected'),
      steps,
      environment: string(record, 'environment'),
      evidenceRef: string(record, 'evidenceRef'),
    })
  }))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value as unknown[]
}

function stringArray(value: unknown, label: string): readonly string[] {
  const result = array(value, label).map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) fail(`${label}[${index}] must be a non-empty string`)
    return item as string
  })
  return Object.freeze(result)
}

function string(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`)
  return value as string
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return record[key] === undefined ? undefined : string(record, key)
}

function exact(record: Record<string, unknown>, key: string, expected: string): void {
  if (string(record, key) !== expected) fail(`${key} does not match the QA request`)
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${key} must be an integer >= 0`)
  return value as number
}

function exactInteger(record: Record<string, unknown>, key: string, expected: number): void {
  if (integer(record, key) !== expected) fail(`${key} does not match the QA request`)
}

function enumeration<const T extends readonly string[]>(
  record: Record<string, unknown>, key: string, values: T,
): T[number] {
  const value = string(record, key)
  if (!(values as readonly string[]).includes(value)) fail(`unknown ${key}: ${value}`)
  return value as T[number]
}

function optionalEnumeration<const T extends readonly string[]>(
  record: Record<string, unknown>, key: string, values: T,
): T[number] | undefined {
  return record[key] === undefined ? undefined : enumeration(record, key, values)
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
  throw new QaContractError(message)
}
