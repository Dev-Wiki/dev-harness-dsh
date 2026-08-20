# DSH 集成面基线（Task V0）

> 状态：✅ Task V0 已完成。本文区分“源码已确认”和“运行已验证”；只有运行证据覆盖的行为才可直接进入实现。
>
> 证据日期：2026-08-20。DeepSeek Harness 仍处于 developer preview，升级版本后必须重跑本页验证。

## 1. 目标版本与兼容范围

| 项目 | 当前基线 | 证据 |
|---|---|---|
| 目标 DSH | `0.1.0-rc.8`，仅精确版本 | 官方标签 [`dsh-v0.1.0-rc.8`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.0-rc.8)，提交 `141eb6fef83422698aef7a981029e843e8161534` |
| npm 包 | `@deepseek-ai/dsh@0.1.0-rc.8` | 本地安装后 `node_modules/.bin/dsh --version`；registry integrity `sha512-VQU5NlomrKLRgcXuOf+sxWFvqxPA8q9vMhrKPlPPXiOJEhGlGlAdiyxZvZxkCVI+v0zbhe21cY3/luLyxpSzzA==` |
| 插件框架 | `@deepseek-ai/cordis@4.0.1` | rc.8 [`vendor/cordis/package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/vendor/cordis/package.json) |
| 配置 schema | `@deepseek-ai/schemastery@3.18.1` | rc.8 [`vendor/schemastery/package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/vendor/schemastery/package.json) |
| 实验工具链 | Node `v24.15.0`、TypeScript `6.0.3`、Oxlint `1.76.0`、pnpm `11.1.0` | 实际命令输出；DSH 源码要求 Node `^22.19.0 || >=24.0.0`，官方仓库自身固定 pnpm `11.7.0` |
| 本机全局对照 | `dsh 0.1.0-rc.6` | `dsh --version`；只作环境差异记录，不是本项目目标版本 |

兼容策略：V0 与 K1 只面向精确的 rc.8 API。官方 README 明确预览期会发生破坏性变更，因此当前不声明 `^0.1.0` 或跨 rc 兼容性；升级必须新建源码快照、重跑 fixture，并更新本页。

## 2. 证据等级

- ✅ **运行已验证**：在锁定的 rc.8 依赖上成功执行。
- 📚 **源码已确认**：官方 rc.8 文档、类型或实现存在，但本仓库尚无端到端运行证据。
- ⏳ **待验证**：仍不足以作为生产实现事实。

## 3. 集成面结论

### 3.1 Plugin、Bundle 与生命周期

**结论：✅ 运行已验证。**

- DSH 以 Cordis plugin tree 启动；仓库外 bundle 在 `package.json` 声明 `dsh.bundle.patch`，profile 通过 `dsh.profile.bundles` 按序叠加 patch。
- 普通插件公开 named exports：`name`、`inject`、可选 `Config` 和 `apply(ctx, config)`；注册副作用应通过 `ctx.effect()` 绑定到 plugin fiber。
- fixture 已证明：加载后 `/harness-status` 可见并可执行；fiber `dispose()` 后注册消失。
- rc.8 CLI 已在隔离 `DSH_HOME` 中把本地 bundle 加入 headless profile，`--dump-config` 出现 `dev-harness-dsh` row 与 `probe: true`。

官方证据：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/architecture.md)、[新增 package 指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/cookbook/adding-a-package.md)、[命令插件示例](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/session-query/session-log-export/src/index.ts)、[生命周期测试](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/interaction/commands/tests/commands.spec.ts)。

### 3.2 Skill Registry（`ctx.skills`）

**结论：✅ cwd-sensitive lookup 与 linked worktree 隔离已运行验证。**

- 公开读取面：`list(options)`、`snapshot(options)`、`get(name, options)`；注册面：`register(skill)`、`registerProvider(factory)`。
- `SkillViewOptions` 包含 `scope`、`cwd`、`signal`，因此接口明确支持 agent scope、工作区选择和取消。
- `SkillDefinition` 返回 `content`、可选 `path` / `metadata`，并保留 `invocation`、`source`、`provider`、`resourceBase`。
- 文件系统 provider 的优先级为 project `.dsh/skills` → project `.agents/skills` → custom → user DSH → user agents → bundled；最近 `.git` 祖先决定 project root。
- fixture 在主 worktree 与 linked worktree 中放置同名、不同正文的 project Skill，并从各自嵌套 cwd 调用 `snapshot()` / `get()`；两次读取均返回对应 worktree 的 `project-dsh` 路径与正文，没有跨 worktree 缓存污染。

官方证据：[Skills 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/skills.md)、[`dsh-skill` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/skill/skill/src/index.ts)。

### 3.3 Human Command（`ctx.commands`）

**结论：✅ 注册、执行、事件和卸载已运行验证。**

- 注册：`ctx.commands.register({ name, description, input?, recordInput?, handler })`，返回精确 disposer。
- 执行：`ctx.commands.execute(agent, line, attachments, signal)`；命令不进入模型 turn。
- handler 返回 `{ kind: 'success', text? }` 或 `{ kind: 'error', text }`。
- 成功执行在 Session 中产生 `command/run`、`command/done`；fixture 已断言事件顺序。

