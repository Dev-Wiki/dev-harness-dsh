import { isAbsolute, posix } from 'node:path'

export const AUTO_FIX_CONTRACT_VERSION = 2 as const

export const AUTO_FIX_EXECUTION_STATUSES = [
  'RUNNING',
  'COMPLETED',
  'BLOCKED',
  'NEEDS_CONTEXT',
  'FAILED',
  'CANCELLED',
] as const

export type AutoFixExecutionStatus = typeof AUTO_FIX_EXECUTION_STATUSES[number]

export const AUTO_FIX_COMPLETION_STATUSES = [
  'DONE',
  'DONE_WITH_CONCERNS',
  'BLOCKED',
  'NEEDS_CONTEXT',
] as const

export type AutoFixCompletionStatus = typeof AUTO_FIX_COMPLETION_STATUSES[number]

export const AUTO_FIX_STAGES = [
  'preflight',
  'context',
  'reproduce',
  'hypothesize',
  'regress-red',
  'implement',
  'verify',
  'review',
  'final-verify',
  'report',
] as const

export type AutoFixStage = typeof AUTO_FIX_STAGES[number]

export const REGRESSION_SKIP_REASONS = [
  'device-required',
  'ui-only',
  'environment-unavailable',
  'no-test-seam',
] as const

export type RegressionSkipReason = typeof REGRESSION_SKIP_REASONS[number]
export type AutoFixMode = 'fix' | 'commit'

export interface AuditFindingSource {
  readonly kind: 'audit-finding'
  readonly findingId: string
  readonly handoffRef: string
  readonly auditRunId: string
  readonly auditSnapshotRef: string
  readonly findingRegistryRef: string
}

export interface QaFindingSource {
  readonly kind: 'qa-finding'
  readonly findingId: string
  readonly handoffRef: string
  readonly qaRunId: string
  readonly qaAttempt: number
  readonly qaSnapshotRef: string
  readonly qaFindingRef: string
}

export type AutoFixSource = AuditFindingSource | QaFindingSource

export interface AutoFixStartRequest {
  readonly cwd: string
  readonly orchestrationRunId: string
  readonly autoFixRunId: string
  readonly source: AutoFixSource
  readonly mode: AutoFixMode
  readonly expectedHead: string
  readonly expectedBranch: string
  readonly expectedCurrentWorkspaceFingerprint: string
  readonly expectedWorkspaceBaseFingerprint: string
  readonly signal: AbortSignal
}

export interface AutoFixResumeRequest extends AutoFixStartRequest {
  readonly expectedRevision: number
  readonly expectedWorkspaceSnapshotRef: string
}

export interface AutoFixAdapter {
  readonly name: string
  start(request: AutoFixStartRequest): Promise<unknown>
  resume(request: AutoFixResumeRequest): Promise<unknown>
}

export interface AutoFixObservation {
  readonly contractVersion: typeof AUTO_FIX_CONTRACT_VERSION
  readonly runId: string
  readonly source: AutoFixSource
  readonly mode: AutoFixMode
  readonly executionStatus: AutoFixExecutionStatus
  readonly completionStatus?: AutoFixCompletionStatus
  readonly revision: number
  readonly stateDigest: string
  readonly executionRef: string
  readonly repositoryRoot: string
  readonly baseSha: string
  readonly branch: string
  readonly workspaceSnapshotRef: string
  readonly workspaceBaseFingerprint: string
  readonly stage: AutoFixStage
  readonly changedFiles: readonly string[]
  readonly changeOutputs: readonly { path: string; fingerprint: string }[]
  readonly workspaceVerified: true
  readonly quiescent: true
  readonly regressionRedRef?: string
  readonly regressionSkipRef?: string
  readonly regressionSkipReason?: RegressionSkipReason
  readonly regressionGreenRef?: string
  readonly reviewOutcome?: 'PASS'
  readonly reviewEvidenceRef?: string
  readonly reviewReviewer?: 'independent' | 'self'
  readonly reviewDiffHash?: string
  readonly finalVerificationRef?: string
  readonly finalVerificationObservedAt?: string
  readonly finalVerificationDiffHash?: string
  readonly residualRiskRef?: string
  readonly blockerRef?: string
  readonly postCommitHead?: string
  readonly postCommitWorkspaceFingerprint?: string
  readonly commits: readonly AutoFixCommitObservation[]
}

