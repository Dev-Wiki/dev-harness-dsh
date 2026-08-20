import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AuthorizationError,
  assertExternalActionAuthorized,
  assertRunAuthorization,
  autoFixExecutionMode,
  createRunAuthorization,
} from '../lib/index.js'

test('defaults to fix-only and maps only explicit commit-each to commit mode', () => {
  const defaultAuthorization = createRunAuthorization()
  assert.equal(defaultAuthorization.autoFix, 'fix-only')
  assert.equal(autoFixExecutionMode(defaultAuthorization), 'fix')

  const commitAuthorization = createRunAuthorization('commit-each')
  assert.equal(autoFixExecutionMode(commitAuthorization), 'commit')
  assert.deepEqual(commitAuthorization.externalActions, {
    push: false,
    'pull-request': false,
    tag: false,
    release: false,
    deploy: false,
  })
})

test('rejects implicit expansion and every independently authorized external action', () => {
  const authorization = createRunAuthorization('commit-each')
  for (const action of ['push', 'pull-request', 'tag', 'release', 'deploy']) {
    assert.throws(
      () => assertExternalActionAuthorized(authorization, action),
      error => error instanceof AuthorizationError && /requires independent authorization/u.test(error.message),
    )
  }
  assert.throws(
    () => assertRunAuthorization({
      ...authorization,
      externalActions: { ...authorization.externalActions, push: true },
    }),
    /must remain independently unauthorized/u,
  )
  assert.throws(() => createRunAuthorization('unattended'), /unknown Auto Fix authorization/u)
})
