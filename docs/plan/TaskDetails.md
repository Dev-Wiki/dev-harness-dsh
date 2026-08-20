# 当前任务详情清单

> 本文档是 [Dashboard.md](Dashboard.md) 的执行层补充。产品边界与验收口径以 [MVP 需求](../product/REQUIREMENTS.md) 为准。
>
> **当前主题**：dev-harness-dsh MVP。Task V0 与 K1 已完成，Task K2 开发中；其他任务未经实现和验证证据不得标记完成。

<a id="task-v0"></a>
## 0. 前置调研：DSH 集成面与工具链基线（Task V0）

- **优先级**：🔴 P0
- **状态**：✅ 已完成
- **估时**：已于 2026-08-20 完成
- **依赖**：可读取的目标 DSH 版本源码、官方 reference、最小运行环境

**背景**：原始规划包含 Plugin、Skill Registry、Human Command、Agent / Workflow 与 Tool Event 的具体 API 假设。本仓库尚无证据证明这些接口名称、生命周期和稳定性，不能直接进入实现。

**目标**：

- 固定目标 DSH 版本与兼容范围；
- 识别公开 Plugin 扩展面和最小脚手架；
- 验证 Skill 发现、命令注册、Agent / Workflow 启动、事件订阅和取消传播；
- 确认 TypeScript 构建、测试、lint 和打包命令；
- 形成可复现的最小集成验证。

**调研产出**：

- Create: `docs/integration/DSH_API_BASELINE.md` — 已验证 API、版本、证据和限制（✅ 已建）；
- Create: 最小实验或测试 fixture — 证明入口与生命周期行为（✅ `experiments/v0-minimal-plugin`，Plugin/Command 5/5、Agent 3/3、Workflow 3/3、Tool pipeline 1/1、worktree/state 3/3、SIGKILL repair 1/1 通过）；
- Modify: `docs/product/REQUIREMENTS.md` — 把已证实项目从“待确认”移入对应需求，保留证据链接（✅ 已更新）；
- Modify: `HARNESS.md` — 由 Context / Commands 工作流记录真实验证命令（✅ V0 确认 fixture build/test/quick；K1 后续补齐生产 build/test/quick/bugfix/full）。

**Steps:**

1. 固定 DSH 版本、源码快照和官方 reference 来源。
2. 逐项验证 Plugin 生命周期、依赖声明、Skill Registry、Command、Agent / Workflow 与 Tool Event。
3. 验证工作目录、Git worktree、状态持久化、取消和恢复行为。
4. 建立最小自动化测试，记录命令输出和环境条件。
5. 输出集成基线，并更新需求中的待确认清单。

**完成证据**：集成基线中的每个结论都有源码位置、官方 reference 或成功运行记录；所有后续任务使用同一目标版本。

**当前进展（2026-08-20）**：

- 已固定官方版本基线：`@deepseek-ai/dsh` `0.1.0-rc.8`、Git tag `dsh-v0.1.0-rc.8`、commit `141eb6f...`、Cordis `4.0.1`；本机全局 rc.6 仅作对照。
- 已运行验证：Cordis plugin named exports、bundle/profile 装配、`ctx.commands` 注册/执行/事件/卸载；keyless Agent create/cancel/whenIdle/dispose、JSONL clean restart 与 SIGKILL checkpoint repair/resume；Worker Workflow complete/cancel/event pairing/holder dispose；cwd-sensitive Skill 与 linked worktree 隔离；Tool live/durable pipeline；Git private state、8 进程 atomic-write 和恢复漂移拒绝；以及 TypeScript build/typecheck、Oxlint、smoke 和 pack dry-run。
- QA 决策：当前没有已验证的外部 QA Skill 协议，S2 在发现并验证 Adapter 前保留 manual checklist fallback，无法自动执行不得报告 PASS。
- 下游边界：Workspace 与 Approval 仍仅有源码级证据；K1 已补齐生产 bugfix/full，fixture verify 仍不冒充生产 full。

---

## 1. MVP 核心开发计划

<a id="task-k1"></a>
### Task K1：Plugin Skeleton 与状态基线

- **优先级**：🔴 P0
- **状态**：✅ 已完成
- **估时**：已完成（2026-08-20）
- **依赖**：Task V0

**背景**：MVP 需要一个不复制 dev-harness 语义的最小 Plugin 入口、依赖检查、Human Command 和可恢复状态层。

**目标**：

- 建立经 V0 验证的 Plugin 脚手架；
- 实现 `run`、`resume`、`status` 的入口骨架；
- 建立原子 Run State、阶段状态机和 worktree-safe 私有路径；
- 缺失必需 Skill 或状态不一致时 fail closed。

**预计文件**：

- Create: `src/index.ts` — Plugin 注册与依赖声明；
- Create: `src/commands.ts` — 人类命令入口；
- Create: `src/state.ts` — 状态 schema、原子读写和恢复校验；
- Create: `src/skills.ts` — 必需/可选 Skill 可用性检查；
- Test: `tests/state.test.ts`、`tests/resume.test.ts` — 状态迁移、漂移和恢复边界。

**Steps:**

