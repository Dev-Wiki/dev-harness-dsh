# HARNESS — 项目构建与验证契约

本文件是项目构建、验证和执行环境的唯一事实源。
它定义可执行命令、运行条件和验证边界，不替代 `AGENTS.md` 中的行为、安全与修改约束。

## 项目类型
DeepSeek Harness TypeScript Plugin 项目；Task V0、K1、K2 已完成，Task K3 Auto Fix 队列开发中

## 编译与启动问题排查
- **WorkingDirectory**: repository root
- **RecommendedTerminal**: PowerShell（Windows）或项目兼容 shell
- **CanRunBuildHere**: yes
- **BuildCommand**: `npm run harness:build`
- **FailureEvidence**: 记录完整命令、工作目录、终端类型、退出码、前 50 行和最后 100 行构建日志

## 自动识别构建命令候选

- **build**: `npm run harness:build`
- **test**: `npm run harness:test`
- **quick**: `npm run harness:quick`
- **bugfix**: `npm run harness:bugfix`
- **full**: `npm run harness:full`

## 已确认命令（人工维护）

### Production build / test / quick / bugfix / full

- **Purpose**: `build` / `test` / `quick` / `bugfix` / `full`
- **Commands**: `npm run harness:build`、`npm run harness:test`、`npm run harness:quick`、`npm run harness:bugfix`、`npm run harness:full`
- **WorkingDirectory**: repository root
- **Platform / Variant**: Node.js 22.19+ / production Plugin
- **Preconditions**: 已执行 `pnpm install --frozen-lockfile --ignore-scripts`
- **DeviceRequirement**: `none`
- **Shell / Environment**: 项目兼容 shell；无 LLM/API 凭据要求；pack dry-run 需要可写 npm cache
- **Evidence**: `package.json:28-32`；2026-08-20 本机执行生产 full，typecheck、Oxlint、20 个自动化用例与 pack dry-run PASS
- **Status**: `confirmed`

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
- **Evidence**: `experiments/v0-minimal-plugin/package.json:25`、`smoke.mjs`、`agent-smoke.mjs`、`workflow-smoke.mjs`、`tool-pipeline-smoke.mjs`、`worktree-smoke.mjs`、`crash-smoke.mjs`；2026-08-20 Plugin/Command 5/5、Agent 3/3、Workflow 3/3、Tool pipeline 1/1、worktree/state 3/3、SIGKILL repair 1/1 PASS
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

## 高风险目录
- src — 生产编排、Git 状态持久化与恢复停止线
- experiments/v0-minimal-plugin — 依赖、bundle 装配与 Cordis 生命周期实验
- docs/integration — 生产实现可依赖的 DSH 事实边界

## 禁改区域
- .git: version control metadata

## 自动识别候选
- build: npm run harness:build
- test: npm run harness:test
- quick: npm run harness:quick
- bugfix: npm run harness:bugfix
- full: npm run harness:full

## 需人工确认
- K3 尚需固定 Auto Fix Adapter、权威 CompletionStatus 与 residual risk 输入契约
- 外部 QA Skill 协议尚未验证；S2 在验证 Adapter 前只声明 manual checklist fallback
