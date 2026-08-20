import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import * as Plugin from '../lib/index.js'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args])
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-harness-verification-'))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Verification Test')
  await git(cwd, 'config', 'user.email', 'verification@example.invalid')
  for (const [path, content] of [
    ['README.md', '# Fixture\n'],
    ['AGENTS.md', '# Agents\n'],
    ['ARCHITECTURE.md', '# Architecture\n'],
    ['HARNESS.md', '# Harness\n'],
    ['source.txt', 'source baseline\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
  ]) await writeFile(join(cwd, path), content)
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', 'fixture')
  return cwd
}

async function remediatedRun(cwd, runId) {
  let state = await Plugin.createRun({ cwd, runId })
  for (const phase of ['PREFLIGHT', 'AUDIT', 'ROUTE', 'REMEDIATE']) {
    state = await Plugin.updateRun({
      cwd,
      runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.phase = phase
        if (phase === 'AUDIT') {
          next.auditRunId = `audit-${runId}`
          next.auditResult = {
            status: 'COMPLETED',
            executionStatus: 'COMPLETED',
            revision: 1,
            snapshotRef: 'audit:snapshot:1',
            registryRef: 'docs/audit/Findings.md',
            reportRef: 'docs/audit/Report.md',
            crossModuleStatus: 'completed',
          }
        }
      },
    })
  }
  return state
}

function observation(request, options = {}) {
  const executionStatus = options.executionStatus ?? 'COMPLETED'
  const terminal = executionStatus !== 'RUNNING' && executionStatus !== 'CANCELLED'
  return {
    contractVersion: 1,
    runId: request.verificationRunId,
    revision: options.revision ?? 1,
    executionStatus,
    ...(options.resultStatus === undefined ? {} : { resultStatus: options.resultStatus }),
    command: request.command,
    repositoryRoot: request.cwd,
    head: request.expectedHead,
    branch: request.expectedBranch,
    workspaceFingerprint: request.expectedWorkspaceFingerprint,
    snapshotRef: request.expectedSnapshotRef,
    runRef: 'verification:run:fixture',
    startedAt: '2026-08-20T12:00:00.000Z',
    ...(terminal ? {
      finishedAt: '2026-08-20T12:01:00.000Z',
      evidenceRef: `verification:evidence:${options.resultStatus}`,
    } : {}),
    workspaceVerified: true,
    quiescent: true,
  }
}

