# 项目架构分析

## 模块依赖关系图
生产包 peer 依赖 Cordis、dsh-commands 与 dsh-skill，运行时依赖 atomic-write 与 Schemastery；开发依赖精确锁定 rc.8 Session 与 Skill filesystem 测试栈

## 核心业务流程
生产 Human Command 先做 cwd-sensitive Skill preflight，再创建或恢复 private-Git-dir Run State；状态更新使用锁、revision CAS 与环境漂移复核

## 架构模式
生产 Cordis Service、Human Command、Skill preflight 与原子 Run State 分层实现；产品需求、活动计划与集成证据分别维护，V0 fixture 保留为兼容性证明

## 模块接口与通信方式
- Bundle manifest：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml
- Plugin surface：name、inject、Config、apply(ctx, config)
- Human Command：ctx.commands.register 与 command/run、command/done 生命周期
- Agent：公开 LLM adapter + ctx.agents create/cancel/resume + JSONL persistence
- Workflow：SubagentRuntime + WorkerThreadWorkflowEngine + holder-owned WorkflowRun disposer
- Tool：AgentLoop 驱动 live tools/* 与 durable tool/* 配对并通过 JSONL replay
- Skill/state：cwd-sensitive SkillFileSystem + private Git dir + cross-process atomic state
- Run State：Git private dir + environment snapshot + file lock + revision CAS

## 关键模块标记
- ctx.devHarness + harness-run/resume/status
- private Git dir + revision CAS + validateResume
- dsh.bundle.patch
- ctx.effect
- command/run + command/done
- ctx.agents.create + ctx.agents.resume
- ctx.workflowEngine.start + WorkflowRun.dispose
- tools/pre-execute + tools/execute + tools/post-execute + tools/result
- git rev-parse --absolute-git-dir + writeFileAtomic + withFileLock
