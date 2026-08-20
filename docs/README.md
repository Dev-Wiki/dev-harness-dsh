# dev-harness-dsh 文档中心

本目录是 `dev-harness-dsh` 唯一的项目文档根。当前仓库处于规划阶段；需求、任务状态和实现证据必须分开维护。

## 产品需求

- [MVP 需求](product/REQUIREMENTS.md)：Plugin 定位、职责边界、工作流、集成假设和验收标准的权威文档。

## 活动计划

- [当前状态看板](plan/Dashboard.md)：优先级、状态、覆盖范围和当前阻塞。
- [任务详情](plan/TaskDetails.md)：任务背景、文件边界、执行步骤、验证和风险。

## 集成基线

- [DSH rc.8 API 基线](integration/DSH_API_BASELINE.md)：V0 的版本锁定、证据等级、已执行验证与剩余停止线。

## 文档维护边界

- `product/REQUIREMENTS.md` 维护产品需求，不记录任务进度或已实现状态。
- `plan/Dashboard.md` 只维护状态和链接，不复制实施细节。
- `plan/TaskDetails.md` 维护活动任务；未经实现或验证证据不得标记完成。
- `integration/DSH_API_BASELINE.md` 维护 DSH 集成事实与验证边界，不承担任务状态汇总。
- 外部 DSH API、SDK 和运行时行为在验证前只放在“待确认”范围，不写成当前事实。
- 发布变化未来由 `CHANGELOG.md` 维护；本文档中心只提供入口。
