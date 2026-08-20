# dev-harness-dsh

## 项目简介
dev-harness-dsh 把 Audit、Auto Fix、验证、QA、最终复核与统一报告编排为可恢复运行；V0、K1、K2、K3、K4、S1、S2、S3、S4 MVP 基线已完成

## 编程语言
JavaScript, TypeScript

## 构建系统
npm / package.json, pnpm

## 核心模块
- src — 生产 Plugin、Human Command、Run Authorization、Audit/Auto Fix/Full Verification/QA/Reconciliation 合同、可恢复 Orchestrator、Run Summary 与原子 Run State
- tests — 生产生命周期、命令、授权、CompletionStatus、提交/验证 boundary、漂移和恢复自动化
- docs/product/REQUIREMENTS.md — MVP 产品边界与验收口径
- docs/plan — 当前状态看板与任务执行层
- docs/integration/DSH_API_BASELINE.md — rc.8 集成事实、证据等级与停止线
- experiments/v0-minimal-plugin — 可构建、可打包的 V0 Plugin/Command、Agent、Workflow、Tool、Skill/worktree 与状态边界实验

## 使用说明
- 开发依赖安装: pnpm install --frozen-lockfile --ignore-scripts
- 构建: npm run harness:build
- 本地发布包: python3 release.py（先执行完整验证，再生成 `dist/*.tgz`；不上传 registry）
- 插件安装与启用: [安装指南](docs/how-to/INSTALL.md)
- 运行: N/A

## 构建本地发布包

```shell
python3 release.py
```

脚本先执行 `npm run harness:full`，成功后用禁用生命周期脚本的 `npm pack` 在临时目录构建并校验包名、版本、关键文件、条目数、大小和 SHA-256，最后将包放入 `dist/`。同名包默认不会被覆盖；确认替换时使用 `python3 release.py --force`，自定义目录时使用 `--output-dir <path>`。

该脚本只构建本地 `.tgz`，不会执行 npm registry publish、Git tag、push 或外部 release。
