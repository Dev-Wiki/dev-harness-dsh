export const FULL_VERIFICATION_CONTRACT_VERSION = 1 as const
export const FULL_VERIFICATION_COMMAND = 'npm run harness:full' as const

export const VERIFICATION_EXECUTION_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const
export type VerificationExecutionStatus = typeof VERIFICATION_EXECUTION_STATUSES[number]

export const VERIFICATION_RESULT_STATUSES = [
  'PASS',
  'FAIL',
  'ENTRY_MISSING',
  'ENVIRONMENT_UNAVAILABLE',
  'EXECUTION_FAILED',
] as const
export type VerificationResultStatus = typeof VERIFICATION_RESULT_STATUSES[number]

export interface FullVerificationStartRequest {
  readonly cwd: string
  readonly orchestrationRunId: string
  readonly verificationRunId: string
  readonly command: typeof FULL_VERIFICATION_COMMAND
  readonly expectedHead: string
  readonly expectedBranch: string
  readonly expectedWorkspaceFingerprint: string
  readonly expectedSnapshotRef: string
  readonly signal: AbortSignal
}

export interface FullVerificationResumeRequest extends FullVerificationStartRequest {
  readonly expectedRevision: number
  readonly expectedRunRef: string
}

export interface FullVerificationAdapter {
  readonly name: string
  start(request: FullVerificationStartRequest): Promise<unknown>
  resume(request: FullVerificationResumeRequest): Promise<unknown>
}

export interface FullVerificationObservation {
  readonly contractVersion: typeof FULL_VERIFICATION_CONTRACT_VERSION
  readonly runId: string
  readonly revision: number
  readonly executionStatus: VerificationExecutionStatus
  readonly resultStatus?: VerificationResultStatus
  readonly command: typeof FULL_VERIFICATION_COMMAND
  readonly repositoryRoot: string
  readonly head: string
  readonly branch: string
  readonly workspaceFingerprint: string
  readonly snapshotRef: string
  readonly runRef: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly evidenceRef?: string
  readonly workspaceVerified: true
  readonly quiescent: true
}

export class FullVerificationContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FullVerificationContractError'
  }
}

export function validateFullVerificationObservation(
  value: unknown,
  expected: {
    readonly runId: string
    readonly repositoryRoot: string
    readonly head: string
    readonly branch: string
    readonly workspaceFingerprint: string
    readonly snapshotRef: string
  },
): FullVerificationObservation {
  const record = requireRecord(value)
  if (record.contractVersion !== FULL_VERIFICATION_CONTRACT_VERSION) fail('unsupported contractVersion')
  exact(record, 'runId', expected.runId)
  exact(record, 'command', FULL_VERIFICATION_COMMAND)
  exact(record, 'repositoryRoot', expected.repositoryRoot)
  exact(record, 'head', expected.head)
  exact(record, 'branch', expected.branch)
  exact(record, 'workspaceFingerprint', expected.workspaceFingerprint)
  exact(record, 'snapshotRef', expected.snapshotRef)
  const revision = integer(record, 'revision')
  const executionStatus = enumeration(record, 'executionStatus', VERIFICATION_EXECUTION_STATUSES)
  const resultStatus = optionalEnumeration(record, 'resultStatus', VERIFICATION_RESULT_STATUSES)
  const runRef = string(record, 'runRef')
  const startedAt = timestamp(record, 'startedAt')
  const finishedAt = optionalTimestamp(record, 'finishedAt')
  const evidenceRef = optionalString(record, 'evidenceRef')
  if (record.workspaceVerified !== true || record.quiescent !== true) {
    fail('verification checkpoint must be workspaceVerified and quiescent')
  }

  if (executionStatus === 'RUNNING') {
    if (resultStatus !== undefined || finishedAt !== undefined || evidenceRef !== undefined) {
      fail('RUNNING verification must not claim a terminal result')
    }
  } else if (executionStatus === 'COMPLETED') {
    if (!['PASS', 'FAIL', 'ENTRY_MISSING', 'ENVIRONMENT_UNAVAILABLE'].includes(resultStatus ?? '')) {
      fail('COMPLETED verification has an invalid resultStatus')
    }
    if (finishedAt === undefined || evidenceRef === undefined) {
      fail('COMPLETED verification requires finishedAt and evidenceRef')
    }
  } else if (executionStatus === 'FAILED') {
    if (resultStatus !== 'EXECUTION_FAILED' || finishedAt === undefined || evidenceRef === undefined) {
      fail('FAILED execution requires EXECUTION_FAILED, finishedAt, and evidenceRef')
    }
  } else if (resultStatus !== undefined) {
    fail('CANCELLED verification must not claim a result')
  }
  if (finishedAt !== undefined && Date.parse(finishedAt) < Date.parse(startedAt)) {
    fail('finishedAt cannot precede startedAt')
  }

  return Object.freeze({
    contractVersion: FULL_VERIFICATION_CONTRACT_VERSION,
    runId: expected.runId,
    revision,
    executionStatus,
    ...(resultStatus === undefined ? {} : { resultStatus }),
    command: FULL_VERIFICATION_COMMAND,
    repositoryRoot: expected.repositoryRoot,
    head: expected.head,
    branch: expected.branch,
    workspaceFingerprint: expected.workspaceFingerprint,
    snapshotRef: expected.snapshotRef,
    runRef,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
    workspaceVerified: true,
    quiescent: true,
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('observation must be an object')
  return value as Record<string, unknown>
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
  if (string(record, key) !== expected) fail(`${key} does not match the verification request`)
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${key} must be an integer >= 0`)
  return value as number
}

function enumeration<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = string(record, key)
  if (!(values as readonly string[]).includes(value)) fail(`unknown ${key}: ${value}`)
  return value as T[number]
}

function optionalEnumeration<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
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
  throw new FullVerificationContractError(message)
}