官方证据：[Human Commands](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/commands.md)、[`dsh-commands` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/interaction/commands/src/index.ts)。

### 3.4 Agent 创建、恢复与取消（`ctx.agents`）

**结论：✅ keyless factory、取消、清洁重启恢复和卸载已运行验证。**

- `ctx.agents.create(options)` 和 `ctx.agents.resume(options)` 返回 owner 持有的 `AgentHandle { agent, dispose() }`。
- 创建依赖已注册的 agent factory；resume 还依赖 `sessionPersistence`。失败会回滚未发布的 session/agent。
- `Agent.cancel(cause, { keepInbox? })` 取消当前活动；`whenIdle()` 等待整个 agent 回到静止；handle `dispose()` 负责停止、等待、注销与 scope unwind。
- `setup(agentCtx, agent)` 是发布前组合 agent-scoped 工具、prompt、listener 和插件的公开 seam。
- fixture 仅在公开 `LlmAdapter` 边界注册内存 scripted adapter，不加载真实 provider、凭据或网络；正式 `AgentRegistry`、`AgentLoop`、Session、SystemPrompt 与 ToolRuntime 均参与运行。
- create 场景已验证 `running → idle`、完整 turn、assistant message，以及 handle dispose 后 Agent 与 Session 同时注销；cancel 场景已验证 AbortSignal 传播与 durable `turn/end { kind: 'aborted' }`。
- JSONL 场景在显式 flush 后销毁整个 Context，再用同一持久化根目录调用 `resume()`；已验证 `session/end-seed`、连续 seq 和 turn `1 → 2`。
- 硬崩溃场景在独立、无环境变量的子进程挂载 Session Checkpoint Policy，于 adapter 收到请求后发送 `SIGKILL`；新 Context 的 `resume()` 已验证 repair 合成 `step/end` 与 `turn/end { kind: 'interrupted' }`，随后从 turn 2 连续执行。

官方证据：[Core / Agent](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/core.md)、[`dsh-agent` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/core/agent/src/index.ts)。

### 3.5 Workflow（`ctx.workflowEngine`）

**结论：✅ worker-thread 完成、取消、事件配对和资源卸载已运行验证。**

- `ctx.workflowEngine.start(request)` 返回 `WorkflowRun`；`request.parent` 必填，`signal` 可取消。
- `WorkflowRun.result` 始终 resolve，结果以 `completed | cancelled | error` 区分；caller 可 `cancel()`，且必须 `dispose()`。
- 观察事件为 `workflow/start|phase|log|agent-start|agent-end|end`。
- fixture 用正式 `SubagentRuntime`、内存 provider 和 `WorkerThreadWorkflowEngine` 实跑真实 Worker：完成路径严格配对 start/phase/log/agent-start/agent-end/end，取消路径把 child signal 置为 aborted 并产生 `agent-end: cancelled`。
- `WorkflowRun.dispose()` 后已观察到 Worker `exit` 且 `threadId === -1`；holder plugin 返回 run disposer 时，holder fiber 卸载会等待 worker 清理，而只卸载 engine service 不应被当作已返回 run 的所有权清理。
- 该 seam 面向“模型生成脚本调度子 Agent”。运行证据证明它可用，但本项目的固定产品状态机仍应由 Plugin 自己持久化；Workflow 更适合受控的动态子任务，不应取代 K1 状态契约。

官方证据：[Workflow 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/workflow.md)、[`dsh-workflow` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/workflow/workflow/src/index.ts)。

### 3.6 Tool 与 Session Events

**结论：✅ 成功、结构化错误、执行中取消、分发前取消与 JSONL replay 已运行验证。**

