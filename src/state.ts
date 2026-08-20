import { createHash, randomBytes } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rmdir,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import atomicWritePackage from '@deepseek-ai/dsh-atomic-write/package.json' with { type: 'json' }
import cordisPackage from '@deepseek-ai/cordis/package.json' with { type: 'json' }
import commandsPackage from '@deepseek-ai/dsh-commands/package.json' with { type: 'json' }
import skillPackage from '@deepseek-ai/dsh-skill/package.json' with { type: 'json' }

const execFile = promisify(execFileCallback)
const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const LOCKFILE_CANDIDATES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const
const CONTEXT_FILES = ['README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'HARNESS.md'] as const

export const RUN_STATE_SCHEMA_VERSION = 1 as const

export const PHASES = [
  'INIT',
  'PREFLIGHT',
  'AUDIT',
  'ROUTE',
  'REMEDIATE',
  'FULL_VERIFY',
  'QA',
  'FINAL_RECONCILE',
  'REPORT',
  'DONE',
] as const

export type Phase = typeof PHASES[number]

export const RUN_STATUSES = [
  'RUNNING',
  'PAUSED',
  'NEEDS_USER',
  'BLOCKED',
  'FAILED',
  'DONE',
  'DONE_WITH_CONCERNS',
  'CANCELLED',
] as const

export type RunStatus = typeof RUN_STATUSES[number]

const TERMINAL_STATUSES = new Set<RunStatus>([
  'FAILED',
  'DONE',
  'DONE_WITH_CONCERNS',
  'CANCELLED',
])

const PHASE_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  INIT: ['PREFLIGHT'],
  PREFLIGHT: ['AUDIT'],
  AUDIT: ['ROUTE'],
  ROUTE: ['REMEDIATE'],
  REMEDIATE: ['FULL_VERIFY'],
  FULL_VERIFY: ['QA'],
  QA: ['FINAL_RECONCILE', 'REMEDIATE'],
  FINAL_RECONCILE: ['REPORT'],
  REPORT: ['DONE'],
  DONE: [],
}

const STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  RUNNING: [
    'PAUSED',
    'NEEDS_USER',
    'BLOCKED',
    'FAILED',
    'DONE',
    'DONE_WITH_CONCERNS',
    'CANCELLED',
  ],
  PAUSED: ['RUNNING', 'CANCELLED'],
  NEEDS_USER: ['RUNNING', 'CANCELLED'],
  BLOCKED: ['RUNNING', 'CANCELLED'],
  FAILED: [],
  DONE: [],
  DONE_WITH_CONCERNS: [],
  CANCELLED: [],
}

export const RUNTIME_DEPENDENCIES: Readonly<Record<string, string>> = Object.freeze({
  '@deepseek-ai/cordis': cordisPackage.version,
  '@deepseek-ai/dsh-atomic-write': atomicWritePackage.version,
  '@deepseek-ai/dsh-commands': commandsPackage.version,
  '@deepseek-ai/dsh-skill': skillPackage.version,
})

export interface RepositoryIdentity {
  worktreeRoot: string
  privateGitDir: string
  head: string
  branch: string
  worktreeFingerprint: string
}

export interface DependencySnapshot {
  lockfilePath?: string
  lockfileSha256?: string
  packages: Record<string, string>
}

export interface FindingRouteRef {
  findingId: string
  status: string
  route: string
  handoffRef?: string
}

export interface AutoFixRunRef {
  findingId: string
  autoFixRunId: string
  status: string
  residualRiskRef?: string
}

export interface CommitRef {
  sha: string
  autoFixRunId?: string
}

export interface VerificationRef {
  status: string
  runRef?: string
  snapshotRef?: string
}

export interface QaRunRef {
  status: string
  attempt: number
  runRef?: string
}

export interface RunBlocker {
  code: string
  message: string
}

export interface AuditMutationLease {
  auditRunId: string
  adapterName: string
  allowedRoot: string
  beforeFingerprint: string
  beforeChangedPaths: Record<string, string>
  status: 'OPEN'
}

export interface AuditResultRef {
  status: string
  executionStatus: string
  revision: number
  snapshotRef: string
  registryRef: string
  reportRef: string
  crossModuleStatus: string
}

export interface AuditWorkspaceCheckpoint {
  auditRunId: string
  adapterRevision: number
  snapshotRef: string
  previousFingerprint: string
  acceptedFingerprint: string
  outputs: Array<{ path: string; fingerprint: string }>
}

