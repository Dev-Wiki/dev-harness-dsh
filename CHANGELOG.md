# Changelog

本文件记录 dev-harness-dsh 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 版本策略

- **0.x 预览期**：与 DeepSeek Harness `0.1.0-rc.8` 精确锁定；破坏性变更不跨 rc 兼容，升级 DSH 前必须重跑 V0 fixture 与集成基线取证。
- 每次发布前必须通过 [HARNESS.md](HARNESS.md) 定义的 canonical full verification。
- 发布只生成本地 `.tgz`（`python3 release.py`），不执行 npm registry publish、Git tag、push 或 GitHub Release。

## [0.1.0] - 2026-08-20

MVP 编排基线收口版本。

### Added

- 可恢复编排闭环：Audit → Finding Router → Auto Fix → Full Verification → QA → Final Reconciliation → Run Summary。
- Human Command：`/harness-run`（`fix-only` / `commit-each`、`qa=<adapter-name>`）、`/harness-resume`、`/harness-status`、`/harness-cancel`。
- 不可变 Run Authorization（`fix-only` / `commit-each`，外部动作一律拒绝）与 Git 提交边界独立核验。
- 原子 Run State：Git private dir 持久化、revision CAS、文件锁、工作区/依赖/Context 漂移 fail-closed 校验。
- 版本化 Adapter 合同：Audit、Auto Fix、Full Verification、QA（verified 注册 + manual checklist 降级）、Final Reconciliation。
- 统一 Run Summary（`DONE` / `DONE_WITH_CONCERNS`）与 schema 校验。
- 本地发布流水线 `release.py`（canonical full 验证 + 包内容/SHA-256 校验）。
- GitHub Actions CI（`.github/workflows/ci.yml`）：`harness:full` + V0 fixture verify。

### Changed

- QA Adapter 的 `verificationEvidenceRef` 必须是 URI 形式引用（如 `qa:`、`https:`、`file:`）；`file:` 引用在注册/选择时必须真实存在，否则 fail closed。
- `defineExternalSkillQaAdapter` / `defineNativeQaAdapter` 要求显式传入 `verificationEvidenceRef`，不再由辅助函数隐式补全。
- `/harness-cancel` 对终态 Run（FAILED / DONE / DONE_WITH_CONCERNS / CANCELLED）幂等返回，不再尝试非法状态转移。
- 命令错误白名单补充 `INVALID_TRANSITION`、`NOT_GIT_REPOSITORY`、`REVISION_CONFLICT`，以友好错误文本返回。

### Fixed

- HARNESS.md 自动化用例计数与实测一致（68 个）。
- README 增加使用示例与恢复语义提示。

### Security

- 状态文件 0600 / 目录 0700；拒绝 symlink 与路径逃逸；提交边界由 Git object/ancestry/路径独立核验。