test('checkpoints RUNNING then resumes the same canonical full verification to PASS', async () => {
  const cwd = await repository()
  const state = await remediatedRun(cwd, 'verification-resume')
  let starts = 0
  let resumes = 0
  let verificationRunId
  const adapter = {
    name: 'resumable-verification',
    async start(request) {
      starts++
      verificationRunId = request.verificationRunId
      assert.equal(request.command, 'npm run harness:full')
      return observation(request, { executionStatus: 'RUNNING' })
    },
    async resume(request) {
      resumes++
      assert.equal(request.verificationRunId, verificationRunId)
      assert.equal(request.expectedRevision, 1)
      assert.equal(request.expectedRunRef, 'verification:run:fixture')
      return observation(request, { revision: 2, resultStatus: 'PASS' })
    },
  }
  try {
    const paused = await Plugin.advanceFullVerification({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(paused.phase, 'FULL_VERIFY')
    assert.equal(paused.status, 'PAUSED')
    assert.equal(paused.fullVerification.executionStatus, 'RUNNING')
    assert.equal(paused.fullVerification.command, 'npm run harness:full')
    await Plugin.validateResume(paused, cwd)

    const passed = await Plugin.advanceFullVerification({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(passed.status, 'RUNNING')
    assert.equal(passed.fullVerification.status, 'PASS')
    assert.equal(passed.fullVerification.revision, 2)
    assert.equal(passed.fullVerification.snapshotRef, paused.fullVerification.snapshotRef)
    assert.equal(starts, 1)
    assert.equal(resumes, 1)
    await Plugin.validateResume(passed, cwd)
    assert.deepEqual(await Plugin.advanceFullVerification({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), passed)
    assert.equal(resumes, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

for (const scenario of [
  { resultStatus: 'FAIL', expectedStatus: 'FAILED', code: 'FULL_VERIFICATION_FAILED' },
  { resultStatus: 'ENTRY_MISSING', expectedStatus: 'BLOCKED', code: 'FULL_VERIFICATION_ENTRY_MISSING' },
  { resultStatus: 'ENVIRONMENT_UNAVAILABLE', expectedStatus: 'BLOCKED', code: 'FULL_VERIFICATION_ENVIRONMENT_UNAVAILABLE' },
  { resultStatus: 'EXECUTION_FAILED', executionStatus: 'FAILED', expectedStatus: 'FAILED', code: 'FULL_VERIFICATION_EXECUTION_FAILED' },
]) {
  test(`${scenario.resultStatus} is preserved as a distinct orchestration outcome`, async () => {
    const cwd = await repository()
    const runId = `verification-${scenario.resultStatus.toLowerCase().replaceAll('_', '-')}`
    const state = await remediatedRun(cwd, runId)
    const adapter = {
      name: 'terminal-verification',
      async start(request) {
        return observation(request, {
          executionStatus: scenario.executionStatus,
          resultStatus: scenario.resultStatus,
        })
      },
      async resume() { throw new Error('not reached') },
    }
    try {
      const result = await Plugin.advanceFullVerification({
        cwd, runId: state.runId, adapter, signal: new AbortController().signal,
      })
      assert.equal(result.status, scenario.expectedStatus)
      assert.equal(result.fullVerification.status, scenario.resultStatus)
      assert.equal(result.blocker.code, scenario.code)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

test('recovers an idempotent verification start after an Adapter crash', async () => {
  const cwd = await repository()
  const state = await remediatedRun(cwd, 'verification-crash')
  let starts = 0
  let runId
  const adapter = {
    name: 'crash-safe-verification',
    async start(request) {
      starts++
      runId ??= request.verificationRunId
      assert.equal(request.verificationRunId, runId)
      if (starts === 1) throw new Error('simulated verification crash')
      return observation(request, { resultStatus: 'PASS' })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    await assert.rejects(Plugin.advanceFullVerification({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), /simulated verification crash/u)
    const interrupted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(interrupted.fullVerificationLease.status, 'OPEN')
    assert.equal(interrupted.fullVerification, undefined)

    const recovered = await Plugin.advanceFullVerification({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(recovered.fullVerification.status, 'PASS')
    assert.equal(recovered.fullVerificationLease, undefined)
    assert.equal(starts, 2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('rejects verification worktree mutations and retains the OPEN lease', async () => {
  const cwd = await repository()
  const state = await remediatedRun(cwd, 'verification-mutation')
  const adapter = {
    name: 'mutating-verification',
    async start(request) {
      await writeFile(join(request.cwd, 'source.txt'), 'verification side effect\n')
      return observation(request, { executionStatus: 'RUNNING' })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    await assert.rejects(Plugin.advanceFullVerification({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), /changed the Git worktree/u)
    const persisted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(persisted.fullVerificationLease.status, 'OPEN')
    assert.equal(persisted.fullVerification, undefined)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('refuses to verify while a confirmed Auto Fix Finding remains', async () => {
  const cwd = await repository()
  const state = await remediatedRun(cwd, 'verification-pending-fix')
  const pending = await Plugin.updateRun({
    cwd,
    runId: state.runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.findings = [{ findingId: 'AUD-001', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect' }]
      next.currentFinding = 'AUD-001'
    },
  })
  try {
    await assert.rejects(Plugin.advanceFullVerification({
      cwd,
      runId: pending.runId,
      adapter: { name: 'unused-verification', start() {}, resume() {} },
      signal: new AbortController().signal,
    }), /while Auto Fix findings remain/u)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
