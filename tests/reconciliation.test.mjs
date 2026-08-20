import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const cwd = await mkdtemp(join(tmpdir(), 'dev-harness-reconciliation-'))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Reconciliation Test')
  await git(cwd, 'config', 'user.email', 'reconciliation@example.invalid')
  for (const [path, content] of [
    ['README.md', '# Fixture\n'],
    ['AGENTS.md', '# Agents\n'],
    ['ARCHITECTURE.md', '# Architecture\n'],
    ['HARNESS.md', '# Harness\n'],
    ['source.txt', 'baseline\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
    ['docs/README.md', '# Docs\n'],
    ['docs/audit/Dashboard.md', '# Initial Dashboard\n'],
    ['docs/audit/Findings.md', '# Initial Findings\n'],
    ['docs/audit/Report.md', '# Initial Report\n'],
  ]) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), content)
  }
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', 'fixture')
  return cwd
}

async function qaPassedRun(cwd, runId) {
  let state = await Plugin.createRun({ cwd, runId })
  for (const phase of ['PREFLIGHT', 'AUDIT', 'ROUTE', 'REMEDIATE', 'FULL_VERIFY', 'QA']) {
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
            snapshotRef: `audit:snapshot:${runId}:original`,
            registryRef: 'docs/audit/Findings.md',
            reportRef: 'docs/audit/Report.md',
            crossModuleStatus: 'completed',
          }
        } else if (phase === 'ROUTE') {
          next.findings = [
            { findingId: 'AUD-001', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect' },
            { findingId: 'AUD-002', status: 'rejected', route: 'closed' },
          ]
        } else if (phase === 'REMEDIATE') {
          next.fixRuns.push({
            findingId: 'AUD-001',
            autoFixRunId: 'fix-aud-001',
            status: 'DONE',
            observationRevision: 1,
            stateDigest: 'a'.repeat(64),
            executionRef: 'autofix:execution:AUD-001',
            workspaceSnapshotRef: 'autofix:snapshot:AUD-001',
            workspaceBaseFingerprint: next.repo.worktreeFingerprint,
          })
          delete next.currentFinding
        } else if (phase === 'FULL_VERIFY') {
          next.fullVerification = {
            verificationRunId: `verify-${runId}`,
            executionStatus: 'COMPLETED',
            status: 'PASS',
            revision: 1,
            command: Plugin.FULL_VERIFICATION_COMMAND,
            runRef: `verification:run:${runId}`,
            snapshotRef: `verification:snapshot:${runId}`,
            workspaceFingerprint: next.repo.worktreeFingerprint,
            evidenceRef: `verification:evidence:${runId}`,
          }
        } else if (phase === 'QA') {
          next.qa.currentAttempt = 1
          next.qa.runs.push({
            qaRunId: `qa-${runId}`,
            attempt: 1,
            adapterName: 'fixture-qa',
            adapterKind: 'cli-api',
            adapterVerificationEvidenceRef: 'qa:adapter-verification:fixture',
            revision: 1,
            executionStatus: 'COMPLETED',
            resultStatus: 'PASS',
            runRef: `qa:run:${runId}`,
            verificationRunId: `verify-${runId}`,
            verificationSnapshotRef: `verification:snapshot:${runId}`,
            workspaceFingerprint: next.repo.worktreeFingerprint,
            evidenceRef: `qa:evidence:${runId}`,
            manualChecklist: [],
          })
        }
      },
    })
  }
  return state
}

async function writeReconciliation(cwd, suffix) {
  await writeFile(join(cwd, 'docs/audit/Findings.md'), `# Reconciled Findings ${suffix}\n`)
  await writeFile(join(cwd, 'docs/audit/Report.md'), `# Reconciliation Report ${suffix}\n`)
}

async function observation(request, executionStatus, revision) {
  const boundary = await Plugin.captureWorktreeBoundary(request.cwd)
  const completed = executionStatus === 'COMPLETED'
  return {
    contractVersion: 1,
    runId: request.reconciliationRunId,
    revision,
    executionStatus,
    repositoryRoot: request.cwd,
    head: request.expectedHead,
    branch: request.expectedBranch,
    workspaceFingerprint: request.expectedWorkspaceFingerprint,
    contextFingerprint: request.contextFingerprint,
    originalAuditRunId: request.originalAuditRunId,
    originalSnapshotRef: request.originalSnapshotRef,
    freshSnapshotRef: `audit:snapshot:${request.reconciliationRunId}:fresh`,
    runRef: `reconciliation:run:${request.reconciliationRunId}`,
    registryRef: 'docs/audit/Findings.md',
    reportRef: 'docs/audit/Report.md',
    startedAt: '2026-08-20T12:00:00.000Z',
    ...(completed ? {
      finishedAt: '2026-08-20T12:01:00.000Z',
      evidenceRef: 'docs/audit/Report.md#final-reconciliation',
    } : {}),
    findings: completed
      ? [
          { findingId: 'AUD-001', status: 'resolved', evidenceRef: 'docs/audit/Findings.md#aud-001' },
          { findingId: 'AUD-002', status: 'rejected', evidenceRef: 'docs/audit/Findings.md#aud-002' },
        ]
      : [],
    businessDirtyFiles: Object.keys(boundary.changedPaths).filter(path => !path.startsWith('docs/audit/')).sort(),
    auditOutputs: Object.entries(boundary.changedPaths)
      .filter(([path]) => path.startsWith('docs/audit/'))
      .map(([path, fingerprint]) => ({ path, fingerprint })),
    workspaceVerified: true,
    quiescent: true,
  }
}

