# dev-harness-dsh MVP 需求

> 状态：MVP 生产实现进行中；Task V0、K1、K2 已完成，Task K3 开发中。
>
> 文档职责：本文是 MVP 产品需求、职责边界和验收口径的权威文档；活动状态与执行步骤分别由 [`Dashboard.md`](../plan/Dashboard.md) 和 [`TaskDetails.md`](../plan/TaskDetails.md) 维护。
>
> 来源：从 `dev-harness` 仓库 2026-08-20 的“工作流与 Plugin 规划”中拆分。Task V0 已按官方 rc.8 源码与 fixture 运行证据分级核对 DSH API；未实跑的生命周期行为继续列入“待确认”。

## 1. 产品定位

`dev-harness-dsh` 是 DeepSeek Harness 环境中的 `dev-harness` 工作流编排器。

它负责把已有 Skills 串联为可恢复的长流程：

```text
发现可用 Skill
→ 启动 Codebase Audit
→ 路由已确认 Finding
→ 逐项调度 Auto Fix
→ 根据授权提交
→ 执行完整验证
→ 调度 QA
→ 最终 Audit Reconciliation
→ 汇总报告
```

核心原则：**Plugin owns orchestration；Skill owns semantics。**

## 2. 产品目标

MVP 要解决以下问题：

- 用户或 Agent 必须手工维护跨 Skill 的执行顺序；
- 多个 Finding 的当前项、重试、暂停和恢复状态容易丢失；
- Audit、Auto Fix、Git、完整验证和 QA 的交接缺少统一运行视图；
- 外层编排容易误判内部 Skill 是否完成，或者复制内部证据与规则。

MVP 成功时，用户可以通过单一入口启动、查询和恢复一次 dev-harness 长流程，同时每个阶段仍由原 Skill 的契约和确定性状态负责判定。

## 3. 职责边界

### 3.1 Plugin 负责

- 检查必需 Skill 是否可用；
- 建立和维护编排 Run；
- 保存当前阶段、Finding 队列和下游 Run 引用；
- 根据上游 handoff 调度对应 Skill；
- 处理暂停、恢复、取消、阻塞和有限重试；
- 调度项目已有完整验证入口；
- 选择可用 QA Adapter，或生成剩余人工检查清单；
- 生成统一 Run Summary。

### 3.2 Plugin 不负责

- 重写 `dev-harness` Skills；
- 自己判断 Audit Finding 是否成立；
- 自己实现 Bug 根因分析、RED/GREEN、Review 或最终验证；
- 复制 Audit Evidence、Auto Fix Hypotheses、Regression Evidence 或 Review Diff；
- 重新发现项目构建和测试命令；
- 自己维护 Git policy 或绕开精确暂存规则；
- 默认执行 push、PR、tag、release 或 deploy；
- 把 QA 工具或浏览器实现内建为 dev-harness Core；
- 自动实施大型架构重构或 Planning handoff。

## 4. 依赖契约

Plugin 面向 `dev-harness` 当前八个职责域进行编排：

- Context
- Docs
- Planning
- Commands
- Git Workflow
- Retro
- Auto Fix
- Codebase Audit

MVP 的必需依赖是能够完成 Audit、缺陷修复、Git 授权和验证交接的 Skill 集合。启动时缺失必需依赖必须 fail closed，并报告缺失项；可选依赖不得阻塞不相关阶段。

Plugin 只通过 DSH 已验证的公开扩展面访问 Skill、命令、Agent 或 Workflow，不调用私有对象，不修改 DSH Core。具体 API 在前置调研完成后写入集成基线，不在需求文档中提前定案。

## 5. 用户入口

MVP 至少提供以下人类可调用能力：

- `run`：创建新编排 Run；
- `resume`：校验状态后恢复已暂停或中断的 Run；
- `status`：展示阶段、当前 Finding、阻塞和最近结果。

后续可提供：

- `audit`：只执行或恢复 Audit 阶段；
- `cancel`：显式取消 Run 并保留可审计状态。

