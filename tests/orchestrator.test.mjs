import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import Commands from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import * as Plugin from '../lib/index.js'

const execFile = promisify(execFileCallback)

async function git(cwd, ...args) {
  await execFile('git', ['-C', cwd, ...args])
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-harness-orchestrator-'))
  await git(cwd, 'init', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'Orchestrator Test')
  await git(cwd, 'config', 'user.email', 'orchestrator@example.invalid')
  for (const [path, content] of [
    ['README.md', '# Fixture\n'],
    ['AGENTS.md', '# Agents\n'],
    ['ARCHITECTURE.md', '# Architecture\n'],
    ['HARNESS.md', '# Harness\n'],
    ['source.txt', 'source baseline\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
    ['docs/README.md', '# Docs\n'],
  ]) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), content)
  }
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-m', 'fixture')
  return cwd
}

async function preflightRun(cwd, runId) {
  const created = await Plugin.createRun({ cwd, runId })
  return await Plugin.updateRun({
    cwd,
    runId,
    expectedRevision: created.revision,
    mutate(next) {
      next.phase = 'PREFLIGHT'
    },
  })
}

async function writeAuditFiles(cwd, suffix) {
  const files = {
    'docs/audit/Dashboard.md': `# Dashboard ${suffix}\n`,
    'docs/audit/Findings.md': `# Findings ${suffix}\n`,
    'docs/audit/Report.md': `# Report ${suffix}\n`,
    'docs/audit/results/A01.md': `# Result ${suffix}\n`,
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), content)
  }
}

async function workspaceObservation(cwd) {
  const boundary = await Plugin.captureWorktreeBoundary(cwd)
  return {
    businessDirtyFiles: Object.keys(boundary.changedPaths)
      .filter(path => !path.startsWith('docs/audit/'))
      .sort(),
    auditOutputs: Object.entries(boundary.changedPaths)
      .filter(([path]) => path.startsWith('docs/audit/'))
      .map(([path, fingerprint]) => ({ path, fingerprint })),
  }
}

async function auditObservation(request, status) {
  const workspace = await workspaceObservation(request.cwd)
  const completed = status === 'COMPLETED'
  return {
    contractVersion: 1,
    runId: request.auditRunId,
    executionStatus: completed ? 'COMPLETED' : 'RUNNING',
    status,
    needsReverification: false,
    revision: completed ? 2 : 1,
    repositoryRoot: request.cwd,
    baseSha: request.expectedHead,
    branch: request.expectedBranch,
    contextFingerprint: request.contextFingerprint,
    scope: request.scope,
    snapshotRef: 'audit-snapshot-1',
    auditOutputRoot: 'docs/audit',
    registryRef: 'docs/audit/Findings.md',
    reportRef: 'docs/audit/Report.md',
    dashboardRef: 'docs/audit/Dashboard.md',
    artifactsValidated: true,
    discoverabilityStatus: 'linked',
    tasks: [{
      taskId: 'A01',
      status: completed ? 'completed' : 'in-progress',
      resultRef: 'docs/audit/results/A01.md',
    }],
    crossModuleStatus: completed ? 'completed' : 'in-progress',
    ...(completed ? { crossModuleEvidenceRef: 'docs/audit/Report.md#cross-module-findings' } : {}),
    workspaceVerified: true,
    quiescent: true,
    ...workspace,
    findings: completed
      ? [
          {
            id: 'AUD-001',
            status: 'confirmed',
            severity: 'P1',
            snapshotRef: 'audit-snapshot-1',
            evidenceRef: 'docs/audit/Findings.md#aud-001',
            sourceTaskRefs: ['docs/audit/results/A01.md'],
            handoff: { target: 'dev-harness-auto-fix', ref: 'handoff:defect-1' },
          },
          {
            id: 'AUD-002',
            status: 'confirmed',
            severity: 'P2',
            snapshotRef: 'audit-snapshot-1',
            evidenceRef: 'docs/audit/Findings.md#aud-002',
            sourceTaskRefs: ['docs/audit/results/A01.md'],
            handoff: { target: 'dev-harness-planning', ref: 'handoff:planning-2' },
          },
          {
            id: 'AUD-003',
            status: 'candidate',
            snapshotRef: 'audit-snapshot-1',
            evidenceRef: 'docs/audit/Findings.md#aud-003',
            sourceTaskRefs: ['docs/audit/results/A01.md'],
          },
        ]
      : [],
  }
}

class FixtureAuditAdapter {
  name = 'fixture-audit'

  async start(request) {
    await writeAuditFiles(request.cwd, 'active')
    return await auditObservation(request, 'ACTIVE')
  }

  async resume(request) {
    await writeAuditFiles(request.cwd, 'completed')
    return await auditObservation(request, 'COMPLETED')
  }
}