export interface AutoFixCommitObservation {
  readonly sha: string
  readonly parentSha: string
  readonly changedFiles: readonly string[]
  readonly reviewDiffHash: string
  readonly commitEvidenceRef: string
}

export class AutoFixContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutoFixContractError'
  }
}

export function validateAutoFixObservation(
  value: unknown,
  expected: {
    readonly runId: string
    readonly source: AutoFixSource
    readonly repositoryRoot: string
    readonly baseSha: string
    readonly branch: string
    readonly workspaceFingerprint: string
    readonly mode: AutoFixMode
  },
): AutoFixObservation {
  const record = requireRecord(value, 'Auto Fix observation')
  if (record.contractVersion !== AUTO_FIX_CONTRACT_VERSION) fail('unsupported contractVersion')
  if (record.mode !== expected.mode) fail('Adapter mode does not match Run authorization')
  assertExactString(record, 'runId', expected.runId)
  const source = validateAutoFixSource(record.source, expected.source)
  assertExactString(record, 'repositoryRoot', expected.repositoryRoot)
  assertExactString(record, 'baseSha', expected.baseSha)
  assertExactString(record, 'branch', expected.branch)

  const executionStatus = enumValue(record, 'executionStatus', AUTO_FIX_EXECUTION_STATUSES)
  const completionStatus = optionalEnumValue(record, 'completionStatus', AUTO_FIX_COMPLETION_STATUSES)
  const revision = integer(record, 'revision')
  const stateDigest = sha256(record, 'stateDigest')
  const executionRef = string(record, 'executionRef')
  const workspaceSnapshotRef = string(record, 'workspaceSnapshotRef')
  const workspaceBaseFingerprint = sha256(record, 'workspaceBaseFingerprint')
  if (workspaceBaseFingerprint !== expected.workspaceFingerprint) {
    fail('workspaceBaseFingerprint does not match the mutation lease')
  }
  const stage = enumValue(record, 'stage', AUTO_FIX_STAGES)
  const changedFiles = uniquePaths(record.changedFiles, 'changedFiles')
  const changeOutputs = outputs(record.changeOutputs)
  if (record.workspaceVerified !== true || record.quiescent !== true) {
    fail('Adapter checkpoint must be workspaceVerified and quiescent')
  }
  const commits = commitObservations(record.commits)
  const completedCommit = expected.mode === 'commit' && executionStatus === 'COMPLETED'
  if (expected.mode === 'fix' && commits.length !== 0) fail('fix mode must not create commits')
  if (expected.mode === 'commit' && executionStatus !== 'COMPLETED' && commits.length !== 0) {
    fail('non-completed commit mode must not report commits')
  }
  if (completedCommit && commits.length !== 1) fail('completed commit mode requires exactly one commit')

  const outputPaths = changeOutputs.map(output => output.path)
  if (completedCommit) {
    if (changeOutputs.length !== 0) fail('completed commit mode must not retain dirty changeOutputs')
    if (!sameStrings(changedFiles, commits[0]!.changedFiles)) {
      fail('commit changedFiles must cover Auto Fix changedFiles exactly')
    }
  } else if (!sameStrings(changedFiles, outputPaths)) {
    fail('changeOutputs must cover changedFiles exactly')
  }

  const regressionRedRef = optionalString(record, 'regressionRedRef')
  const regressionSkipRef = optionalString(record, 'regressionSkipRef')
  const regressionSkipReason = optionalEnumValue(record, 'regressionSkipReason', REGRESSION_SKIP_REASONS)
  const regressionGreenRef = optionalString(record, 'regressionGreenRef')
  const reviewOutcome = record.reviewOutcome === undefined
    ? undefined
    : enumValue(record, 'reviewOutcome', ['PASS'] as const)
  const reviewEvidenceRef = optionalString(record, 'reviewEvidenceRef')
  const reviewReviewer = record.reviewReviewer === undefined
    ? undefined
    : enumValue(record, 'reviewReviewer', ['independent', 'self'] as const)
  const reviewDiffHash = optionalString(record, 'reviewDiffHash')
  const finalVerificationRef = optionalString(record, 'finalVerificationRef')
  const finalVerificationObservedAt = optionalString(record, 'finalVerificationObservedAt')
  const finalVerificationDiffHash = optionalString(record, 'finalVerificationDiffHash')
  const residualRiskRef = optionalString(record, 'residualRiskRef')
  const blockerRef = optionalString(record, 'blockerRef')
  const postCommitHead = optionalString(record, 'postCommitHead')
  const postCommitWorkspaceFingerprint = optionalString(record, 'postCommitWorkspaceFingerprint')

  if (executionStatus === 'RUNNING') {
    if (completionStatus !== undefined) fail('RUNNING observation must not claim completion')
  } else if (executionStatus === 'COMPLETED') {
    if (!['DONE', 'DONE_WITH_CONCERNS'].includes(completionStatus ?? '')) {
      fail('COMPLETED execution requires DONE or DONE_WITH_CONCERNS')
    }
    if (stage !== 'report') fail('completed Auto Fix run must reach report stage')
    if (changedFiles.length === 0) fail('completed Auto Fix run must own at least one changed file')
    if (regressionRedRef === undefined && completionStatus === 'DONE') {
      fail('DONE requires regressionRedRef')
    }
    if (regressionRedRef === undefined) {
      if (regressionSkipRef === undefined || regressionSkipReason === undefined) {
        fail('missing RED evidence requires an objective regression skip reference and reason')
      }
    } else if (regressionSkipRef !== undefined || regressionSkipReason !== undefined) {
      fail('regression RED evidence and skip evidence are mutually exclusive')
    }
    for (const [name, reference] of Object.entries({
      regressionGreenRef,
      reviewOutcome,
      reviewEvidenceRef,
      reviewReviewer,
      reviewDiffHash,
      finalVerificationRef,
      finalVerificationObservedAt,
      finalVerificationDiffHash,
    })) {
      if (reference === undefined) fail(`completed Auto Fix run requires ${name}`)
    }
    if (!/^[a-f0-9]{64}$/u.test(reviewDiffHash!)) fail('reviewDiffHash must be sha256')
    if (finalVerificationDiffHash !== reviewDiffHash) {
      fail('final verification diff must match the reviewed diff')
    }
    if (!Number.isFinite(Date.parse(finalVerificationObservedAt!))) {
      fail('finalVerificationObservedAt must be an ISO-compatible timestamp')
    }
    if (completedCommit) {
      if (postCommitHead !== commits[0]!.sha) fail('postCommitHead must equal the reported commit')
      if (postCommitWorkspaceFingerprint === undefined || !/^[a-f0-9]{64}$/u.test(postCommitWorkspaceFingerprint)) {
        fail('completed commit mode requires postCommitWorkspaceFingerprint')
      }
      if (commits[0]!.parentSha !== expected.baseSha) fail('commit parent must equal the requested HEAD')
      if (commits[0]!.reviewDiffHash !== reviewDiffHash) fail('commit must bind to the reviewed diff')
    } else if (postCommitHead !== undefined || postCommitWorkspaceFingerprint !== undefined) {
      fail('non-commit completion must not claim a post-commit workspace')
    }
    if (completionStatus === 'DONE_WITH_CONCERNS' && residualRiskRef === undefined) {
      fail('DONE_WITH_CONCERNS requires residualRiskRef')
    }
    if (completionStatus === 'DONE' && residualRiskRef !== undefined) {
      fail('DONE must not retain a residual-risk reference')
    }
  } else if (executionStatus === 'BLOCKED') {
    if (completionStatus !== 'BLOCKED' || blockerRef === undefined) {
      fail('BLOCKED execution requires BLOCKED completionStatus and blockerRef')
    }
  } else if (executionStatus === 'NEEDS_CONTEXT') {
    if (completionStatus !== 'NEEDS_CONTEXT' || blockerRef === undefined) {
      fail('NEEDS_CONTEXT execution requires NEEDS_CONTEXT completionStatus and blockerRef')
    }
  } else if (completionStatus !== undefined) {
    fail(`${executionStatus} execution must not claim completion`)
  }

  return Object.freeze({
    contractVersion: AUTO_FIX_CONTRACT_VERSION,
    runId: expected.runId,
    source,
    mode: expected.mode,
    executionStatus,
    ...(completionStatus === undefined ? {} : { completionStatus }),
    revision,
    stateDigest,
    executionRef,
    repositoryRoot: expected.repositoryRoot,
    baseSha: expected.baseSha,
    branch: expected.branch,
    workspaceSnapshotRef,
    workspaceBaseFingerprint,
    stage,
    changedFiles,
    changeOutputs,
    workspaceVerified: true,
    quiescent: true,
    ...(regressionRedRef === undefined ? {} : { regressionRedRef }),
    ...(regressionSkipRef === undefined ? {} : { regressionSkipRef }),
    ...(regressionSkipReason === undefined ? {} : { regressionSkipReason }),
    ...(regressionGreenRef === undefined ? {} : { regressionGreenRef }),
    ...(reviewOutcome === undefined ? {} : { reviewOutcome }),
    ...(reviewEvidenceRef === undefined ? {} : { reviewEvidenceRef }),
    ...(reviewReviewer === undefined ? {} : { reviewReviewer }),
    ...(reviewDiffHash === undefined ? {} : { reviewDiffHash }),
    ...(finalVerificationRef === undefined ? {} : { finalVerificationRef }),
    ...(finalVerificationObservedAt === undefined ? {} : { finalVerificationObservedAt }),
    ...(finalVerificationDiffHash === undefined ? {} : { finalVerificationDiffHash }),
    ...(residualRiskRef === undefined ? {} : { residualRiskRef }),
    ...(blockerRef === undefined ? {} : { blockerRef }),
    ...(postCommitHead === undefined ? {} : { postCommitHead }),
    ...(postCommitWorkspaceFingerprint === undefined ? {} : { postCommitWorkspaceFingerprint }),
    commits,
  })
}