入口名称和注册方式以 DSH 集成基线为准。命令只负责启动或控制 Orchestrator，不直接承载 Agent 推理。

## 6. 核心架构

```text
┌──────────────────────────────────────┐
│          dev-harness-dsh             │
│                                      │
│  Orchestrator                        │
│  Run State                           │
│  Finding Queue                       │
│  Skill Router                        │
│  Authorization                      │
│  Retry / Resume                      │
│  QA Adapter                          │
│  Final Acceptance                    │
└─────────────────┬────────────────────┘
                  │
                  ▼
       DSH 已验证的公开扩展能力
                  │
       ┌──────────┼───────────┐
       ▼          ▼           ▼
 codebase-audit auto-fix   git-workflow
       │          │           │
       └──────┬───┴───────────┘
              ▼
        dev-harness Core
```

建议的实现模块：

```text
src/
├── index.ts
├── orchestrator.ts
├── state.ts
├── skills.ts
├── router.ts
├── authorization.ts
├── commands.ts
├── qa/
│   ├── adapter.ts
│   ├── native.ts
│   └── external-skill.ts
└── report.ts
```

最终目录和框架约定必须以 V0 调研及实际脚手架为证据，本文结构只表达职责分离。

## 7. 编排状态

Plugin 只保存编排状态和对下游权威状态的引用。

建议状态至少包含：

```json
{
  "runId": "dsh-20260820-001",
  "repo": "...",
  "phase": "remediation",
  "auditRunId": "audit-...",
  "currentFinding": "AUD-003",
  "findings": [],
  "fixRuns": [],
  "commits": [],
  "fullVerification": null,
  "qa": null,
  "status": "RUNNING"
}
```

允许保存的引用包括 `auditRunId`、`autoFixRunId`、`findingId`、`commitSha` 和阶段结果。不得复制下游 Skill 的详细证据正文。

建议状态路径为：

```text
.git/dev-harness/dsh/<run-id>/state.json
```

实际路径解析必须兼容 worktree，并通过测试证明不会写入受版本控制的业务目录。

## 8. 状态机

阶段状态机：

```text
INIT
  ↓
PREFLIGHT
  ↓
AUDIT
  ↓
ROUTE
  ↓
REMEDIATE
  ↓
FULL_VERIFY
  ↓
QA
  ↓
FINAL_RECONCILE
  ↓
REPORT
  ↓
DONE
```

公共运行状态：

```text
RUNNING
PAUSED
NEEDS_USER
BLOCKED
FAILED
DONE
DONE_WITH_CONCERNS
CANCELLED
```

每次恢复必须重新校验仓库、下游状态引用和授权边界；不得仅凭会话文本推断阶段已经完成。

## 9. Finding Router

Plugin 只消费 Codebase Audit 已提供的 Finding 状态与 handoff，不重新发明分类规则：

| Finding 类型 | 路由目标 | MVP 行为 |
|---|---|---|
| confirmed defect | Auto Fix | 进入逐项修复队列 |
| architecture / refactor / tech debt | Planning | 生成 handoff 并标记 deferred |
| docs governance | Docs | 生成 Docs handoff |
| verification gap | Commands | 生成 Commands handoff |
| Git / release gap | Git Workflow | 生成 Git Workflow handoff |

Plugin 或普通 Agent 不得自行伪造 `AUD-*` ID。只有 Codebase Audit 拥有 Finding Registry 和 Finding 状态。

## 10. Auto Fix 与提交授权

每个 confirmed defect 默认对应一个独立 Auto Fix Run，以保持根因、验证、Review 和提交边界清晰。

Plugin 必须等待 Auto Fix 的权威 `CompletionStatus`：

- `DONE`：可继续；
- `DONE_WITH_CONCERNS`：记录 residual risk 后可继续；
- `BLOCKED`：停止队列；
- `NEEDS_CONTEXT`：停止队列并请求用户输入。

运行级授权至少支持：

- `fix-only`：下游 Auto Fix 使用 `fix` 模式，不提交；
- `commit-each`：下游 Auto Fix 使用 `commit` 模式，并由它在最终阶段加载 Git Workflow。

