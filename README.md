# dev-harness-dsh

## 项目简介
dev-harness-dsh 把 Audit、Auto Fix、验证、QA 与最终复核编排为可恢复运行；V0、K1、K2、K3、K4、S1、S2 已完成，当前进入 Final Audit Reconciliation

## 编程语言
JavaScript, TypeScript

## 构建系统
npm / package.json, pnpm

## 核心模块
- src — 生产 Plugin、Human Command、Run Authorization、Audit/Auto Fix/Full Verification/QA Adapter、可恢复 Orchestrator 与原子 Run State
- tests — 生产生命周期、命令、授权、CompletionStatus、提交/验证 boundary、漂移和恢复自动化
- docs/product/REQUIREMENTS.md — MVP 产品边界与验收口径
- docs/plan — 当前状态看板与任务执行层
- docs/integration/DSH_API_BASELINE.md — rc.8 集成事实、证据等级与停止线
- experiments/v0-minimal-plugin — 可构建、可打包的 V0 Plugin/Command、Agent、Workflow、Tool、Skill/worktree 与状态边界实验

## 使用说明
- 安装: pnpm install --frozen-lockfile --ignore-scripts
- 构建: npm run harness:build
- 运行: N/A
