# V0 最小插件 fixture

本 fixture 锁定 DeepSeek Harness `0.1.0-rc.8`，验证仓库外 bundle、Cordis plugin、Human Command、keyless Agent、Worker Workflow、Tool pipeline、linked worktree Skill 与私有原子状态边界。它只用于 Task V0，不是 K1 的生产实现。完整结论见 [DSH API 基线](../../docs/integration/DSH_API_BASELINE.md)。

## 验证范围

- `package.json`：`dsh.bundle.patch`、公开构建产物与精确依赖版本；
- `cordis.patch.yml`：向 profile 插入稳定 row `dev-harness-dsh`；
- `src/index.ts`：named Cordis plugin exports，通过 `ctx.effect()` 注册 `/harness-status`；
- `smoke.mjs`：加载 rc.8 公开 exports，验证注册、执行、`command/run` / `command/done` 和 fiber dispose；
- `agent-smoke.mjs`：用内存 LLM adapter 验证 create、cancel、whenIdle、handle dispose 与 JSONL clean restart resume，全程不需要 API key 或网络；
- `workflow-smoke.mjs`：用真实 Worker 与内存 SubagentProvider 验证完成、取消、事件配对、holder dispose 和 thread exit；
- `tool-pipeline-smoke.mjs`：通过真实 AgentLoop 验证成功、结构化错误、执行中取消、分发前取消的 live/durable 事件边界与 JSONL replay；
- `worktree-smoke.mjs` / `atomic-writer-child.mjs`：通过真实 linked worktree 验证 cwd-sensitive Skill、private Git state、8 进程原子更新和 resume 漂移拒绝；
- `crash-smoke.mjs` / `crash-agent-child.mjs`：在清空环境变量的独立子进程中于 request checkpoint 后触发 SIGKILL，验证 interrupted turn repair 与下一 turn 恢复；Windows 明确跳过；
- `pnpm-lock.yaml`：锁定可复现依赖图。

## 本地验证

```bash
pnpm install --frozen-lockfile --ignore-scripts
NPM_CONFIG_CACHE="$(mktemp -d)" npm run verify
```

`NPM_CONFIG_CACHE` 只用于受限沙箱；普通开发环境可直接运行 `npm run verify`。

## rc.8 profile 组合验证

使用临时 `DSH_HOME`，避免修改用户的 `~/.dsh`：

```bash
export DSH_HOME="$(mktemp -d)"
./node_modules/.bin/dsh plugin --profile headless add "file:$PWD"
./node_modules/.bin/dsh --profile headless --dump-config
```

组合结果应包含 `id: dev-harness-dsh`、`name: dev-harness-dsh-v0-fixture` 和 `probe: true`。该命令只验证真实 profile/bundle 解析；Agent/Workflow 由本目录的独立 keyless smoke 覆盖。