Plugin 不得在 Auto Fix 已提交后再次创建提交。push、PR、tag、release 和 deploy 始终需要独立授权。

## 11. 完整验证

所有计划内修改处理后，Plugin 调度项目 `HARNESS.md` 已确认的 `harness:full` 入口。

Plugin 不重新扫描工具链，也不把任意成功命令冒充完整验证。入口缺失、未确认或执行环境不可用时，Run 必须进入可解释的阻塞或关注状态。

## 12. QA Adapter

QA 是工作流阶段，不新增 dev-harness Core Skill。Plugin 提供统一的 QA Adapter 接口，按以下顺序选择：

1. 用户显式指定的 QA 能力；
2. 当前 DSH 环境中已验证可调用的外部 QA Skill；
3. 当前 Agent 已有的 browser / UI 工具；
4. CLI / API 场景验证；
5. 无法自动执行的部分生成手工检查清单。

QA 失败时创建 Plugin 内部 `QaFinding`，至少记录 Symptom、Expected、Steps、Environment 和 Evidence，然后重新进入 Auto Fix → Full Verification → QA Retry。

`QaFinding` 不是 Audit Finding。只有需要长期登记时，才显式交给 Codebase Audit。

## 13. 最终 Reconciliation

代码、完整验证和 QA 完成后，Plugin 在最终工作区上重新调度 Codebase Audit，以 fresh Snapshot 复核原始 Findings。

Plugin 不直接修改 `<docs-root>/audit/Findings.md`；resolved、remaining、stale 或 reverify 等状态始终由 Codebase Audit 维护。

## 14. 最终报告

统一 Run Summary 至少包含：

- Audit confirmed / rejected 汇总；
- 已修复、deferred 和其他 handoff 数量；
- Auto Fix CompletionStatus 汇总与 residual risks；
- commit 引用（仅在已授权并实际产生时）；
- Full Verification 结果；
- QA 场景与失败重试结果；
- Final Audit 的 resolved / remaining 汇总；
- Overall 状态与仍需人工处理的事项。

报告只能汇总下游权威状态，不得根据日志文本推断成功。

## 15. 实施阶段

| 阶段 | 需求范围 |
|---|---|
| M1 | Plugin Skeleton、依赖检查、人类命令、私有状态和单元测试 |
| M2 | Audit Orchestration、Findings 读取与 Router |
| M3 | 每 Finding 一个 Auto Fix Run、CompletionStatus 和 resume |
| M4 | `fix-only` / `commit-each` 授权模型 |
| M5 | 调度项目已确认的 `harness:full` |
| M6 | native / external-skill / manual fallback QA Adapter |
| M7 | fresh Snapshot 下的 Final Reconciliation |
| M8 | 统一 Run Summary |

阶段状态、优先级和起手顺序以活动计划为准，不在本文维护。

## 16. MVP 非目标

- DSH Web UI；
- 自动 PR、push、tag、release 或 deploy；
- 自己实现 browser、Playwright、Auto Fix 或 Codebase Audit；
- 自己维护 Git policy；
- 自动执行大型 Planning 任务；
- 把 dev-harness Skills 复制进 Plugin；
- 通过聊天文本或单个工具退出码猜测 Skill 是否成功。

## 17. MVP 验收标准

- 不修改或复制现有 dev-harness Skill 的职责边界；
- 缺失必需 Skill 时 fail closed；
- 能启动 Codebase Audit，并读取 confirmed Findings 建立队列；
- 能按 handoff Contract 路由 Finding；
- 能逐个启动 Auto Fix，并读取权威 CompletionStatus；
- `BLOCKED` / `NEEDS_CONTEXT` 不会被自动跳过；
- commit 只通过 Auto Fix + Git Workflow 的授权路径完成；
- 不默认执行 push、PR、tag、release 或 deploy；
- 中断后能校验状态并 resume；
- 能执行项目已确认的 `harness:full`；
- QA 不依赖新增 dev-harness Core Skill；
- QA Failure 能重新进入 Auto Fix 和验证循环；
- 最终 Finding 状态由 Codebase Audit 更新；
- Plugin state 只保存 orchestration state 和引用；
- 最终生成统一、可追溯的 Run Summary。

