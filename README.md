# spec-driven-template

面向传统全栈项目的独立规格驱动工作流。一个工作流仓库可关联多个分散的 Git 代码仓库，代码仓库本身无需安装任何工作流文件。

## 开始使用

要求：Git，以及 Node.js 22.12.0 或更高版本。

1. 复制本模板，作为某个逻辑项目的独立工作流仓库。
2. 确保复制后的工作流目录本身是 Git 仓库；直接复制文件时先运行 `git init`。
3. 在仓库根目录启动 Claude Code、Codex、Reasonix、Pi、Cursor、Trae 或 OpenCode。
4. 若 Agent 没有自动读取入口，发送：`请读取 AGENTS.md，并执行 spec-driven-setup。`
5. 按提示选择 Agent、登记代码仓库及本地运行信息。
6. 运行 `node tools/workflow.js doctor` 检查接入结果。

setup 只在当前工作流仓库中生成 Agent 适配文件。项目私有路径和偏好写入被 Git 忽略的 `AGENTS.local.md`；密钥值仍应保存在环境变量、`.env` 或密钥管理系统中。

## Agent 接入

| Agent | 项目入口 | 项目 Skills | setup 动作 |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` | `.claude/skills` | 生成 `@AGENTS.md` 入口，并链接或复制 Skills |
| Codex | `AGENTS.md` | `.agents/skills` | 原生检查 |
| Reasonix | `AGENTS.md` | `.agents/skills` | 原生检查 |
| Pi | `AGENTS.md` | `.agents/skills` | 原生检查 |
| Cursor | `AGENTS.md` | `.agents/skills` | 原生检查 |
| Trae | `AGENTS.md` | `.agents/skills` | 原生检查；按 setup 提示启用两个导入开关 |
| OpenCode | `AGENTS.md` | `.agents/skills` | 原生检查 |

当前路径和核实来源维护在 `tools/agent-adapters.json`。未知工具可在 setup 中选择 `custom`，生成文件会写入当前仓库的 `.git/info/exclude`。

## 目录

```text
AGENTS.md                  跨 Agent 的最小入口
.agents/skills/            工作流 Skills
tools/                     无第三方依赖的 Node.js CLI
tools/test/                CLI 确定性规则的最小回归测试
project/                   setup 后生成的项目事实
iterations/                迭代与任务文档
AGENTS.local.md            setup 后生成，不提交
```

`tools/test/` 不测试 Agent 的文字表达，也不模拟完整开发项目；它只保护阶段转换、候选可用性过滤、上下文选择、危险路径、发布聚合和本地密钥检查这些必须稳定的规则。运行方式：

```text
cd tools
npm test
```

任务位于 `iterations/<iteration-id>/<task-id>/`。新任务初始只创建：

```text
task.json
prd.md
decisions.md
```

后续按阶段创建 `technical-design.md`、`spec.md` 和 `verification.md`。过大的实施任务可在 `slices` 中拆分，但不会额外复制整套需求文档。

## 常用命令

```text
node tools/workflow.js setup
node tools/workflow.js doctor
node tools/workflow.js iteration create --title "迭代目标" --goal "目标"
node tools/workflow.js task create --iteration <iteration-id> --title "任务名" --summary "摘要"
node tools/workflow.js task candidates --json
node tools/workflow.js task phase <task-path> <phase> --confirmed
node tools/workflow.js context <skill-name> --task <task-path>
node tools/workflow.js context spec-driven-release-plan --iteration <iteration-id>
node tools/workflow.js iteration release-plan <iteration-id> --apply
node tools/workflow.js help
```

删除、移动和适配器修复默认只预览；确认目标后再次添加 `--apply`。完整参数以 `help` 输出为准。
任务向前推进阶段时，只有用户确认当前阶段产物后才能添加 `--confirmed`。

## 更新模板核心

模板不会联网自更新。需要升级时，只合并上游维护的 `AGENTS.md`、`.agents/skills/`、`tools/` 和 `WORKFLOW_VERSION`，保留项目自有的 `project/`、`iterations/` 与 `AGENTS.local.md`，然后运行测试和 doctor。项目特殊规则写入可选的 `project/policies.md`，不要直接改上游核心。

## 文档模型

- `project/index.md`：项目目标与仓库导航。
- `project/repositories/<repo-id>.md`：仓库登记信息及长期说明。
- `project/knowledge/<topic>.md`：验证后的复用知识，按需创建。
- `project/policies.md`：可选的项目特殊规则。
- `iterations/<iteration-id>/iteration.json`：迭代状态、目标和可选版本。
- `iterations/<iteration-id>/changes.jsonl`：未建立任务的独立简单变更。
- `iterations/<iteration-id>/<task-id>/`：一个工作流任务的当前文档。

任务文档描述目标事实，现有代码描述当前事实。两者冲突时必须显式记录差距，不得用现状覆盖已确认需求。