1. 生成最小工程结构和仓库真实工具链配置。
2. 实现状态 schema、合法迁移和原子持久化。
3. 注册命令并把控制请求交给 Orchestrator seam。
4. 增加缺失依赖、损坏状态、重复 Run 和取消场景测试。
5. 使用 V0 基线命令执行完整验证。

**完成证据（2026-08-20）**：

- 生产 Cordis Plugin、精确 rc.8 依赖与 `harness:build/test/quick/bugfix/full` 入口已建立；
- `src/state.ts` 实现 Git private dir 状态、`0600` atomic write、跨进程锁、revision CAS、阶段迁移及 worktree/HEAD/依赖/内容漂移拒绝；
- `/harness-run`、`/harness-resume`、`/harness-status` 直接通过 CommandRuntime 执行，不开启模型 turn；四个核心 Skill 不可被配置移除，catalog 不完整或缺失时在创建状态前 fail closed；
- 自动化覆盖损坏/符号链接状态、linked worktree 隔离、并发更新、重复 Run、暂停恢复、取消、预中止和 fiber 卸载；生产 `npm run verify` 本机 PASS。

---

<a id="task-k2"></a>
### Task K2：Audit Orchestration 与 Finding Router

- **优先级**：🔴 P0
- **状态**：🚧 开发中
- **估时**：K1 完成后评估
- **依赖**：Task K1；可运行的 `dev-harness-codebase-audit` 目标 fixture

**目标**：

- 启动或恢复 Codebase Audit；
- 读取权威 Finding Registry 和 handoff；
- 只把 confirmed defect 放入修复队列；
- 把 architecture、docs、verification 和 Git gap 路由到对应 handoff；
- 保留 Audit Run 引用，不复制 Finding Evidence。

**预计文件**：

- Create: `src/orchestrator.ts` — AUDIT、ROUTE 阶段控制；
- Create: `src/router.ts` — handoff 驱动路由；
- Test: `tests/orchestrator.test.ts`、`tests/router.test.ts` — 状态和路由边界。

**Steps:**

1. 用实际 Audit 产物固定输入契约。
2. 实现 Audit Run 启动、状态等待和失败传播。
3. 实现 Finding 身份、状态和 handoff 校验。
4. 测试 candidate、rejected、stale 和未知类型不会进入 defect 队列。
5. 验证 Plugin state 只保存引用和汇总。

---

<a id="task-k3"></a>
### Task K3：Auto Fix 队列、暂停与恢复

- **优先级**：🔴 P0
- **状态**：📋 规划中
- **估时**：K2 完成后评估
- **依赖**：Task K2；可运行的 `dev-harness-auto-fix` fixture

**目标**：

- 每个 confirmed defect 建立一个独立 Auto Fix Run；
- 等待并读取权威 CompletionStatus；
- `DONE_WITH_CONCERNS` 保留 residual risk；
- `BLOCKED` / `NEEDS_CONTEXT` 停止队列并进入明确状态；
- 进程中断后从 Plugin 和 Auto Fix 状态共同恢复。

**预计文件**：

- Modify: `src/orchestrator.ts` — REMEDIATE 阶段和队列推进；
- Modify: `src/state.ts` — Auto Fix Run 引用和当前 Finding；
- Test: `tests/orchestrator.test.ts`、`tests/resume.test.ts` — 完成、阻塞、漂移和恢复。

**Steps:**

1. 固定 Auto Fix 启动输入和 CompletionStatus 读取契约。
2. 实现逐 Finding 调度与串行推进。
3. 实现停止、用户输入和恢复路径。
4. 测试 Plugin 不读取或复制 Hypotheses、Regression Evidence 和 Review Diff。
5. 验证同一 Finding 不会重复启动未终止 Run。

---

<a id="task-k4"></a>
### Task K4：提交授权模型

- **优先级**：🔴 P0
- **状态**：📋 规划中
- **估时**：K3 完成后评估
- **依赖**：Task K3

**目标**：

- Run 启动时记录 `fix-only` 或 `commit-each`；
- `fix-only` 只启动 Auto Fix `fix` 模式；
- `commit-each` 只启动 Auto Fix `commit` 模式；
- 不在 Plugin 中暂存或创建第二次提交；
- push、PR、tag、release、deploy 未获独立授权时始终禁止。

**预计文件**：

- Create: `src/authorization.ts` — 授权 schema 与门控；
- Modify: `src/orchestrator.ts` — 下游模式选择；
- Test: `tests/authorization.test.ts` — 允许/禁止矩阵和恢复后一致性。

**Steps:**

1. 定义运行级授权和不可隐式扩大的规则。
2. 将授权映射到下游 Auto Fix 模式。
3. 阻止 Plugin 自行提交及重复提交。
4. 测试暂停恢复后授权不会变化或被默认升级。

---

## 2. MVP 支撑任务

<a id="task-s1"></a>
### Task S1：Full Verification

- **优先级**：🟡 P1
- **状态**：📋 规划中
- **估时**：K4 完成后评估
- **依赖**：Task K4；目标项目具有已确认的 `harness:full`

**目标**：

