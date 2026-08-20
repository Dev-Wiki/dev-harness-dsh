export const AUTHORIZATION_SCHEMA_VERSION = 1 as const

export const AUTO_FIX_AUTHORIZATIONS = ['fix-only', 'commit-each'] as const
export type AutoFixAuthorization = typeof AUTO_FIX_AUTHORIZATIONS[number]

export const EXTERNAL_ACTIONS = ['push', 'pull-request', 'tag', 'release', 'deploy'] as const
export type ExternalAction = typeof EXTERNAL_ACTIONS[number]

export interface RunAuthorization {
  readonly schemaVersion: typeof AUTHORIZATION_SCHEMA_VERSION
  readonly autoFix: AutoFixAuthorization
  readonly externalActions: Readonly<Record<ExternalAction, false>>
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}

export function createRunAuthorization(autoFix: AutoFixAuthorization = 'fix-only'): RunAuthorization {
  if (!(AUTO_FIX_AUTHORIZATIONS as readonly string[]).includes(autoFix)) {
    throw new AuthorizationError(`unknown Auto Fix authorization: ${String(autoFix)}`)
  }
  return Object.freeze({
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    autoFix,
    externalActions: Object.freeze({
      push: false,
      'pull-request': false,
      tag: false,
      release: false,
      deploy: false,
    }),
  })
}

export function autoFixExecutionMode(authorization: RunAuthorization): 'fix' | 'commit' {
  assertRunAuthorization(authorization)
  return authorization.autoFix === 'commit-each' ? 'commit' : 'fix'
}

export function assertExternalActionAuthorized(
  authorization: RunAuthorization,
  action: ExternalAction,
): never {
  assertRunAuthorization(authorization)
  if (!(EXTERNAL_ACTIONS as readonly string[]).includes(action)) {
    throw new AuthorizationError(`unknown external action: ${String(action)}`)
  }
  throw new AuthorizationError(`${action} requires independent authorization outside this Run`)
}

export function assertRunAuthorization(value: unknown): asserts value is RunAuthorization {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuthorizationError('Run authorization must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION) {
    throw new AuthorizationError('unsupported Run authorization schemaVersion')
  }
  if (!(AUTO_FIX_AUTHORIZATIONS as readonly unknown[]).includes(record.autoFix)) {
    throw new AuthorizationError('invalid Auto Fix authorization')
  }
  const actions = record.externalActions
  if (typeof actions !== 'object' || actions === null || Array.isArray(actions)) {
    throw new AuthorizationError('externalActions must be an object')
  }
  const actionRecord = actions as Record<string, unknown>
  if (
    Object.keys(actionRecord).sort().join('\0') !== [...EXTERNAL_ACTIONS].sort().join('\0')
    || EXTERNAL_ACTIONS.some(action => actionRecord[action] !== false)
  ) {
    throw new AuthorizationError('external actions must remain independently unauthorized')
  }
}
