# DSH 集成面基线（Task V0）

> 状态：🚧 调研中。本文区分“源码已确认”和“运行已验证”；只有运行证据覆盖的行为才可直接进入实现。
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

**结论：📚 源码已确认；cwd 行为尚未在本 fixture 实跑。**

- 公开读取面：`list(options)`、`snapshot(options)`、`get(name, options)`；注册面：`register(skill)`、`registerProvider(factory)`。
- `SkillViewOptions` 包含 `scope`、`cwd`、`signal`，因此接口明确支持 agent scope、工作区选择和取消。
- `SkillDefinition` 返回 `content`、可选 `path` / `metadata`，并保留 `invocation`、`source`、`provider`、`resourceBase`。
- 文件系统 provider 的优先级为 project `.dsh/skills` → project `.agents/skills` → custom → user DSH → user agents → bundled；最近 `.git` 祖先决定 project root。

官方证据：[Skills 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/skills.md)、[`dsh-skill` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/skill/skill/src/index.ts)。

### 3.3 Human Command（`ctx.commands`）

**结论：✅ 注册、执行、事件和卸载已运行验证。**

- 注册：`ctx.commands.register({ name, description, input?, recordInput?, handler })`，返回精确 disposer。
- 执行：`ctx.commands.execute(agent, line, attachments, signal)`；命令不进入模型 turn。
- handler 返回 `{ kind: 'success', text? }` 或 `{ kind: 'error', text }`。
- 成功执行在 Session 中产生 `command/run`、`command/done`；fixture 已断言事件顺序。

官方证据：[Human Commands](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/commands.md)、[`dsh-commands` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/interaction/commands/src/index.ts)。

### 3.4 Agent 创建、恢复与取消（`ctx.agents`）

**结论：📚 源码已确认；真实 factory/persistence 路径尚未实跑。**

- `ctx.agents.create(options)` 和 `ctx.agents.resume(options)` 返回 owner 持有的 `AgentHandle { agent, dispose() }`。
- 创建依赖已注册的 agent factory；resume 还依赖 `sessionPersistence`。失败会回滚未发布的 session/agent。
- `Agent.cancel(cause, { keepInbox? })` 取消当前活动；`whenIdle()` 等待整个 agent 回到静止；handle `dispose()` 负责停止、等待、注销与 scope unwind。
- `setup(agentCtx, agent)` 是发布前组合 agent-scoped 工具、prompt、listener 和插件的公开 seam。

官方证据：[Core / Agent](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/core.md)、[`dsh-agent` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/core/agent/src/index.ts)。

### 3.5 Workflow（`ctx.workflowEngine`）

**结论：📚 源码已确认；worker-thread provider 尚未实跑。**

- `ctx.workflowEngine.start(request)` 返回 `WorkflowRun`；`request.parent` 必填，`signal` 可取消。
- `WorkflowRun.result` 始终 resolve，结果以 `completed | cancelled | error` 区分；caller 可 `cancel()`，且必须 `dispose()`。
- 观察事件为 `workflow/start|phase|log|agent-start|agent-end|end`。
- 该 seam 面向“模型生成脚本调度子 Agent”。本项目的固定状态机是否应直接使用它，仍需与 `ctx.agents.create/resume` 做最小运行比较，不能仅因名称相似就选用。

官方证据：[Workflow 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/workflow.md)、[`dsh-workflow` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/packages/workflow/workflow/src/index.ts)。

### 3.6 Tool 与 Session Events

**结论：📚 事件契约已由源码确认；完整 tool pipeline 尚未实跑。**

- Tool 注册/执行公开面为 `ctx.tools` 与 `defineTool()`。
- live pipeline：`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `tools/result`；`tools/change` 通知注册集合变化。
- durable Session 事件是 `tool/call`、`tool/result`，不可与 live 的 `tools/result` 混淆。
- Session 是 append-only event log；模型历史、恢复和 replay 由该日志派生。

官方证据：[Tools 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/tools.md)、[Session](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/session.md)、[Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.0-rc.8/docs/subsystems/persistence.md)。

### 3.7 Workspace、授权与 Plugin 私有状态

**结论：📚 辅助能力已确认；它们不能替代 Plugin 自己的状态契约。**

- `ctx.workspaceRegistry` 管理 canonical path 对应的 DSH workspace 与 session membership；它不是任意 Plugin 私有 KV，也不负责解析 Git worktree 私有目录。
- `ctx.approval` 只回答一次具体 action 是否允许，策略是 `ask | never`，且 `request()` 要求 session 处于 open turn；它不能表达或持久化本产品的 `fix-only | commit-each` 运行级授权。
- `@deepseek-ai/dsh-atomic-write` 提供 `writeFileAtomic()` 与 `withFileLock()`，可作为 K1 原子状态文件的底层原语。
- K1 仍必须自行通过 Git 解析实际 private path、保存运行级授权、校验 HEAD/worktree/依赖漂移，并用测试证明 resume 边界。

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

## 5. 剩余验证与停止线

V0 尚未完成，K1 不启动。剩余项：

1. 用 rc.8 官方 mock LLM / session persistence 组合实跑 `ctx.agents.create()`、`resume()`、`cancel()`、`whenIdle()` 和 handle disposal，不使用真实 API key 作为唯一验证路径。
2. 实跑 worker-thread `ctx.workflowEngine.start()` 的完成、取消、dispose 和事件配对，并比较它是否适合固定产品状态机。
3. 建立临时 Git worktree，验证 cwd-sensitive Skill lookup、Git private path 解析、跨进程原子写和漂移 fail-closed。
4. 确认外部 QA Skill 的发现、授权、输入与完成状态协议；无法确认则保留 manual fallback。
5. `HARNESS.md` 已由 Context / Commands 工作流生成并确认 fixture 的 build/test/quick；生产 `bugfix` / `full` 仍明确为 `Missing`，等待 K1 建立真实工程后补齐。

任何一项只有类型声明而无运行证据时，必须继续标为源码已确认，不得写成“DSH 已支持且本项目可用”。
