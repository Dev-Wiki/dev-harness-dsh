# 项目架构分析

## 模块依赖关系图
生产包 peer 依赖 Cordis、dsh-commands 与 dsh-skill，运行时依赖 atomic-write 与 Schemastery；开发依赖精确锁定 rc.8 Session 与 Skill filesystem 测试栈

## 核心业务流程
Human Command 先做 Skill preflight，再依 phase 启动/恢复 Audit、授权 Auto Fix、canonical Full Verification 或 QA；Plugin 独立核对 Git 输出/提交/只读验证 boundary 并持久化权威下游引用

## 架构模式
生产 Cordis Service、Human Command、不可变 Run Authorization、原子 Run State、版本化 Audit/Auto Fix/Full Verification/QA Adapter 与可恢复 Orchestrator 分层实现；V0 fixture 保留为 rc.8 兼容性证明

## 模块接口与通信方式
- Audit Adapter：版本化 Observation + OPEN mutation lease + quiescent workspace checkpoint
- Auto Fix Adapter：authorization-bound fix/commit CompletionStatus + changed-file/commit ownership + monotonic resumable checkpoint
- Run Authorization：fix-only / commit-each immutable mode + independently denied external actions + verified commit boundary
- Full Verification Adapter：canonical harness:full + stable snapshot + read-only workspace boundary + distinct failure outcomes
- QA Adapter：verified capability evidence + stable attempt/resume identity + manual checklist fallback + read-only boundary
- QaFinding：独立 `QAF-*` source + authorization-preserving Auto Fix + fresh verification cycle + bounded retry
- Final Reconciliation Adapter：original Finding identity set + fresh Audit snapshot + Audit-root mutation lease + authoritative outcomes
- Run Summary：authoritative refs only + deterministic concern aggregation + schema-validated REPORT/DONE checkpoints
- Finding Router：typed handoff 驱动路由，只有 confirmed defect 进入 Auto Fix
- Bundle manifest：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml
- Plugin surface：name、inject、Config、apply(ctx, config)
- Human Command：ctx.commands.register 与 command/run、command/done 生命周期
- Agent：公开 LLM adapter + ctx.agents create/cancel/resume + JSONL persistence
- Workflow：SubagentRuntime + WorkerThreadWorkflowEngine + holder-owned WorkflowRun disposer
- Tool：AgentLoop 驱动 live tools/* 与 durable tool/* 配对并通过 JSONL replay
- Skill/state：cwd-sensitive SkillFileSystem + private Git dir + cross-process atomic state
- Run State：Git private dir + environment snapshot + file lock + revision CAS

## 关键模块标记
- AuditAdapter + AuditObservation
- AutoFixAdapter + AutoFixObservation
- RunAuthorization + adoptCommitBoundary
- FullVerificationAdapter + fullVerificationLease + advanceFullVerification
- QaAdapter + qaLease + QaFinding + advanceQaRun
- FinalReconciliationAdapter + finalReconciliationLease + advanceFinalReconciliation
- RunSummary + createRunSummary + advanceRunSummary
- autoFixLease + autoFixCheckpoint + advanceRemediationRun
- auditLease + auditCheckpoint + advanceAuditRun
- ctx.devHarness + harness-run/resume/status
- private Git dir + revision CAS + validateResume
- dsh.bundle.patch
- ctx.effect
- command/run + command/done
- ctx.agents.create + ctx.agents.resume
- ctx.workflowEngine.start + WorkflowRun.dispose
- tools/pre-execute + tools/execute + tools/post-execute + tools/result
- git rev-parse --absolute-git-dir + writeFileAtomic + withFileLock