- Tool 注册/执行公开面为 `ctx.tools` 与 `defineTool()`。
- live pipeline：`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `tools/result`；`tools/change` 通知注册集合变化。
- durable Session 事件是 `tool/call`、`tool/result`，不可与 live 的 `tools/result` 混淆。
- Session 是 append-only event log；模型历史、恢复和 replay 由该日志派生。
- fixture 通过真实 AgentLoop 触发四类 Tool 终态。成功、错误与执行中取消均按 `tool/call → pre → execute → body → post/result → tool/result` 配对；在 `assistant/message` 观察点取消时不会进入 live pipeline，但仍持久化平衡的 `tool/call` / `tool/result`。
- 结构化 `HarnessError.code`、`ABORTED` 和 `ABORTED_BEFORE_DISPATCH` 均保留到 durable result；销毁 Context 后从 JSONL resume，四组 call/result 身份保持一致。

官方证据：[Tools 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/tools.md)、[Session](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/session.md)、[Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/persistence.md)。

### 3.7 Workspace、授权与 Plugin 私有状态

**结论：✅ worktree 私有路径与 atomic-write 已运行验证；Workspace / Approval 仍是源码确认。**

- `ctx.workspaceRegistry` 管理 canonical path 对应的 DSH workspace 与 session membership；它不是任意 Plugin 私有 KV，也不负责解析 Git worktree 私有目录。
- `ctx.approval` 只回答一次具体 action 是否允许，策略是 `ask | never`，且 `request()` 要求 session 处于 open turn；它不能表达或持久化本产品的 `fix-only | commit-each` 运行级授权。
- `@deepseek-ai/dsh-atomic-write` 提供 `writeFileAtomic()` 与 `withFileLock()`，可作为 K1 原子状态文件的底层原语。
- fixture 通过 `git rev-parse --absolute-git-dir` 解析每个 worktree 的 private Git dir；linked worktree 状态落在主仓 `.git/worktrees/<name>/dev-harness/dsh/<run-id>/state.json`，不使用 worktree 根的 `.git` 文件或 common dir。
- 8 个独立进程使用 `withFileLock()` 包围 read-modify-write，并以 `writeFileAtomic()` 提交；最终 revision 与 writer 集合无丢失，持续并发读取始终为完整 JSON，且没有残留 lock/temp sibling，POSIX 权限为 `0600`。
- 恢复基线同时固定 canonical worktree、private Git dir、HEAD、clean/dirty fingerprint、lockfile SHA-256 与实际解析包版本；worktree、tracked edit、HEAD、lockfile或包版本漂移均 fail closed，失败前后状态字节不变。
- K1 已把这些原语落实为生产 Run State、revision CAS 与恢复校验；K4 已在其上固定不可变 `fix-only` / `commit-each` 授权，并对下游提交执行 Git object、parent、路径、HEAD 与 post-commit workspace 实况校验。`writeFileAtomic()` 不承诺 fsync crash durability，现存 orphan lock 也必须由操作员处理而非自动删除。

官方证据：[Workspace](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/workspace.md)、[Approval](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/approval.md)、[Atomic write](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/util/atomic-write/README.md)。

## 4. 已执行验证

### 4.1 Fixture 工具链

工作目录：`experiments/v0-minimal-plugin`

```text
pnpm install --frozen-lockfile --ignore-scripts
NPM_CONFIG_CACHE="$(mktemp -d)" npm run verify
```

结果：

- TypeScript typecheck：PASS；
- Oxlint：PASS；
- TypeScript build：PASS；
- Plugin / Human Command smoke：5/5 PASS；
- keyless Agent create / cancel / JSONL clean restart：3/3 PASS；
- Worker Workflow complete / cancel / holder dispose：3/3 PASS；
- Tool pipeline success / structured error / running cancel / pre-dispatch cancel / JSONL replay：1/1 PASS；
- linked worktree Skill lookup / private Git state / concurrent atomic writers / drift rejection：3/3 PASS；
- Agent SIGKILL checkpoint repair / resume：1/1 PASS（Windows 明确跳过）；
- `npm pack --dry-run`：PASS，tarball 只包含 README、bundle patch、编译产物和 package manifest。

### 4.2 rc.8 Profile 组合

在 `mktemp -d` 创建的隔离目录中执行：

```text
node_modules/.bin/dsh --version
DSH_HOME=<isolated-dir> node_modules/.bin/dsh plugin --profile headless add file:<fixture-dir>
DSH_HOME=<isolated-dir> node_modules/.bin/dsh --profile headless --dump-config
```

结果：CLI 为 `0.1.0-rc.8`；profile bundles 包含 `dev-harness-dsh-v0-fixture`；组合树包含：

```yaml
- id: dev-harness-dsh
  name: dev-harness-dsh-v0-fixture
  config:
    probe: true
```

## 5. V0 决策与下游停止线

V0 的生产实现前置证据与 K1–K4、S1–S4 MVP 编排基线均已完成。外部 QA Skill 不作为 V0 的硬依赖：当前环境没有已验证的稳定 QA Skill 输入、授权与完成状态协议，因此生产 QA 只选择带显式验证证据的已注册 Adapter；没有这种 Adapter 时生成手工检查清单并停在 `NEEDS_USER`，不得把 `MANUAL_REQUIRED` 冒充 `PASS`。

生产 `harness:build` / `test` / `quick` / `bugfix` / `full` 已由 K1 建立并通过本机运行验证；fixture `verify` 仍不得冒充生产 `harness:full`。S1 已只消费该 canonical full 入口，并将 Run/snapshot/Git boundary、恢复 checkpoint 与 PASS/FAIL/入口缺失/环境不可用/执行器失败分流持久化。任何只有类型声明而无运行证据的能力必须继续标为源码已确认，不得写成“本项目可用”。

K2 不把 Codebase Audit `runtime.py` CLI 当成启动 Skill 的产品协议：该 runtime 只负责快照、状态和路径门禁，且各子命令 JSON wrapper 与错误外壳不统一。生产 Plugin 只消费版本化 `AuditAdapter` Observation；Adapter 负责实际 Skill/Agent 执行、CLI 归一化、typed route、artifact 完整性与 quiescent output hash。未注册 Adapter 时 Run 不越过 PREFLIGHT，也不把 Skill catalog 中“存在”误报为“已执行”。