- 在修复队列结束后调度项目已有完整验证；
- 不重新发现或改写项目命令；
- 区分 PASS、失败、入口缺失和环境不可用；
- 将结果与实际下游运行和仓库快照关联。

**预计文件**：

- Modify: `src/orchestrator.ts` — FULL_VERIFY 阶段；
- Test: `tests/orchestrator.test.ts` — 成功、失败、缺失和漂移场景。

---

<a id="task-s2"></a>
### Task S2：QA Adapter 与失败闭环

- **优先级**：🟡 P1
- **状态**：📋 规划中
- **估时**：S1 完成后评估
- **依赖**：Task S1；V0 确认的 Agent / 外部 Skill 调度能力

**目标**：

- 定义统一 QA Adapter 结果协议；
- 支持用户指定、外部 Skill、Agent 原生工具、CLI/API 和手工清单降级；
- 把 QA 失败记录为内部 `QaFinding`；
- 支持 QA Failure → Auto Fix → Full Verification → QA Retry；
- 自动重试有明确上限，无法执行不冒充 PASS。

**预计文件**：

- Create: `src/qa/adapter.ts` — Adapter 接口和结果模型；
- Create: `src/qa/native.ts` — 已验证的 Agent 工具适配；
- Create: `src/qa/external-skill.ts` — 已验证的外部 Skill 适配；
- Modify: `src/orchestrator.ts` — QA 阶段和失败闭环；
- Test: QA 选择、失败重试、手工降级和授权传播测试。

---

<a id="task-s3"></a>
### Task S3：Final Audit Reconciliation

- **优先级**：🟡 P1
- **状态**：📋 规划中
- **估时**：S2 完成后评估
- **依赖**：Task S2

**目标**：

- 在最终工作区建立 fresh Audit Snapshot；
- 请求 Codebase Audit 复核原始 Findings；
- 读取 resolved、remaining、stale 等权威结果；
- 不直接修改 Audit Registry。

**预计文件**：

- Modify: `src/orchestrator.ts` — FINAL_RECONCILE 阶段；
- Test: 原始 Finding 身份、仓库漂移、复核失败和 remaining 场景。

---

<a id="task-s4"></a>
### Task S4：统一 Run Summary

- **优先级**：🟡 P1
- **状态**：📋 规划中
- **估时**：S3 完成后评估
- **依赖**：Task S3

**目标**：

- 汇总 Audit、Remediation、Auto Fix、Commit、Full Verification、QA 和 Final Audit；
- 每个结论能追溯到下游 Run 或验证记录；
- 正确生成 DONE、DONE_WITH_CONCERNS、BLOCKED、FAILED 等 Overall 状态；
- 明确剩余风险和人工动作。

**预计文件**：

- Create: `src/report.ts` — 统一结果模型和呈现；
- Modify: `src/orchestrator.ts` — REPORT / DONE 阶段；
- Test: `tests/orchestrator.test.ts` — 汇总完整性与状态归并。

---

## 3. 远期范围

以下内容不进入 MVP，不建立近期实施任务：

- DSH Web UI；
- 自动 PR、push、tag、release 和 deploy；
- 自建 browser 或 Playwright；
- 自动实施大型 Planning handoff；
- 多工作流并行调度和分布式执行；
- 对 Tool Event 进行强制策略拦截。

## 4. 验证基线

### 4.1 开发期验证

构建、测试、lint 和打包命令必须由 Task V0 从实际脚手架和配置确认，并写入项目 `HARNESS.md`。在此之前不预写生态经验命令。

### 4.2 模块验收

- V0：所有集成结论有源码、官方 reference 或成功运行证据；
- K1：状态迁移、原子写入、漂移和 resume 有自动化测试；
- K2：非 confirmed Finding 不进入缺陷队列；
- K3：每 Finding 一个 Run，阻塞状态不会被自动跳过；
- K4：Plugin 不创建提交，授权不会隐式扩大；
- S1：只执行已确认 `harness:full`；
- S2：QA 无法执行时生成剩余清单，不声明 PASS；
- S3：Finding 状态只由 Codebase Audit 更新；
- S4：报告中的每项结果都可追溯。

### 4.3 MVP 验收

- 从新 Run 到最终报告的主流程可复现；
- 中断后可以从持久状态恢复；
- 仓库、依赖或下游状态漂移时 fail closed；
- 无 commit 授权时工作区不产生提交；
- 未实现或未验证的外部能力不会被报告为可用。

## 5. 风险与维护规则

- **外部 API 风险**：DSH API 未验证前，所有具体接口名称保留在需求“待确认”，不得作为实现事实。
- **职责复制风险**：Plugin 只读取下游状态和引用；新增字段前先确认是否属于下游 SSOT。
- **授权风险**：授权按 Run 固化，恢复时重新校验但不得自动升级。
- **状态漂移风险**：仓库、下游 Run 或依赖版本漂移时停止并要求重新确认。
- **进度同步**：任务状态变化后同步更新 [Dashboard.md](Dashboard.md)，不要把执行细节复制到看板。

---

*最后更新：2026-08-20（Task K1 完成，Task K2 启动）*