export interface RunState {
  schemaVersion: typeof RUN_STATE_SCHEMA_VERSION
  revision: number
  runId: string
  repo: RepositoryIdentity
  contextFingerprint: string
  dependencies: DependencySnapshot
  phase: Phase
  status: RunStatus
  createdAt: string
  updatedAt: string
  auditRunId?: string
  auditLease?: AuditMutationLease
  auditResult?: AuditResultRef
  auditCheckpoint?: AuditWorkspaceCheckpoint
  currentFinding?: string
  findings: FindingRouteRef[]
  fixRuns: AutoFixRunRef[]
  commits: CommitRef[]
  fullVerification?: VerificationRef
  qa?: QaRunRef
  finalAuditRunId?: string
  blocker?: RunBlocker
}

export type RunStateErrorCode =
  | 'ACTIVE_RUN_EXISTS'
  | 'CONTEXT_MISMATCH'
  | 'CONTEXT_REQUIRED'
  | 'DEPENDENCY_MISMATCH'
  | 'HEAD_MISMATCH'
  | 'INVALID_RUN_ID'
  | 'INVALID_TRANSITION'
  | 'NOT_GIT_REPOSITORY'
  | 'REVISION_CONFLICT'
  | 'RUN_EXISTS'
  | 'STATE_CORRUPT'
  | 'STATE_NOT_FOUND'
  | 'TERMINAL_RUN'
  | 'WORKTREE_MISMATCH'

export class RunStateError extends Error {
  constructor(
    readonly code: RunStateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options)
    this.name = 'RunStateError'
  }
}

export interface CaptureEnvironmentOptions {
  lockfilePath?: string
  runtimeDependencies?: Readonly<Record<string, string>>
}

export interface CreateRunOptions extends CaptureEnvironmentOptions {
  cwd: string
  runId?: string
  now?: Date
}

export interface UpdateRunOptions {
  cwd: string
  runId: string
  expectedRevision: number
  mutate(draft: RunState): void
  now?: Date
  runtimeDependencies?: Readonly<Record<string, string>>
}

export interface WorktreeBoundary {
  readonly worktreeRoot: string
  readonly fingerprint: string
  readonly changedPaths: Readonly<Record<string, string>>
}

export interface AdoptWorktreeBoundaryOptions {
  cwd: string
  runId: string
  expectedRevision: number
  before: WorktreeBoundary
  boundary: WorktreeBoundary
  acceptedPaths: readonly string[]
  now?: Date
  runtimeDependencies?: Readonly<Record<string, string>>
}

export function generateRunId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replaceAll(/[-:.TZ]/gu, '').slice(0, 14).toLowerCase()
  return `dsh-${timestamp}-${randomBytes(4).toString('hex')}`
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RunStateError('INVALID_RUN_ID', `run id ${JSON.stringify(runId)} must match ${RUN_ID_PATTERN}`)
  }
}

async function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  try {
    const result = await execFile('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT,
    })
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  } catch (error) {
    throw new RunStateError('NOT_GIT_REPOSITORY', `Git inspection failed for ${cwd}`, {
      cause: error,
    })
  }
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitBuffer(cwd, args)).toString('utf8').trim()
}

function updateHash(hash: ReturnType<typeof createHash>, label: string, content: Uint8Array): void {
  hash.update(label)
  hash.update('\0')
  hash.update(String(content.byteLength))
  hash.update('\0')
  hash.update(content)
  hash.update('\0')
}

function isWithin(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

async function fingerprintWorktree(worktreeRoot: string): Promise<string> {
  const hash = createHash('sha256')
  updateHash(hash, 'status', await gitBuffer(worktreeRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]))
  updateHash(hash, 'tracked', await gitBuffer(worktreeRoot, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    '--',
  ]))
  updateHash(hash, 'staged', await gitBuffer(worktreeRoot, [
    'diff',
    '--binary',
    '--cached',
    '--no-ext-diff',
    '--no-textconv',
    'HEAD',
    '--',
  ]))

  const untracked = await gitBuffer(worktreeRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
  for (const rawPath of untracked.toString('utf8').split('\0').filter(Boolean).sort()) {
    const absolutePath = resolve(worktreeRoot, rawPath)
    if (!isWithin(worktreeRoot, absolutePath)) {
      throw new RunStateError('WORKTREE_MISMATCH', `untracked path escapes worktree: ${rawPath}`)
    }
    const info = await lstat(absolutePath)
    updateHash(hash, 'untracked-path', Buffer.from(rawPath))
    if (info.isSymbolicLink()) {
      updateHash(hash, 'untracked-symlink', Buffer.from(await readlink(absolutePath)))
    } else if (info.isFile()) {
      updateHash(hash, 'untracked-file', await readFile(absolutePath))
    } else {
      throw new RunStateError('WORKTREE_MISMATCH', `unsupported untracked entry: ${rawPath}`)
    }
  }
  return hash.digest('hex')
}