function validateAutoFixSource(value: unknown, expected: AutoFixSource): AutoFixSource {
  const record = requireRecord(value, 'source')
  if (record.kind !== expected.kind) fail('source kind does not match the Auto Fix request')
  assertExactString(record, 'findingId', expected.findingId)
  assertExactString(record, 'handoffRef', expected.handoffRef)
  if (expected.kind === 'audit-finding') {
    assertExactString(record, 'auditRunId', expected.auditRunId)
    assertExactString(record, 'auditSnapshotRef', expected.auditSnapshotRef)
    assertExactString(record, 'findingRegistryRef', expected.findingRegistryRef)
    return Object.freeze({
      kind: expected.kind,
      findingId: expected.findingId,
      handoffRef: expected.handoffRef,
      auditRunId: expected.auditRunId,
      auditSnapshotRef: expected.auditSnapshotRef,
      findingRegistryRef: expected.findingRegistryRef,
    })
  }
  assertExactString(record, 'qaRunId', expected.qaRunId)
  assertExactInteger(record, 'qaAttempt', expected.qaAttempt)
  assertExactString(record, 'qaSnapshotRef', expected.qaSnapshotRef)
  assertExactString(record, 'qaFindingRef', expected.qaFindingRef)
  return Object.freeze({
    kind: expected.kind,
    findingId: expected.findingId,
    handoffRef: expected.handoffRef,
    qaRunId: expected.qaRunId,
    qaAttempt: expected.qaAttempt,
    qaSnapshotRef: expected.qaSnapshotRef,
    qaFindingRef: expected.qaFindingRef,
  })
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) fail(`${key} must be a non-empty string`)
  return value as string
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  if (record[key] === undefined) return undefined
  return string(record, key)
}

