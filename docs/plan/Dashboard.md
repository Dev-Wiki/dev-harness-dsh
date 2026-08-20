# 当前状态看板

> 本文档是当前活动计划的索引层，只维护优先级、状态、覆盖和跳转。实施细节在 [任务详情](TaskDetails.md) 中维护，产品需求以 [MVP 需求](../product/REQUIREMENTS.md) 为准。

## 1. 进度快照

- **核心阶段**：S1 Full Verification（🚧 开发中）
- **当前瓶颈**：K4 已固定不可变 Run 授权、下游 commit-each 证据与 post-commit Git 接纳；S1 尚未把已确认的 `harness:full` 纳入可恢复编排
- **首版目标**：完成 Audit → Finding Router → Auto Fix → Full Verification → QA → Final Reconciliation → Report 的可恢复编排闭环
- **需求状态**：MVP 需求已整理；DSH 目标版本固定为 rc.8，V0、K1、K2、K3、K4 已完成，生产编排进入 S1

## 2. 当前产品目标

`dev-harness-dsh` 为 DeepSeek Harness 环境提供 `dev-harness` 跨 Skill 编排、队列、授权、恢复和最终验收能力。它只维护编排状态与下游引用，不复制 Skill 语义或证据。

**本次聚焦**：先证明 DSH 的公开扩展面，再实现 CLI / Human Command、Orchestrator、状态持久化与 resume，随后逐步接入 Audit、Auto Fix、完整验证、QA 和最终复核。Web UI、自动 PR / push / release / deploy 均不进入 MVP。

## 3. 需求索引表

| 需求项 | 优先级 | 状态 | 专题层 / 详情 |
|---|---|---|---|
| **V0 — DSH 集成面调研** | 🔴 P0 | ✅ 已完成 | [Task V0](TaskDetails.md#task-v0) |
| **K1 — Plugin Skeleton 与状态基线** | 🔴 P0 | ✅ 已完成 | [Task K1](TaskDetails.md#task-k1) |
| **K2 — Audit Orchestration 与 Router** | 🔴 P0 | ✅ 已完成 | [Task K2](TaskDetails.md#task-k2) |
| **K3 — Auto Fix 队列与恢复** | 🔴 P0 | ✅ 已完成 | [Task K3](TaskDetails.md#task-k3) |
| **K4 — 提交授权模型** | 🔴 P0 | ✅ 已完成 | [Task K4](TaskDetails.md#task-k4) |
| **S1 — Full Verification** | 🟡 P1 | 🚧 开发中 | [Task S1](TaskDetails.md#task-s1) |
| **S2 — QA Adapter 与失败闭环** | 🟡 P1 | 📋 规划中 | [Task S2](TaskDetails.md#task-s2) |
| **S3 — Final Reconciliation** | 🟡 P1 | 📋 规划中 | [Task S3](TaskDetails.md#task-s3) |
| **S4 — Run Summary** | 🟡 P1 | 📋 规划中 | [Task S4](TaskDetails.md#task-s4) |

## 4. 需求覆盖矩阵

| 来源范围 | 需求描述 | MVP 覆盖 | 任务 |
|---|---|---|---|
| M1 | Plugin 入口、依赖检查、状态和测试 | ✅ | V0、K1 |
| M2 | Codebase Audit 调度、Findings 和 Router | ✅ | K2 |
| M3 | Auto Fix 队列、CompletionStatus 和 resume | ✅ | K3 |
| M4 | `fix-only` / `commit-each` 授权 | ✅ | K4 |
| M5 | 调度项目 `harness:full` | ✅ | S1 |
| M6 | QA Adapter 与失败重试 | ✅ | S2 |
| M7 | fresh Snapshot 最终复核 | ✅ | S3 |
| M8 | 统一 Run Summary | ✅ | S4 |
| 非目标 | Web UI、push、PR、release、deploy | ❌ | 明确排除，不创建实施任务 |

## 5. 当前缺口与起手任务

1. **S1 — Full Verification**（🟡 P1，🚧 开发中）：在修复队列完成后调度已确认的 `harness:full`，绑定实际 snapshot 并传播失败。
2. **S2 — QA Adapter 与失败闭环**（🟡 P1）：等待 S1 固定完整验证结果后，建立可验证的 QA 能力选择与重试契约。

> 起手顺序：V0 → K1 → K2 → K3 → K4 → S1 → S2 → S3 → S4。

## 6. 验收口径

- 每个任务都有仓库内实现或验证证据后才能标记完成；
- Plugin 只使用 DSH 已确认的公开扩展面，不修改 DSH Core；
- 下游 Skill 的完成状态由其权威状态契约决定，不从聊天文本或单个工具结果推断；
- 中断后能校验并恢复，工作区或依赖漂移时 fail closed；
- 未经独立授权不执行 push、PR、tag、release 或 deploy；
- 最终报告能追溯 Audit、Auto Fix、验证、QA 和 Reconciliation 的下游 Run。

---

*最后更新：2026-08-20（Task K4 完成，Task S1 启动）*