function nulPathSet(...buffers: readonly Buffer[]): string[] {
  return [...new Set(buffers.flatMap(buffer => buffer.toString('utf8').split('\0').filter(Boolean)))].sort()
}

async function fingerprintChangedPath(worktreeRoot: string, rawPath: string): Promise<string> {
  const absolutePath = resolve(worktreeRoot, rawPath)
  if (!isWithin(worktreeRoot, absolutePath)) {
    throw new RunStateError('WORKTREE_MISMATCH', `changed path escapes worktree: ${rawPath}`)
  }
  const hash = createHash('sha256')
  updateHash(hash, 'path', Buffer.from(rawPath))
  updateHash(hash, 'tracked', await gitBuffer(worktreeRoot, [
    'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', rawPath,
  ]))
  updateHash(hash, 'staged', await gitBuffer(worktreeRoot, [
    'diff', '--binary', '--cached', '--no-ext-diff', '--no-textconv', 'HEAD', '--', rawPath,
  ]))
  try {
    const info = await lstat(absolutePath)
    if (info.isSymbolicLink()) {
      updateHash(hash, 'symlink', Buffer.from(await readlink(absolutePath)))
    } else if (info.isFile()) {
      updateHash(hash, 'file', await readFile(absolutePath))
    } else {
      updateHash(hash, 'other', Buffer.from(String(info.mode)))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    updateHash(hash, 'missing', Buffer.alloc(0))
  }
  return hash.digest('hex')
}

async function captureChangedPaths(worktreeRoot: string): Promise<Readonly<Record<string, string>>> {
  const paths = nulPathSet(
    await gitBuffer(worktreeRoot, ['diff', '--name-only', '-z', 'HEAD', '--']),
    await gitBuffer(worktreeRoot, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--']),
    await gitBuffer(worktreeRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  )
  return Object.freeze(Object.fromEntries(await Promise.all(paths.map(async path => [
    path,
    await fingerprintChangedPath(worktreeRoot, path),
  ] as const))))
}

export async function captureWorktreeBoundary(cwd: string): Promise<WorktreeBoundary> {
  const before = await captureRepositoryIdentity(cwd)
  const changedPaths = await captureChangedPaths(before.worktreeRoot)
  const after = await captureRepositoryIdentity(cwd)
  if (
    before.worktreeRoot !== after.worktreeRoot
    || before.privateGitDir !== after.privateGitDir
    || before.head !== after.head
    || before.branch !== after.branch
    || before.worktreeFingerprint !== after.worktreeFingerprint
  ) {
    throw new RunStateError('WORKTREE_MISMATCH', 'worktree changed while capturing a mutation boundary')
  }
  return Object.freeze({
    worktreeRoot: after.worktreeRoot,
    fingerprint: after.worktreeFingerprint,
    changedPaths,
  })
}

export function diffWorktreeBoundaries(before: WorktreeBoundary, after: WorktreeBoundary): readonly string[] {
  if (before.worktreeRoot !== after.worktreeRoot) {
    throw new RunStateError('WORKTREE_MISMATCH', 'worktree root changed across a mutation boundary')
  }
  const paths = new Set([...Object.keys(before.changedPaths), ...Object.keys(after.changedPaths)])
  return Object.freeze([...paths]
    .filter(path => before.changedPaths[path] !== after.changedPaths[path])
    .sort())
}

export async function captureRepositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
  const worktreeRoot = await realpath(await gitText(cwd, ['rev-parse', '--show-toplevel']))
  const privateGitDir = await realpath(resolve(await gitText(cwd, [
    'rev-parse',
    '--absolute-git-dir',
  ])))
  return {
    worktreeRoot,
    privateGitDir,
    head: await gitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
    branch: await gitText(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    worktreeFingerprint: await fingerprintWorktree(worktreeRoot),
  }
}

export async function captureContextFingerprint(worktreeRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const relativePath of CONTEXT_FILES) {
    const path = join(worktreeRoot, relativePath)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RunStateError('CONTEXT_REQUIRED', `canonical Context file is missing: ${relativePath}`, {
          cause: error,
        })
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RunStateError('CONTEXT_REQUIRED', `canonical Context path must be a regular file: ${relativePath}`)
    }
    updateHash(hash, relativePath, await readFile(path))
  }
  return hash.digest('hex')
}

async function detectLockfile(worktreeRoot: string): Promise<string | undefined> {
  for (const candidate of LOCKFILE_CANDIDATES) {
    const path = join(worktreeRoot, candidate)
    try {
      if ((await lstat(path)).isFile()) return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

async function captureDependencies(
  worktreeRoot: string,
  options: CaptureEnvironmentOptions = {},
): Promise<DependencySnapshot> {
  const requested = options.lockfilePath
  let lockfilePath: string | undefined
  if (requested !== undefined) {
    const absolute = resolve(worktreeRoot, requested)
    if (!isWithin(worktreeRoot, absolute)) {
      throw new RunStateError('DEPENDENCY_MISMATCH', 'lockfile path escapes the worktree')
    }
    lockfilePath = relative(worktreeRoot, absolute)
  } else {
    lockfilePath = await detectLockfile(worktreeRoot)
  }
  const lockfileSha256 = lockfilePath === undefined
    ? undefined
    : createHash('sha256').update(await readFile(join(worktreeRoot, lockfilePath))).digest('hex')
  return {
    ...(lockfilePath === undefined ? {} : { lockfilePath, lockfileSha256 }),
    packages: { ...(options.runtimeDependencies ?? RUNTIME_DEPENDENCIES) },
  }
}

export async function captureEnvironment(
  cwd: string,
  options: CaptureEnvironmentOptions = {},
): Promise<{ repo: RepositoryIdentity; contextFingerprint: string; dependencies: DependencySnapshot }> {
  const repo = await captureRepositoryIdentity(cwd)
  return {
    repo,
    contextFingerprint: await captureContextFingerprint(repo.worktreeRoot),
    dependencies: await captureDependencies(repo.worktreeRoot, options),
  }
}

export async function resolveStateRoot(cwd: string): Promise<string> {
  const identity = await captureRepositoryIdentity(cwd)
  return join(identity.privateGitDir, 'dev-harness', 'dsh')
}

export async function resolveStatePath(cwd: string, runId: string): Promise<string> {
  assertRunId(runId)
  return join(await resolveStateRoot(cwd), runId, 'state.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function requireInteger(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = record[key]
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${key} must be an integer >= ${minimum}`)
  return value as number
}

function requireRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`${key} must be an object`)
  return value
}

function requireArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`)
  return value
}

function parseOptionalRef(
  record: Record<string, unknown>,
  key: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, string> | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error(`${key} must be an object`)
  return Object.fromEntries([
    ...required.map(field => [field, requireString(value, field)] as const),
    ...optional.flatMap(field => {
      const entry = optionalString(value, field)
      return entry === undefined ? [] : [[field, entry] as const]
    }),
  ])
}

function parseStringRecord(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = requireRecord(record, key)
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (typeof item !== 'string' || item.length === 0) throw new Error(`${key}.${name} must be a non-empty string`)
    return [name, item]
  }))
}

function parseRefArray(
  record: Record<string, unknown>,
  key: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, string>[] {
  return requireArray(record, key).map((value, index) => {
    if (!isRecord(value)) throw new Error(`${key}[${index}] must be an object`)
    return Object.fromEntries([
      ...required.map(field => [field, requireString(value, field)] as const),
      ...optional.flatMap(field => {
        const entry = optionalString(value, field)
        return entry === undefined ? [] : [[field, entry] as const]
      }),
    ])
  })
}

function parseRunState(value: unknown): RunState {
  if (!isRecord(value)) throw new Error('state root must be an object')
  if (value.schemaVersion !== RUN_STATE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must equal ${RUN_STATE_SCHEMA_VERSION}`)
  }
  const runId = requireString(value, 'runId')
  assertRunId(runId)
  const repo = requireRecord(value, 'repo')
  const dependencies = requireRecord(value, 'dependencies')
  const packages = requireRecord(dependencies, 'packages')
  const phase = requireString(value, 'phase')
  const status = requireString(value, 'status')
  if (!(PHASES as readonly string[]).includes(phase)) throw new Error(`unknown phase: ${phase}`)
  if (!(RUN_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown status: ${status}`)
  const createdAt = requireString(value, 'createdAt')
  const updatedAt = requireString(value, 'updatedAt')
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('createdAt and updatedAt must be ISO-compatible timestamps')
  }
  const qaRecord = value.qa
  const qa = qaRecord === undefined
    ? undefined
    : (() => {
        if (!isRecord(qaRecord)) throw new Error('qa must be an object')
        return {
          status: requireString(qaRecord, 'status'),
          attempt: requireInteger(qaRecord, 'attempt'),
          ...optionalString(qaRecord, 'runRef') === undefined
            ? {}
            : { runRef: optionalString(qaRecord, 'runRef') },
        }
      })()
  const auditLeaseRecord = value.auditLease
  const auditLease = auditLeaseRecord === undefined
    ? undefined
    : (() => {
        if (!isRecord(auditLeaseRecord) || auditLeaseRecord.status !== 'OPEN') {
          throw new Error('auditLease must be an OPEN lease object')
        }
        return {
          auditRunId: requireString(auditLeaseRecord, 'auditRunId'),
          adapterName: requireString(auditLeaseRecord, 'adapterName'),
          allowedRoot: requireString(auditLeaseRecord, 'allowedRoot'),
          beforeFingerprint: requireString(auditLeaseRecord, 'beforeFingerprint'),
          beforeChangedPaths: parseStringRecord(auditLeaseRecord, 'beforeChangedPaths'),
          status: 'OPEN' as const,
        }
      })()
  const auditResultRecord = value.auditResult
  const auditResult = auditResultRecord === undefined
    ? undefined
    : (() => {
        if (!isRecord(auditResultRecord)) throw new Error('auditResult must be an object')
        return {
          status: requireString(auditResultRecord, 'status'),
          executionStatus: requireString(auditResultRecord, 'executionStatus'),
          revision: requireInteger(auditResultRecord, 'revision'),
          snapshotRef: requireString(auditResultRecord, 'snapshotRef'),
          registryRef: requireString(auditResultRecord, 'registryRef'),
          reportRef: requireString(auditResultRecord, 'reportRef'),
          crossModuleStatus: requireString(auditResultRecord, 'crossModuleStatus'),
        }
      })()
  const auditCheckpointRecord = value.auditCheckpoint
  const auditCheckpoint = auditCheckpointRecord === undefined
    ? undefined
    : (() => {
        if (!isRecord(auditCheckpointRecord)) throw new Error('auditCheckpoint must be an object')
        return {
          auditRunId: requireString(auditCheckpointRecord, 'auditRunId'),
          adapterRevision: requireInteger(auditCheckpointRecord, 'adapterRevision'),
          snapshotRef: requireString(auditCheckpointRecord, 'snapshotRef'),
          previousFingerprint: requireString(auditCheckpointRecord, 'previousFingerprint'),
          acceptedFingerprint: requireString(auditCheckpointRecord, 'acceptedFingerprint'),
          outputs: parseRefArray(auditCheckpointRecord, 'outputs', ['path', 'fingerprint']) as Array<{
            path: string
            fingerprint: string
          }>,
        }
      })()
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    revision: requireInteger(value, 'revision'),
    runId,
    repo: {
      worktreeRoot: requireString(repo, 'worktreeRoot'),
      privateGitDir: requireString(repo, 'privateGitDir'),
      head: requireString(repo, 'head'),
      branch: requireString(repo, 'branch'),
      worktreeFingerprint: requireString(repo, 'worktreeFingerprint'),
    },
    contextFingerprint: requireString(value, 'contextFingerprint'),
    dependencies: {
      ...optionalString(dependencies, 'lockfilePath') === undefined
        ? {}
        : {
            lockfilePath: optionalString(dependencies, 'lockfilePath'),
            lockfileSha256: requireString(dependencies, 'lockfileSha256'),
          },
      packages: Object.fromEntries(Object.entries(packages).map(([name, version]) => {
        if (typeof version !== 'string' || version.length === 0) throw new Error(`invalid package version for ${name}`)
        return [name, version]
      })),
    },
    phase: phase as Phase,
    status: status as RunStatus,
    createdAt,
    updatedAt,
    ...optionalString(value, 'auditRunId') === undefined ? {} : { auditRunId: optionalString(value, 'auditRunId') },
    ...(auditLease === undefined ? {} : { auditLease }),
    ...(auditResult === undefined ? {} : { auditResult }),
    ...(auditCheckpoint === undefined ? {} : { auditCheckpoint }),
    ...optionalString(value, 'currentFinding') === undefined ? {} : { currentFinding: optionalString(value, 'currentFinding') },
    findings: parseRefArray(value, 'findings', ['findingId', 'status', 'route'], ['handoffRef']) as unknown as FindingRouteRef[],
    fixRuns: parseRefArray(value, 'fixRuns', ['findingId', 'autoFixRunId', 'status'], ['residualRiskRef']) as unknown as AutoFixRunRef[],
    commits: parseRefArray(value, 'commits', ['sha'], ['autoFixRunId']) as unknown as CommitRef[],
    ...parseOptionalRef(value, 'fullVerification', ['status'], ['runRef', 'snapshotRef']) === undefined
      ? {}
      : { fullVerification: parseOptionalRef(value, 'fullVerification', ['status'], ['runRef', 'snapshotRef']) as unknown as VerificationRef },
    ...(qa === undefined ? {} : { qa }),
    ...optionalString(value, 'finalAuditRunId') === undefined ? {} : { finalAuditRunId: optionalString(value, 'finalAuditRunId') },
    ...parseOptionalRef(value, 'blocker', ['code', 'message']) === undefined
      ? {}
      : { blocker: parseOptionalRef(value, 'blocker', ['code', 'message']) as unknown as RunBlocker },
  }
}