function sha256(record: Record<string, unknown>, key: string): string {
  const value = string(record, key)
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(`${key} must be sha256`)
  return value
}

function assertExactString(record: Record<string, unknown>, key: string, expected: string): void {
  if (string(record, key) !== expected) fail(`${key} does not match the orchestration request`)
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${key} must be an integer >= 0`)
  return value as number
}

function assertExactInteger(record: Record<string, unknown>, key: string, expected: number): void {
  if (integer(record, key) !== expected) fail(`${key} does not match the orchestration request`)
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  return value as unknown[]
}

function enumValue<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = string(record, key)
  if (!(values as readonly string[]).includes(value)) fail(`unknown ${key}: ${value}`)
  return value as T[number]
}

function optionalEnumValue<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  if (record[key] === undefined) return undefined
  return enumValue(record, key, values)
}

function uniquePaths(value: unknown, label: string): readonly string[] {
  const paths = array(value, label).map((item, index) => {
    if (typeof item !== 'string' || !isRepositoryRelativePath(item)) {
      fail(`${label}[${index}] must be a normalized repository-relative path`)
    }
    return item as string
  })
  if (new Set(paths).size !== paths.length) fail(`${label} must not contain duplicate paths`)
  return Object.freeze([...paths].sort())
}

function outputs(value: unknown): readonly { path: string; fingerprint: string }[] {
  const records = array(value, 'changeOutputs').map((item, index) => {
    const record = requireRecord(item, `changeOutputs[${index}]`)
    const path = string(record, 'path')
    if (!isRepositoryRelativePath(path)) fail(`changeOutputs[${index}].path must be repository-relative`)
    const fingerprint = string(record, 'fingerprint')
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) fail(`changeOutputs[${index}].fingerprint must be sha256`)
    return Object.freeze({ path, fingerprint })
  })
  const paths = records.map(output => output.path)
  if (new Set(paths).size !== paths.length) fail('changeOutputs must not contain duplicate paths')
  return Object.freeze(records.sort((left, right) => left.path.localeCompare(right.path)))
}

function commitObservations(value: unknown): readonly AutoFixCommitObservation[] {
  const commits = array(value, 'commits').map((item, index) => {
    const record = requireRecord(item, `commits[${index}]`)
    const sha = string(record, 'sha')
    const parentSha = string(record, 'parentSha')
    if (!/^[a-f0-9]{40,64}$/u.test(sha) || !/^[a-f0-9]{40,64}$/u.test(parentSha)) {
      fail(`commits[${index}] sha and parentSha must be Git object ids`)
    }
    const changedFiles = uniquePaths(record.changedFiles, `commits[${index}].changedFiles`)
    if (changedFiles.length === 0) fail(`commits[${index}] must contain changedFiles`)
    const reviewDiffHash = sha256(record, 'reviewDiffHash')
    const commitEvidenceRef = string(record, 'commitEvidenceRef')
    return Object.freeze({ sha, parentSha, changedFiles, reviewDiffHash, commitEvidenceRef })
  })
  if (new Set(commits.map(commit => commit.sha)).size !== commits.length) {
    fail('commits must not contain duplicate object ids')
  }
  return Object.freeze(commits)
}

function isRepositoryRelativePath(path: string): boolean {
  return path.length > 0
    && !isAbsolute(path)
    && path === posix.normalize(path)
    && path !== '.'
    && path !== '..'
    && !path.startsWith('../')
    && !path.includes('\\')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function fail(message: string): never {
  throw new AutoFixContractError(message)
}
