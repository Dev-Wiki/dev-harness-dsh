# 项目架构分析

## 模块依赖关系图
V0 fixture 直接依赖 Schemastery，peer 依赖 Cordis 与 dsh-commands；开发依赖锁定 DSH rc.8 的 Agent、Command、Session、Skill、Tools 与 Workflow 包

## 核心业务流程
DSH profile 读取 bundle patch → Cordis 调用 apply → ctx.effect 注册 harness-status → Human Command 执行并写入 command/run 与 command/done → fiber dispose 清理注册

## 架构模式
产品需求、活动看板、任务详情与集成证据分层维护；可执行面隔离在 experiments/v0-minimal-plugin

## 模块接口与通信方式
- Bundle manifest：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml
- Plugin surface：name、inject、Config、apply(ctx, config)
- Human Command：ctx.commands.register 与 command/run、command/done 生命周期

## 关键模块标记
- dsh.bundle.patch
- ctx.effect
- command/run + command/done