async function readStateFile(statePath: string): Promise<RunState> {
  let content: string
  try {
    const info = await lstat(statePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('state path must be a regular file')
    content = await readFile(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RunStateError('STATE_NOT_FOUND', `no state at ${statePath}`, { cause: error })
    }
    if (error instanceof RunStateError) throw error
    throw new RunStateError('STATE_CORRUPT', `cannot read ${statePath}`, { cause: error })
  }
  try {
    return parseRunState(JSON.parse(content))
  } catch (error) {
    if (error instanceof RunStateError && error.code === 'INVALID_RUN_ID') {
      throw new RunStateError('STATE_CORRUPT', `invalid run id in ${statePath}`, { cause: error })
    }
    throw new RunStateError('STATE_CORRUPT', `invalid state at ${statePath}`, { cause: error })
  }
}

async function writeStateFile(statePath: string, state: RunState): Promise<void> {
  parseRunState(state)
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
}

export async function loadRun(cwd: string, runId: string): Promise<RunState> {
  return await readStateFile(await resolveStatePath(cwd, runId))
}

export async function listRuns(cwd: string): Promise<RunState[]> {
  const root = await resolveStateRoot(cwd)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const states: RunState[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory()) {
      throw new RunStateError('STATE_CORRUPT', `unexpected entry in state root: ${entry.name}`)
    }
    assertRunId(entry.name)
    states.push(await readStateFile(join(root, entry.name, 'state.json')))
  }
  return states
}

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

