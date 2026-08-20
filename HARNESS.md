# HARNESS — 项目构建与验证契约

本文件是项目构建、验证和执行环境的唯一事实源。
它定义可执行命令、运行条件和验证边界，不替代 `AGENTS.md` 中的行为、安全与修改约束。

## 项目类型
规划阶段的 DeepSeek Harness TypeScript Plugin 项目；当前仓库只有 Task V0 集成实验，生产 src 尚未建立

## 编译与启动问题排查
- **WorkingDirectory**: repository root
- **RecommendedTerminal**: PowerShell（Windows）或项目兼容 shell
- **CanRunBuildHere**: unknown
- **BuildCommand**: `npm --prefix experiments/v0-minimal-plugin run build`
- **FailureEvidence**: 记录完整命令、工作目录、终端类型、退出码、前 50 行和最后 100 行构建日志

## 自动识别构建命令候选

- **build**: `npm --prefix experiments/v0-minimal-plugin run build`
- **test**: `npm --prefix experiments/v0-minimal-plugin test`
- **quick**: `npm --prefix experiments/v0-minimal-plugin run typecheck`
- **bugfix**: `Unknown`
- **full**: `Unknown`

## 已确认命令（人工维护）

### V0 fixture build

- **Purpose**: `build`
- **Command**: `npm --prefix experiments/v0-minimal-plugin run build`
- **WorkingDirectory**: repository root
- **Platform / Variant**: Node.js / V0 rc.8 fixture
- **Preconditions**: 已执行 `pnpm --dir experiments/v0-minimal-plugin install --frozen-lockfile --ignore-scripts`
- **DeviceRequirement**: `none`
- **Shell / Environment**: 项目兼容 shell；无凭据要求
- **Evidence**: `experiments/v0-minimal-plugin/package.json:22`；2026-08-20 本机执行 PASS
- **Status**: `confirmed`

### V0 fixture test

- **Purpose**: `test`
- **Command**: `npm --prefix experiments/v0-minimal-plugin test`
- **WorkingDirectory**: repository root
- **Platform / Variant**: Node.js / V0 rc.8 fixture
- **Preconditions**: 同 build
- **DeviceRequirement**: `none`
- **Shell / Environment**: 项目兼容 shell；无 LLM/API 凭据要求
- **Evidence**: `experiments/v0-minimal-plugin/package.json:25`、`experiments/v0-minimal-plugin/smoke.mjs`；2026-08-20 smoke 5/5 PASS
- **Status**: `confirmed`

### V0 fixture quick

- **Purpose**: `quick`
- **Command**: `npm --prefix experiments/v0-minimal-plugin run typecheck`
- **WorkingDirectory**: repository root
- **Platform / Variant**: Node.js / V0 rc.8 fixture
- **Preconditions**: 同 build
- **DeviceRequirement**: `none`
- **Shell / Environment**: 项目兼容 shell；无凭据要求
- **Evidence**: `experiments/v0-minimal-plugin/package.json:23`；2026-08-20 本机执行 PASS
- **Status**: `confirmed`

### 尚缺入口

- **bugfix**: `Missing` — 生产源码与回归套件尚未建立。
- **full**: `Missing` — fixture `verify` 不得冒充生产 `harness:full`。

## 高风险目录
- experiments/v0-minimal-plugin — 依赖、bundle 装配与 Cordis 生命周期实验
- docs/integration — 生产实现可依赖的 DSH 事实边界

## 禁改区域
- .git: version control metadata

## 自动识别候选
- build: npm --prefix experiments/v0-minimal-plugin run build
- test: npm --prefix experiments/v0-minimal-plugin test
- quick: npm --prefix experiments/v0-minimal-plugin run typecheck

## 需人工确认
- `bugfix` 验证命令仍缺失，需人工补齐可信入口
- build / test / quick / full 命令映射不完整，需人工确认最终入口
- 生产 src、bugfix 与 full 命令尚不存在；fixture verify 不能冒充生产 harness:full
- Agent、Workflow、Skill/worktree、跨重启恢复与 QA 协议仍缺运行证据
