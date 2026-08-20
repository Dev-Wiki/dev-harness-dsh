# 安装与启用 dev-harness-dsh

本文档说明如何把本仓库生成的本地 `.tgz` 安装到 DeepSeek Harness profile、验证组合结果，以及升级或卸载插件。当前生产包面向 DeepSeek Harness `0.1.0-rc.8`。

## 前置条件

- Node.js `^22.19.0` 或 `>=24.0.0`；
- DeepSeek Harness `0.1.0-rc.8`，并已有可用 profile；
- 插件要求的四个核心 Skill 能被 DSH Skill filesystem 找到；
- 安装命令中的 profile 与实际启动 DSH 时使用的 profile 一致。

先确认 DSH 版本：

```shell
dsh --version
```

预期版本为 `0.1.0-rc.8`。预览期升级 DSH 后，应先重新验证依赖和 bundle/profile 兼容性，不能直接沿用本文档结论。

## 1. 准备发布包

在本仓库根目录执行：

```shell
python3 release.py
```

脚本会先运行 canonical full verification，再生成并校验：

```text
dist/dev-harness-dsh-<version>.tgz
```

同名文件已存在时，脚本默认拒绝覆盖。确认替换本地包时使用：

```shell
python3 release.py --force
```

`release.py` 只构建本地包，不会执行 npm registry publish、Git tag、push 或外部 release。

## 2. 安装到 DSH profile

以下命令以 `headless` profile 为例；如果实际使用其他 profile，应把所有命令中的 `headless` 替换为同一个名称。

```shell
dsh plugin --profile headless add "/absolute/path/to/dev-harness-dsh/dist/dev-harness-dsh-<version>.tgz" --ignore-scripts
```

应使用 `.tgz` 的绝对路径，避免相对路径被目标 profile 的工作目录解析。`--ignore-scripts` 禁止依赖安装阶段执行生命周期脚本，符合本项目的第三方依赖安装边界。

安装会把 `dev-harness-dsh` 加入该 profile 的 dependencies 和 bundle 列表，不会影响其他 profile。

## 3. 安装必需 Skills

插件只负责工作流编排，不把下游 Skill 的语义或证据复制进 npm 包。运行 `/harness-run` 或 `/harness-resume` 前，DSH 必须能找到以下 Skill：

- `dev-harness-codebase-audit`
- `dev-harness-auto-fix`
- `dev-harness-git-workflow`
- `dev-harness-commands`

推荐把 Skill 安装到用户级目录，供多个工作区复用：

```text
~/.agents/skills/<skill-name>/SKILL.md
```

也可以随目标项目放置：

```text
<target-repository>/.dsh/skills/<skill-name>/SKILL.md
<target-repository>/.agents/skills/<skill-name>/SKILL.md
```

DSH rc.8 的完整优先级是目标项目 `.dsh/skills`、目标项目 `.agents/skills`、custom provider、用户 DSH、用户 agents、bundled Skill。项目级 Skill 的根目录由当前工作区最近的 Git 根确定，因此 linked worktree 可以保持独立内容。

如果任一核心 Skill 缺失，Human Command 会在 Skill preflight 阶段停止，不会把不完整的运行标记为成功。

## 4. 验证安装

输出当前 profile 的组合配置：

```shell
dsh --profile headless --dump-config
```

结果应包含：

```yaml
- id: dev-harness-dsh
  name: dev-harness-dsh
  config: {}
```

这一步证明 package bundle patch 已被目标 profile 组合。启动 DSH 时必须继续使用同一个 profile。

插件加载后注册以下 Human Command：

```text
/harness-run [fix-only|commit-each] [qa=<adapter-name>]
/harness-resume <run-id>
/harness-status [run-id]
```

命令必须在带工作区目录的 Session 中执行。`fix-only` 是 `/harness-run` 的默认授权；`commit-each` 仅授权 Auto Fix 按合同提交，不授权 push、PR、tag、release 或 deploy。

## 5. 升级或重新安装

生成新包后，对同一个 profile 重复执行安装命令：

```shell
dsh plugin --profile headless add "/absolute/path/to/dev-harness-dsh/dist/dev-harness-dsh-<new-version>.tgz" --ignore-scripts
```

然后再次执行 `--dump-config` 检查组合结果。需要回退时，安装保留的旧版本 `.tgz` 并重新验证。

## 6. 卸载

从指定 profile 移除插件：

```shell
dsh plugin --profile headless remove dev-harness-dsh
```

卸载后再次执行：

```shell
dsh --profile headless --dump-config
```

组合结果中不应再出现 `id: dev-harness-dsh`。卸载只修改指定 profile，不删除项目或用户目录中的 Skill，也不删除已有 Git private run state。

## 常见问题

### 组合配置中没有插件

确认安装和 `--dump-config` 使用了同一个 profile，并检查 `.tgz` 是否使用绝对路径。安装成功不能代替组合验证，应以目标 profile 的 `--dump-config` 结果为准。

### Skill preflight 报缺失

确认四个核心 Skill 的目录名和 `SKILL.md` 中的 `name` 完全一致，并且目录位于当前工作区或用户级 Skill filesystem 搜索路径中。安装 npm 包不会自动安装这些 Skill。

### 出现 peer dependency 警告

插件的 peer dependencies 由 DSH host profile 提供。先确认 DSH 精确版本为 `0.1.0-rc.8`，再检查组合配置中是否存在 Cordis、commands 和 skill 服务；不要在版本不匹配时忽略警告继续运行。

## 验证边界

- `.tgz` 安装、profile dependency/bundle 注册、`--dump-config` 组合结果和卸载命令已经在隔离的 DSH rc.8 profile 中验证；
- Plugin 生命周期、Human Command 注册/卸载和生产合同由自动化测试覆盖；
- 当前没有已验证的 external Skill 或 native browser/UI QA 协议；没有带验证证据的 QA Adapter 时，运行会生成 manual checklist 并停在 `NEEDS_USER`，不会声明 QA PASS。

DSH rc.8 的底层集成证据与停止线见 [DSH rc.8 API 基线](../integration/DSH_API_BASELINE.md)。