export async function validateResume(
  state: RunState,
  cwd: string,
  options: CaptureEnvironmentOptions = {},
): Promise<void> {
  const current = await captureEnvironment(cwd, options)
  if (
    current.repo.worktreeRoot !== state.repo.worktreeRoot
    || current.repo.privateGitDir !== state.repo.privateGitDir
  ) {
    throw new RunStateError('WORKTREE_MISMATCH', 'canonical worktree or private Git dir changed')
  }
  if (current.repo.head !== state.repo.head) {
    throw new RunStateError('HEAD_MISMATCH', 'HEAD commit changed')
  }
  if (current.repo.branch !== state.repo.branch) {
    throw new RunStateError('HEAD_MISMATCH', 'Git branch changed')
  }
  if (current.contextFingerprint !== state.contextFingerprint) {
    throw new RunStateError('CONTEXT_MISMATCH', 'canonical Context fingerprint changed')
  }
  if (
    current.dependencies.lockfilePath !== state.dependencies.lockfilePath
    || current.dependencies.lockfileSha256 !== state.dependencies.lockfileSha256
    || !sameRecord(current.dependencies.packages, state.dependencies.packages)
  ) {
    throw new RunStateError('DEPENDENCY_MISMATCH', 'lockfile or resolved runtime package versions changed')
  }
  if (current.repo.worktreeFingerprint !== state.repo.worktreeFingerprint) {
    throw new RunStateError('WORKTREE_MISMATCH', 'tracked, staged, or untracked worktree content changed')
  }
}

