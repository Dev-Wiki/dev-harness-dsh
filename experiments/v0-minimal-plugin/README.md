# V0 最小插件 fixture

本 fixture 锁定 DeepSeek Harness `0.1.0-rc.8`，验证仓库外 bundle、Cordis plugin、Human Command 和 plugin fiber 卸载行为。它只用于 Task V0，不是 K1 的生产实现。完整结论见 [DSH API 基线](../../docs/integration/DSH_API_BASELINE.md)。

## 验证范围

- `package.json`：`dsh.bundle.patch`、公开构建产物与精确依赖版本；
- `cordis.patch.yml`：向 profile 插入稳定 row `dev-harness-dsh`；
- `src/index.ts`：named Cordis plugin exports，通过 `ctx.effect()` 注册 `/harness-status`；
- `smoke.mjs`：加载 rc.8 公开 exports，验证注册、执行、`command/run` / `command/done` 和 fiber dispose；
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

组合结果应包含 `id: dev-harness-dsh`、`name: dev-harness-dsh-v0-fixture` 和 `probe: true`。该命令只验证真实 profile/bundle 解析；Agent/Workflow 端到端属于 V0 剩余项。
