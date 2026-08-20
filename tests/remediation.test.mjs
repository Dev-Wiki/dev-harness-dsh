import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import * as Plugin from '../lib/index.js'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  return (await execFile('git', ['-C', cwd, ...args])).stdout.trim()
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-harness-remediation-'))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Remediation Test')
  await git(cwd, 'config', 'user.email', 'remediation@example.invalid')
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

async function routedRun(cwd, runId = 'remediation-fixture', authorization = 'fix-only') {
  let state = await Plugin.createRun({ cwd, runId, authorization })
  state = await Plugin.updateRun({
    cwd,
    runId,
    expectedRevision: state.revision,
    mutate(next) { next.phase = 'PREFLIGHT' },
  })
  state = await Plugin.updateRun({
    cwd,
    runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'AUDIT'
      next.auditRunId = `audit-${runId}`
      next.auditResult = {
        status: 'COMPLETED',
        executionStatus: 'COMPLETED',
        revision: 2,
        snapshotRef: 'audit:snapshot:1',
        registryRef: 'docs/audit/Findings.md',
        reportRef: 'docs/audit/Report.md',
        crossModuleStatus: 'completed',
      }
    },
  })
  return await Plugin.updateRun({
    cwd,
    runId,
    expectedRevision: state.revision,
    mutate(next) {
      next.phase = 'ROUTE'
      next.findings = [
        { findingId: 'AUD-001', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect-1' },
        { findingId: 'AUD-002', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect-2' },
        { findingId: 'AUD-003', status: 'confirmed', route: 'planning', handoffRef: 'handoff:plan-3' },
      ]
      next.currentFinding = 'AUD-001'
    },
  })
}

function sha(char) {
  return char.repeat(64)
}

async function observation(request, options = {}) {
  const completionStatus = options.completionStatus ?? 'DONE'
  const executionStatus = options.executionStatus ?? 'COMPLETED'
  const outputs = []
  for (const path of options.committed ? [] : (options.outputPaths ?? [])) {
    const boundary = await Plugin.captureWorktreeBoundary(request.cwd)
    outputs.push({ path, fingerprint: boundary.changedPaths[path] })
  }
  const complete = executionStatus === 'COMPLETED'
  return {
    contractVersion: 1,
    runId: request.autoFixRunId,
    findingId: request.findingId,
    handoffRef: request.handoffRef,
    auditRunId: request.auditRunId,
    auditSnapshotRef: request.auditSnapshotRef,
    findingRegistryRef: request.findingRegistryRef,
    mode: request.mode,
    executionStatus,
    ...(options.includeCompletion === false ? {} : { completionStatus }),
    revision: options.revision ?? 1,
    stateDigest: options.stateDigest ?? sha('a'),
    executionRef: `autofix:execution:${request.findingId}`,
    repositoryRoot: request.cwd,
    baseSha: request.expectedHead,
    branch: request.expectedBranch,
    workspaceSnapshotRef: `autofix:snapshot:${request.findingId}`,
    workspaceBaseFingerprint: request.expectedWorkspaceBaseFingerprint,
    stage: complete ? 'report' : (options.stage ?? 'implement'),
    changedFiles: options.outputPaths ?? [],
    changeOutputs: outputs,
    workspaceVerified: true,
    quiescent: true,
    ...(complete ? {
      regressionRedRef: `autofix:red:${request.findingId}`,
      regressionGreenRef: `autofix:green:${request.findingId}`,
      reviewOutcome: 'PASS',
      reviewEvidenceRef: `autofix:review:${request.findingId}`,
      reviewReviewer: 'independent',
      reviewDiffHash: sha('b'),
      finalVerificationRef: `autofix:verify:${request.findingId}`,
      finalVerificationObservedAt: '2026-08-20T12:00:00.000Z',
      finalVerificationDiffHash: sha('b'),
    } : {}),
    ...(completionStatus === 'DONE_WITH_CONCERNS'
      ? { residualRiskRef: `autofix:risk:${request.findingId}` }
      : {}),
    ...(options.blockerRef === undefined ? {} : { blockerRef: options.blockerRef }),
    ...(options.postCommitHead === undefined ? {} : {
      postCommitHead: options.postCommitHead,
      postCommitWorkspaceFingerprint: options.postCommitWorkspaceFingerprint,
    }),
    commits: options.commits ?? [],
  }
}

test('serializes confirmed defects into independent fix-only runs and retains residual risk', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd)
  const starts = []
  const adapter = {
    name: 'fixture-auto-fix',
    async start(request) {
      starts.push({ findingId: request.findingId, runId: request.autoFixRunId, mode: request.mode })
      const path = request.findingId === 'AUD-001' ? 'fix-one.txt' : 'fix-two.txt'
      await writeFile(join(request.cwd, path), `${request.findingId}\n`)
      return await observation(request, {
        completionStatus: request.findingId === 'AUD-001' ? 'DONE' : 'DONE_WITH_CONCERNS',
        outputPaths: [path],
      })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    const first = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(first.phase, 'REMEDIATE')
    assert.equal(first.currentFinding, 'AUD-002')
    assert.deepEqual(first.fixRuns.map(run => [run.findingId, run.status]), [['AUD-001', 'DONE']])
    await Plugin.validateResume(first, cwd)

    const second = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(second.currentFinding, undefined)
    assert.deepEqual(second.fixRuns.map(run => [run.findingId, run.status]), [
      ['AUD-001', 'DONE'],
      ['AUD-002', 'DONE_WITH_CONCERNS'],
    ])
    assert.equal(second.fixRuns[1].residualRiskRef, 'autofix:risk:AUD-002')
    assert.deepEqual(starts.map(item => item.mode), ['fix', 'fix'])
    assert.notEqual(starts[0].runId, starts[1].runId)
    assert.deepEqual(second.commits, [])
    assert.equal(second.findings.find(item => item.findingId === 'AUD-003').route, 'planning')
    await Plugin.validateResume(second, cwd)

    const raw = await readFile(await Plugin.resolveStatePath(cwd, state.runId), 'utf8')
    assert.equal(raw.includes('Hypotheses'), false)
    assert.equal(raw.includes('RegressionRedEvidence'), false)
    assert.equal(raw.includes('Review Diff'), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('resumes the same paused Auto Fix run from its authoritative checkpoint', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-resume')
  let starts = 0
  let resumes = 0
  let stableRunId
  const adapter = {
    name: 'resumable-auto-fix',
    async start(request) {
      starts++
      stableRunId = request.autoFixRunId
      await writeFile(join(request.cwd, 'fix-one.txt'), 'partial\n')
      return await observation(request, {
        executionStatus: 'RUNNING',
        includeCompletion: false,
        outputPaths: ['fix-one.txt'],
      })
    },
    async resume(request) {
      resumes++
      assert.equal(request.autoFixRunId, stableRunId)
      assert.equal(request.expectedRevision, 1)
      assert.equal(request.expectedWorkspaceSnapshotRef, 'autofix:snapshot:AUD-001')
      return await observation(request, {
        revision: 2,
        stateDigest: sha('c'),
        outputPaths: ['fix-one.txt'],
      })
    },
  }
  try {
    const paused = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(paused.status, 'PAUSED')
    assert.equal(paused.fixRuns[0].status, 'RUNNING')
    const completed = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(completed.status, 'RUNNING')
    assert.equal(completed.fixRuns[0].status, 'DONE')
    assert.equal(completed.currentFinding, 'AUD-002')
    assert.equal(starts, 1)
    assert.equal(resumes, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('recovers an idempotent start after the Adapter wrote a fix and crashed', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-crash')
  let starts = 0
  let runId
  const adapter = {
    name: 'crash-safe-auto-fix',
    async start(request) {
      starts++
      runId ??= request.autoFixRunId
      assert.equal(request.autoFixRunId, runId)
      if (starts === 1) {
        await writeFile(join(request.cwd, 'fix-one.txt'), 'written-before-crash\n')
        throw new Error('simulated Auto Fix crash')
      }
      return await observation(request, { outputPaths: ['fix-one.txt'] })
    },
    async resume() { throw new Error('start remains idempotent before the first checkpoint') },
  }
  try {
    await assert.rejects(Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), /simulated Auto Fix crash/u)
    const interrupted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(interrupted.autoFixLease.status, 'OPEN')
    assert.equal(interrupted.fixRuns.length, 0)

    const recovered = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(recovered.autoFixLease, undefined)
    assert.equal(recovered.fixRuns[0].status, 'DONE')
    assert.equal(starts, 2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

for (const [executionStatus, completionStatus, expectedStatus, code] of [
  ['BLOCKED', 'BLOCKED', 'BLOCKED', 'AUTO_FIX_BLOCKED'],
  ['NEEDS_CONTEXT', 'NEEDS_CONTEXT', 'NEEDS_USER', 'AUTO_FIX_NEEDS_CONTEXT'],
]) {
  test(`${completionStatus} stops the remediation queue with an explicit orchestration status`, async () => {
    const cwd = await repository()
    const state = await routedRun(cwd, `remediation-${completionStatus.toLowerCase().replace('_', '-')}`)
    const adapter = {
      name: 'stopping-auto-fix',
      async start(request) {
        return await observation(request, {
          executionStatus,
          completionStatus,
          outputPaths: [],
          blockerRef: `autofix:blocker:${request.findingId}`,
        })
      },
      async resume() { throw new Error('not reached') },
    }
    try {
      const stopped = await Plugin.advanceRemediationRun({
        cwd, runId: state.runId, adapter, signal: new AbortController().signal,
      })
      assert.equal(stopped.status, expectedStatus)
      assert.equal(stopped.currentFinding, 'AUD-001')
      assert.equal(stopped.blocker.code, code)
      assert.equal(stopped.fixRuns.length, 1)
      assert.equal(stopped.fixRuns[0].status, completionStatus)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

test('rejects undeclared changes and retains the open mutation lease', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-escape')
  const adapter = {
    name: 'malicious-auto-fix',
    async start(request) {
      await writeFile(join(request.cwd, 'source.txt'), 'undeclared mutation\n')
      return await observation(request, {
        executionStatus: 'RUNNING',
        includeCompletion: false,
        outputPaths: [],
      })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    await assert.rejects(Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), /undeclared path: source.txt/u)
    const persisted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(persisted.autoFixLease.status, 'OPEN')
    assert.equal(persisted.fixRuns.length, 0)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('fails closed when a later fix-only run overlaps an earlier run-owned file', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-overlap')
  const adapter = {
    name: 'overlap-auto-fix',
    async start(request) {
      await writeFile(join(request.cwd, 'shared.txt'), `${request.findingId}\n`)
      return await observation(request, { outputPaths: ['shared.txt'] })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    const first = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(first.currentFinding, 'AUD-002')
    await assert.rejects(Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), /claimed a preexisting changed path: shared.txt/u)
    const persisted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(persisted.autoFixLease.findingId, 'AUD-002')
    assert.equal(persisted.fixRuns.length, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('commit-each delegates one exact commit per Finding and advances the accepted HEAD', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-commit-each', 'commit-each')
  const starts = []
  const adapter = {
    name: 'committing-auto-fix',
    async start(request) {
      starts.push({ findingId: request.findingId, mode: request.mode, parent: request.expectedHead })
      const path = request.findingId === 'AUD-001' ? 'committed-one.txt' : 'committed-two.txt'
      await writeFile(join(request.cwd, path), `${request.findingId}\n`)
      await git(request.cwd, 'add', '--', path)
      await git(request.cwd, 'commit', '-m', `Fix ${request.findingId}`)
      const commitSha = await git(request.cwd, 'rev-parse', 'HEAD')
      const boundary = await Plugin.captureWorktreeBoundary(request.cwd)
      return await observation(request, {
        committed: true,
        outputPaths: [path],
        postCommitHead: commitSha,
        postCommitWorkspaceFingerprint: boundary.fingerprint,
        commits: [{
          sha: commitSha,
          parentSha: request.expectedHead,
          changedFiles: [path],
          reviewDiffHash: sha('b'),
          commitEvidenceRef: `git-workflow:commit:${request.findingId}`,
        }],
      })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    const first = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(first.commits.length, 1)
    assert.equal(first.repo.head, first.commits[0].sha)
    assert.equal(first.commits[0].parentSha, starts[0].parent)
    assert.deepEqual(first.commits[0].changedFiles, ['committed-one.txt'])
    assert.equal(first.currentFinding, 'AUD-002')
    await Plugin.validateResume(first, cwd)

    const second = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(second.commits.length, 2)
    assert.equal(second.commits[1].parentSha, second.commits[0].sha)
    assert.equal(second.repo.head, second.commits[1].sha)
    assert.deepEqual(starts.map(item => item.mode), ['commit', 'commit'])
    assert.equal(new Set(second.commits.map(commit => commit.autoFixRunId)).size, 2)
    assert.equal(second.currentFinding, undefined)
    await Plugin.validateResume(second, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('rejects a downstream commit containing undeclared files and retains its lease', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-commit-scope', 'commit-each')
  const adapter = {
    name: 'overbroad-commit-auto-fix',
    async start(request) {
      await writeFile(join(request.cwd, 'declared.txt'), 'declared\n')
      await writeFile(join(request.cwd, 'extra.txt'), 'extra\n')
      await git(request.cwd, 'add', '--', 'declared.txt', 'extra.txt')
      await git(request.cwd, 'commit', '-m', 'Overbroad downstream commit')
      const commitSha = await git(request.cwd, 'rev-parse', 'HEAD')
      const boundary = await Plugin.captureWorktreeBoundary(request.cwd)
      return await observation(request, {
        committed: true,
        outputPaths: ['declared.txt'],
        postCommitHead: commitSha,
        postCommitWorkspaceFingerprint: boundary.fingerprint,
        commits: [{
          sha: commitSha,
          parentSha: request.expectedHead,
          changedFiles: ['declared.txt'],
          reviewDiffHash: sha('b'),
          commitEvidenceRef: 'git-workflow:commit:overbroad',
        }],
      })
    },
    async resume() { throw new Error('not reached') },
  }
  try {
    await assert.rejects(Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    }), error => error.code === 'WORKTREE_MISMATCH' && /commit paths/u.test(error.message))
    const persisted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(persisted.autoFixLease.status, 'OPEN')
    assert.equal(persisted.commits.length, 0)
    assert.equal(persisted.repo.head, state.repo.head)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('resumes commit-each without changing mode and atomically records the downstream commit', async () => {
  const cwd = await repository()
  const state = await routedRun(cwd, 'remediation-commit-resume', 'commit-each')
  let starts = 0
  let resumes = 0
  const adapter = {
    name: 'resumable-commit-auto-fix',
    async start(request) {
      starts++
      assert.equal(request.mode, 'commit')
      await writeFile(join(request.cwd, 'resumed-commit.txt'), 'partial commit work\n')
      return await observation(request, {
        executionStatus: 'RUNNING',
        includeCompletion: false,
        outputPaths: ['resumed-commit.txt'],
      })
    },
    async resume(request) {
      resumes++
      assert.equal(request.mode, 'commit')
      assert.equal(request.expectedRevision, 1)
      await git(request.cwd, 'add', '--', 'resumed-commit.txt')
      await git(request.cwd, 'commit', '-m', 'Resume authorized downstream commit')
      const commitSha = await git(request.cwd, 'rev-parse', 'HEAD')
      const boundary = await Plugin.captureWorktreeBoundary(request.cwd)
      return await observation(request, {
        revision: 2,
        stateDigest: sha('c'),
        committed: true,
        outputPaths: ['resumed-commit.txt'],
        postCommitHead: commitSha,
        postCommitWorkspaceFingerprint: boundary.fingerprint,
        commits: [{
          sha: commitSha,
          parentSha: request.expectedHead,
          changedFiles: ['resumed-commit.txt'],
          reviewDiffHash: sha('b'),
          commitEvidenceRef: 'git-workflow:commit:resumed',
        }],
      })
    },
  }
  try {
    const paused = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(paused.status, 'PAUSED')
    assert.equal(paused.authorization.autoFix, 'commit-each')
    assert.equal(paused.commits.length, 0)

    const completed = await Plugin.advanceRemediationRun({
      cwd, runId: state.runId, adapter, signal: new AbortController().signal,
    })
    assert.equal(completed.authorization.autoFix, 'commit-each')
    assert.equal(completed.fixRuns[0].status, 'DONE')
    assert.equal(completed.commits.length, 1)
    assert.equal(completed.repo.head, completed.commits[0].sha)
    assert.equal(starts, 1)
    assert.equal(resumes, 1)
    await Plugin.validateResume(completed, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