export async function createRun(options: CreateRunOptions): Promise<RunState> {
  const runId = options.runId ?? generateRunId(options.now)
  assertRunId(runId)
  const initialEnvironment = await captureEnvironment(options.cwd, options)
  const stateRoot = join(initialEnvironment.repo.privateGitDir, 'dev-harness', 'dsh')
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  const registryLock = join(stateRoot, '.registry')
  return await withFileLock(registryLock, async () => {
    const environment = await captureEnvironment(options.cwd, options)
    if (
      environment.repo.worktreeRoot !== initialEnvironment.repo.worktreeRoot
      || environment.repo.privateGitDir !== initialEnvironment.repo.privateGitDir
    ) {
      throw new RunStateError('WORKTREE_MISMATCH', 'repository changed while creating the run')
    }
    const active = (await listRuns(options.cwd)).find(state => !TERMINAL_STATUSES.has(state.status))
    if (active !== undefined) {
      throw new RunStateError('ACTIVE_RUN_EXISTS', `run ${active.runId} is still ${active.status}`)
    }
    const runDirectory = join(stateRoot, runId)
    try {
      await mkdir(runDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RunStateError('RUN_EXISTS', `run ${runId} already exists`, { cause: error })
      }
      throw error
    }
    const timestamp = (options.now ?? new Date()).toISOString()
    const state: RunState = {
      schemaVersion: RUN_STATE_SCHEMA_VERSION,
      revision: 0,
      runId,
      ...environment,
      phase: 'INIT',
      status: 'RUNNING',
      createdAt: timestamp,
      updatedAt: timestamp,
      findings: [],
      fixRuns: [],
      commits: [],
    }
    const statePath = join(runDirectory, 'state.json')
    try {
      await writeStateFile(statePath, state)
    } catch (error) {
      await rmdir(runDirectory).catch(() => undefined)
      throw error
    }
    return state
  })
}

