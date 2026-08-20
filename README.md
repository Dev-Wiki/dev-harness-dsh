# dev-harness-dsh

## 项目简介
dev-harness-dsh 计划把 Audit、Auto Fix、验证、QA 与最终复核编排为可恢复运行；现阶段先验证 DSH rc.8 的公开扩展面

## 编程语言
TypeScript

## 构建系统
Unknown

## 核心模块
- docs/product/REQUIREMENTS.md — MVP 产品边界与验收口径
- docs/plan — 当前状态看板与任务执行层
- docs/integration/DSH_API_BASELINE.md — rc.8 集成事实、证据等级与停止线
- experiments/v0-minimal-plugin — 可构建、可打包的 V0 Plugin/Command 生命周期实验

## 使用说明
- 安装: pnpm --dir experiments/v0-minimal-plugin install --frozen-lockfile --ignore-scripts
- 构建: npm --prefix experiments/v0-minimal-plugin run build
- 运行: N/A