## 待确认与已确认清单

### 已由 Task V0 固定或源码确认（运行等级见 [DSH_API_BASELINE.md](../integration/DSH_API_BASELINE.md)）

- 当前目标版本固定为官方 `dsh-v0.1.0-rc.8`（commit `141eb6f...`）；预览期只支持精确版本，不声明跨 rc 兼容；
- DSH Plugin 框架为 Cordis：named `name` / `Config` / `inject` / `apply` exports，`dsh.bundle.patch` + profile `dsh.profile.bundles` 装配；fixture 已实跑注册与 fiber 卸载；
- Skill Registry 公开面为 `ctx.skills.list()/snapshot()/get()/register()/registerProvider()`，`SkillViewOptions` 包含 `{ scope, cwd, signal }`；fixture 已实跑主 worktree 与 linked worktree 的 cwd 隔离读取；
- 完整 Skill Definition 返回 `content`（Markdown body）、`path`、`metadata`、`invocation` 等字段；
- Human Command 公开面为 `ctx.commands.register(...)`，执行走 `ctx.commands.execute(agent, line, attachments, signal)`，生命周期事件 `command/run`、`command/done`；fixture 已实跑；
- Agent 已用公开 LLM adapter seam 实跑 create、cancel、whenIdle、dispose 与 JSONL clean restart resume；Workflow 已用真实 Worker 实跑完成、取消、事件配对、holder dispose 和 thread exit；
- Tool Event 使用 durable `tool/call`、`tool/result` 及 live `tools/pre-execute|execute|post-execute|result|change`；fixture 已实跑成功、结构化错误、执行中取消、分发前取消与 JSONL replay 配对；
- 会话 clean restart 已验证 append-only 事件、`session/end-seed`、连续 seq 与 turn 续号；独立子进程 SIGKILL 后也已验证 checkpoint repair 合成 interrupted turn 并从下一 turn 恢复；
- `ctx.workspaceRegistry` 不是 Plugin 私有状态存储；`ctx.approval` 的 `ask` / `never` 也不能替代 `fix-only` / `commit-each` 运行级授权；
- Git private dir、跨进程原子写和 worktree/HEAD/依赖漂移拒绝已在真实 linked worktree fixture 实跑，并已由 K1 落实为生产 Run State；
- K1 已建立生产 `run` / `resume` / `status` Human Command、不可移除的核心 Skill preflight、状态机、revision CAS 与取消边界；catalog 不完整、依赖缺失、状态损坏或恢复漂移均 fail closed；
- K2 已建立版本化 Audit Adapter、OPEN mutation lease、精确 workspace checkpoint 与 Finding Router；只有当前 Snapshot 下、cross-module 已完成且带 typed handoff 的 confirmed Finding 会被路由，state 只保存 Audit/Finding/artifact 引用和输出哈希；
- K3 已建立 fix-only Auto Fix Adapter、逐 Finding 串行队列、权威 CompletionStatus、residual-risk/blocker 引用与中断恢复；Plugin state 不复制下游假设或验证正文；
- K4 已建立不可变 `fix-only` / `commit-each` Run 授权；commit 只由下游 Auto Fix + Git Workflow 产生，Plugin 独立核对 Git 对象、parent、路径和 post-commit 工作区后原子接纳，不执行第二次提交；
- 生产 build / test / quick / bugfix / full 脚本已建立并通过本机验证；S1 仍负责把 `harness:full` 纳入编排状态与失败传播；
- 当前没有已验证的外部 QA Skill 协议；S2 在发现并验证更高优先级 Adapter 前必须使用 manual checklist fallback，结果不得标为 PASS；
- fixture 的 TypeScript typecheck/build、Oxlint、测试、pack dry-run 和 rc.8 profile 组合已运行通过。

### 后续任务仍须确认

- 外部 QA Skill 的发现、授权、输入和完成状态协议（S2；验证前使用 manual fallback）；