function assertImmutable(previous: RunState, next: RunState): void {
  const immutable = ['schemaVersion', 'runId', 'repo', 'contextFingerprint', 'dependencies', 'createdAt'] as const
  for (const key of immutable) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      throw new RunStateError('INVALID_TRANSITION', `${key} is immutable`)
    }
  }
}

function assertTransition(previous: RunState, next: RunState): void {
  if (TERMINAL_STATUSES.has(previous.status)) {
    throw new RunStateError('TERMINAL_RUN', `run ${previous.runId} already ended as ${previous.status}`)
  }
  if (
    next.phase !== previous.phase
    && !PHASE_TRANSITIONS[previous.phase].includes(next.phase)
  ) {
    throw new RunStateError('INVALID_TRANSITION', `${previous.phase} cannot transition to ${next.phase}`)
  }
  if (
    next.status !== previous.status
    && !STATUS_TRANSITIONS[previous.status].includes(next.status)
  ) {
    throw new RunStateError('INVALID_TRANSITION', `${previous.status} cannot transition to ${next.status}`)
  }
  if (next.phase === 'DONE' && !['DONE', 'DONE_WITH_CONCERNS'].includes(next.status)) {
    throw new RunStateError('INVALID_TRANSITION', 'DONE phase requires a successful terminal status')
  }
  if (['DONE', 'DONE_WITH_CONCERNS'].includes(next.status) && next.phase !== 'DONE') {
    throw new RunStateError('INVALID_TRANSITION', `${next.status} requires DONE phase`)
  }
}