test('resumes one fresh reconciliation and accepts only authoritative original Finding outcomes', async () => {
  const cwd = await repository()
  let starts = 0
  let resumes = 0
  const adapter = {
    name: 'fixture-reconciliation',
    async start(request) {
      starts++
      assert.deepEqual(request.originalFindingIds, ['AUD-001', 'AUD-002'])
      await writeReconciliation(request.cwd, 'running')
      return await observation(request, 'RUNNING', 1)
    },
    async resume(request) {
      resumes++
      assert.equal(request.expectedRevision, 1)
      assert.equal(request.expectedFreshSnapshotRef, `audit:snapshot:${request.reconciliationRunId}:fresh`)
      await writeReconciliation(request.cwd, 'completed')
      return await observation(request, 'COMPLETED', 2)
    },
  }
  try {
    const initial = await qaPassedRun(cwd, 'reconcile-resume')
    const paused = await Plugin.advanceFinalReconciliation({ cwd, runId: initial.runId, adapter, signal: new AbortController().signal })
    assert.equal(paused.phase, 'FINAL_RECONCILE')
    assert.equal(paused.status, 'PAUSED')
    assert.equal(paused.finalReconciliation.executionStatus, 'RUNNING')
    assert.notEqual(paused.finalReconciliation.freshSnapshotRef, paused.auditResult.snapshotRef)
    const completed = await Plugin.advanceFinalReconciliation({ cwd, runId: initial.runId, adapter, signal: new AbortController().signal })
    assert.equal(completed.status, 'RUNNING')
    assert.equal(completed.finalReconciliation.executionStatus, 'COMPLETED')
    assert.deepEqual(completed.finalReconciliation.findings.map(finding => finding.status), ['resolved', 'rejected'])
    assert.equal(starts, 1)
    assert.equal(resumes, 1)
    assert.deepEqual(await Plugin.advanceFinalReconciliation({ cwd, runId: initial.runId, adapter, signal: new AbortController().signal }), completed)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('recovers idempotent start after output write and rejects mutations outside the Audit root', async () => {
  const crashCwd = await repository()
  let starts = 0
  const crashAdapter = {
    name: 'crash-reconciliation',
    async start(request) {
      starts++
      if (starts === 1) {
        await writeReconciliation(request.cwd, 'before-crash')
        throw new Error('simulated reconciliation crash')
      }
      return await observation(request, 'COMPLETED', 1)
    },
    async resume() {
      throw new Error('not expected before first checkpoint')
    },
  }
  try {
    const initial = await qaPassedRun(crashCwd, 'reconcile-crash')
    await assert.rejects(
      Plugin.advanceFinalReconciliation({ cwd: crashCwd, runId: initial.runId, adapter: crashAdapter, signal: new AbortController().signal }),
      /simulated reconciliation crash/u,
    )
    const leased = await Plugin.loadRun(crashCwd, initial.runId)
    assert.equal(leased.finalReconciliationLease.status, 'OPEN')
    const recovered = await Plugin.advanceFinalReconciliation({ cwd: crashCwd, runId: initial.runId, adapter: crashAdapter, signal: new AbortController().signal })
    assert.equal(recovered.finalReconciliation.executionStatus, 'COMPLETED')
    assert.equal(starts, 2)
  } finally {
    await rm(crashCwd, { recursive: true, force: true })
  }

  const escapeCwd = await repository()
  const malicious = {
    name: 'malicious-reconciliation',
    async start(request) {
      await writeFile(join(request.cwd, 'source.txt'), 'escaped mutation\n')
      await writeReconciliation(request.cwd, 'invalid')
      return await observation(request, 'COMPLETED', 1)
    },
    async resume() {
      throw new Error('not expected')
    },
  }
  try {
    const initial = await qaPassedRun(escapeCwd, 'reconcile-escape')
    await assert.rejects(
      Plugin.advanceFinalReconciliation({ cwd: escapeCwd, runId: initial.runId, adapter: malicious, signal: new AbortController().signal }),
      /outside its output root/u,
    )
    const leased = await Plugin.loadRun(escapeCwd, initial.runId)
    assert.equal(leased.finalReconciliationLease.status, 'OPEN')
    assert.equal(leased.phase, 'FINAL_RECONCILE')
  } finally {
    await rm(escapeCwd, { recursive: true, force: true })
  }
})

test('refuses stale workspace identity and missing authoritative QA PASS', async () => {
  const cwd = await repository()
  const adapter = { name: 'unused-reconciliation', async start() {}, async resume() {} }
  try {
    const state = await qaPassedRun(cwd, 'reconcile-preconditions')
    await writeFile(join(cwd, 'source.txt'), 'drifted\n')
    await assert.rejects(
      Plugin.advanceFinalReconciliation({ cwd, runId: state.runId, adapter, signal: new AbortController().signal }),
      error => error.code === 'WORKTREE_MISMATCH',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }

  const missingQaCwd = await repository()
  try {
    let state = await qaPassedRun(missingQaCwd, 'reconcile-no-qa')
    state = await Plugin.updateRun({
      cwd: missingQaCwd,
      runId: state.runId,
      expectedRevision: state.revision,
      mutate(next) {
        next.qa.currentAttempt = 0
        next.qa.runs = []
      },
    })
    await assert.rejects(
      Plugin.advanceFinalReconciliation({ cwd: missingQaCwd, runId: state.runId, adapter, signal: new AbortController().signal }),
      /authoritative QA PASS/u,
    )
  } finally {
    await rm(missingQaCwd, { recursive: true, force: true })
  }
})