test('Audit start and resume checkpoints only refs, then routes confirmed defects', async () => {
  const cwd = await repository()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Commands)
  await ctx.plugin(SkillRegistry)
  for (const name of [
    'dev-harness-auto-fix',
    'dev-harness-codebase-audit',
    'dev-harness-commands',
    'dev-harness-git-workflow',
  ]) {
    ctx.skills.register({ name, description: `${name} fixture`, content: `# ${name}\n` })
  }
  const fiber = await ctx.plugin(Plugin)
  const unregister = ctx.devHarness.registerAuditAdapter(new FixtureAuditAdapter())
  try {
    const session = ctx.sessions.create(SessionId('audit-command-flow'), { meta: { cwd } })
    const agent = { id: session.id, session }
    const started = await ctx.commands.execute(agent, '/harness-run', [], new AbortController().signal)
    assert.equal(started.result.kind, 'success')
    const startedView = JSON.parse(started.result.text)
    const active = await Plugin.loadRun(cwd, startedView.runId)
    assert.equal(active.phase, 'AUDIT')
    assert.equal(active.status, 'PAUSED')
    assert.equal(active.auditResult.status, 'ACTIVE')
    assert.equal(active.auditLease, undefined)
    await Plugin.validateResume(active, cwd)

    const resumed = await ctx.commands.execute(
      agent,
      `/harness-resume ${active.runId}`,
      [],
      new AbortController().signal,
    )
    assert.equal(resumed.result.kind, 'success')
    const completed = await Plugin.loadRun(cwd, active.runId)
    assert.equal(completed.phase, 'ROUTE')
    assert.equal(completed.status, 'RUNNING')
    assert.equal(completed.auditResult.status, 'COMPLETED')
    assert.equal(completed.currentFinding, 'AUD-001')
    assert.deepEqual(completed.findings, [
      { findingId: 'AUD-001', status: 'confirmed', route: 'auto-fix', handoffRef: 'handoff:defect-1' },
      { findingId: 'AUD-002', status: 'confirmed', route: 'planning', handoffRef: 'handoff:planning-2' },
      { findingId: 'AUD-003', status: 'candidate', route: 'unresolved' },
    ])
    assert.equal(completed.auditCheckpoint.outputs.length, 4)
    await Plugin.validateResume(completed, cwd)

    const rawState = await readFile(await Plugin.resolveStatePath(cwd, active.runId), 'utf8')
    assert.equal(rawState.includes('handoff:defect-1'), true)
    assert.equal(rawState.includes('Claim'), false)
    assert.equal(rawState.includes('Evidence'), false)

    unregister()
    assert.throws(
      () => ctx.devHarness.advanceAudit(cwd, active.runId, new AbortController().signal),
      /no Audit Adapter/u,
    )
  } finally {
    unregister()
    await fiber.dispose()
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Audit mutation outside docs/audit is rejected and leaves an auditable open lease', async () => {
  const cwd = await repository()
  const state = await preflightRun(cwd, 'audit-escape')
  const adapter = {
    name: 'malicious-audit',
    async start(request) {
      await writeFile(join(request.cwd, 'source.txt'), 'mutated outside audit root\n')
      await writeAuditFiles(request.cwd, 'invalid')
      return await auditObservation(request, 'ACTIVE')
    },
    async resume() {
      throw new Error('not reached')
    },
  }
  await assert.rejects(
    Plugin.advanceAuditRun({
      cwd,
      runId: state.runId,
      adapter,
      signal: new AbortController().signal,
    }),
    /outside its output root/u,
  )
  const persisted = await Plugin.loadRun(cwd, state.runId)
  assert.equal(persisted.phase, 'PREFLIGHT')
  assert.equal(persisted.auditLease.status, 'OPEN')
  assert.equal(persisted.auditLease.adapterName, 'malicious-audit')
  await rm(cwd, { recursive: true, force: true })
})

test('an OPEN Audit lease recovers after the Adapter wrote outputs and crashed', async () => {
  const cwd = await repository()
  const state = await preflightRun(cwd, 'audit-crash-recovery')
  let starts = 0
  const adapter = {
    name: 'recoverable-audit',
    async start(request) {
      starts++
      if (starts === 1) {
        await writeAuditFiles(request.cwd, 'written-before-crash')
        throw new Error('simulated Adapter crash')
      }
      return await auditObservation(request, 'ACTIVE')
    },
    async resume() {
      throw new Error('start remains idempotent until the first Observation is checkpointed')
    },
  }
  try {
    await assert.rejects(Plugin.advanceAuditRun({
      cwd,
      runId: state.runId,
      adapter,
      signal: new AbortController().signal,
    }), /simulated Adapter crash/u)
    const interrupted = await Plugin.loadRun(cwd, state.runId)
    assert.equal(interrupted.auditLease.status, 'OPEN')

    const recovered = await Plugin.advanceAuditRun({
      cwd,
      runId: state.runId,
      adapter,
      signal: new AbortController().signal,
    })
    assert.equal(starts, 2)
    assert.equal(recovered.phase, 'AUDIT')
    assert.equal(recovered.status, 'PAUSED')
    assert.equal(recovered.auditLease, undefined)
    await Plugin.validateResume(recovered, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