export async function updateRun(options: UpdateRunOptions): Promise<RunState> {
  const statePath = await resolveStatePath(options.cwd, options.runId)
  return await withFileLock(statePath, async () => {
    const previous = await readStateFile(statePath)
    if (previous.revision !== options.expectedRevision) {
      throw new RunStateError(
        'REVISION_CONFLICT',
        `expected revision ${options.expectedRevision}, found ${previous.revision}`,
      )
    }
    await validateResume(previous, options.cwd, {
      lockfilePath: previous.dependencies.lockfilePath,
      runtimeDependencies: options.runtimeDependencies,
    })
    const next = structuredClone(previous)
    options.mutate(next)
    assertImmutable(previous, next)
    assertTransition(previous, next)
    next.revision = previous.revision + 1
    next.updatedAt = (options.now ?? new Date()).toISOString()
    parseRunState(next)
    await validateResume(previous, options.cwd, {
      lockfilePath: previous.dependencies.lockfilePath,
      runtimeDependencies: options.runtimeDependencies,
    })
    await writeStateFile(statePath, next)
    return next
  })
}

export async function adoptWorktreeBoundary(options: AdoptWorktreeBoundaryOptions): Promise<RunState> {
  const statePath = await resolveStatePath(options.cwd, options.runId)
  return await withFileLock(statePath, async () => {
    const previous = await readStateFile(statePath)
    if (previous.revision !== options.expectedRevision) {
      throw new RunStateError(
        'REVISION_CONFLICT',
        `expected revision ${options.expectedRevision}, found ${previous.revision}`,
      )
    }
    if (
      options.before.worktreeRoot !== previous.repo.worktreeRoot
      || options.before.fingerprint !== previous.repo.worktreeFingerprint
    ) {
      throw new RunStateError('WORKTREE_MISMATCH', 'mutation lease did not open from the current Run baseline')
    }
    const actualPaths = diffWorktreeBoundaries(options.before, options.boundary)
    const acceptedPaths = [...new Set(options.acceptedPaths)].sort()
    if (JSON.stringify(actualPaths) !== JSON.stringify(acceptedPaths)) {
      throw new RunStateError('WORKTREE_MISMATCH', 'mutation boundary changed paths do not match the accepted output set')
    }
    const current = await captureEnvironment(options.cwd, {
      lockfilePath: previous.dependencies.lockfilePath,
      runtimeDependencies: options.runtimeDependencies,
    })
    assertAdoptableEnvironment(previous, current)
    if (
      options.boundary.worktreeRoot !== current.repo.worktreeRoot
      || options.boundary.fingerprint !== current.repo.worktreeFingerprint
    ) {
      throw new RunStateError('WORKTREE_MISMATCH', 'accepted mutation boundary is not the current worktree')
    }
    const next = structuredClone(previous)
    next.repo.worktreeFingerprint = current.repo.worktreeFingerprint
    next.revision = previous.revision + 1
    next.updatedAt = (options.now ?? new Date()).toISOString()
    const confirmed = await captureEnvironment(options.cwd, {
      lockfilePath: previous.dependencies.lockfilePath,
      runtimeDependencies: options.runtimeDependencies,
    })
    assertAdoptableEnvironment(previous, confirmed)
    if (confirmed.repo.worktreeFingerprint !== next.repo.worktreeFingerprint) {
      throw new RunStateError('WORKTREE_MISMATCH', 'worktree changed while accepting a mutation boundary')
    }
    parseRunState(next)
    await writeStateFile(statePath, next)
    return next
  })
}

function assertAdoptableEnvironment(
  previous: RunState,
  current: Awaited<ReturnType<typeof captureEnvironment>>,
): void {
  if (
    current.repo.worktreeRoot !== previous.repo.worktreeRoot
    || current.repo.privateGitDir !== previous.repo.privateGitDir
  ) {
    throw new RunStateError('WORKTREE_MISMATCH', 'canonical worktree or private Git dir changed')
  }
  if (current.repo.head !== previous.repo.head) {
    throw new RunStateError('HEAD_MISMATCH', 'HEAD commit changed')
  }
  if (current.repo.branch !== previous.repo.branch) {
    throw new RunStateError('HEAD_MISMATCH', 'Git branch changed')
  }
  if (current.contextFingerprint !== previous.contextFingerprint) {
    throw new RunStateError('CONTEXT_MISMATCH', 'canonical Context fingerprint changed')
  }
  if (
    current.dependencies.lockfilePath !== previous.dependencies.lockfilePath
    || current.dependencies.lockfileSha256 !== previous.dependencies.lockfileSha256
    || !sameRecord(current.dependencies.packages, previous.dependencies.packages)
  ) {
    throw new RunStateError('DEPENDENCY_MISMATCH', 'lockfile or resolved runtime package versions changed')
  }
}
