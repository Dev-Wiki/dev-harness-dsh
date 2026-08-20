# 项目架构分析

## 模块依赖关系图
V0 fixture 直接依赖 Schemastery，peer 依赖 Cordis 与 dsh-commands；开发依赖精确锁定 rc.8 的 AgentLoop、LLM、checkpoint/JSONL persistence、Subagent 与 Worker Workflow 运行栈

## 核心业务流程
V0 fixture 验证 rc.8 的 Plugin/Command、Agent create/cancel/clean resume、SIGKILL checkpoint repair 与 Worker Workflow 生命周期

## 架构模式
产品需求、活动看板、任务详情与集成证据分层维护；可执行面隔离在 experiments/v0-minimal-plugin

## 模块接口与通信方式
- Bundle manifest：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml
- Plugin surface：name、inject、Config、apply(ctx, config)
- Human Command：ctx.commands.register 与 command/run、command/done 生命周期
- Agent：公开 LLM adapter + ctx.agents create/cancel/resume + JSONL persistence
- Workflow：SubagentRuntime + WorkerThreadWorkflowEngine + holder-owned WorkflowRun disposer

## 关键模块标记
- dsh.bundle.patch
- ctx.effect
- command/run + command/done
- ctx.agents.create + ctx.agents.resume
- ctx.workflowEngine.start + WorkflowRun.dispose
