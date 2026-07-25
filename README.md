# spec-workflow

独立于代码仓库的规格驱动工作区。一个工作流仓库管理一个逻辑项目，可以关联多个外部 Git 仓库；目标仓库无需安装工作流文件。

## 开始使用

要求 Git 和 Node.js 22.12.0 或更高版本。

1. 复制本模板并初始化 Git 仓库。
2. 从仓库根目录启动 Agent；若它没有自动读取入口，要求它读取 `AGENTS.md` 并调用 `sw-setup`。
3. setup Skill 探测 Agent、目标仓库和项目事实，只询问无法确定的必要信息。
4. setup 完成后由 Agent 运行 `node tools/workflow.js doctor`。
5. 创建迭代和任务：

```text
node tools/workflow.js iteration create --title "首个迭代"
node tools/workflow.js task create --iteration <iteration-id> --title "任务名" --repositories backend,frontend
node tools/workflow.js task status <task-path> --json
```

## Tools 边界

CLI 只处理重复、稳定、结构化的动作：

- setup 写入最小机器配置并同步 Agent 入口和 Skills 链接；
- doctor 只读检查工作流和 Agent 接入；
- iteration/task 命令维护最小状态和合法阶段转换；
- Git 快照自动记录实施基线与最终事实；
- simple change 追加最小交付记录。

Skills 负责理解环境、编写 Markdown、判断内容质量、组织评审和取得用户确认。CLI 不解析标题、AC、证据或占位文本，不生成阶段文档和发布方案，也不维护长期记忆、审批、内容 hash 或并发 revision。

## Setup

setup CLI 非交互且调用即写入。setup Skill 根据 Agent 能力传入必要路径：

```text
node tools/workflow.js setup --agent <id> [--entry-path <relative-path>] [--skills-path <relative-path>] --repo backend=<git-root> --repo frontend=<git-root> --json
```

不传 `--entry-path` 表示 Agent 原生读取根 `AGENTS.md`；不传 `--skills-path` 表示原生读取 `.agents/skills`。CLI 不维护 Agent 名单。目标 Skills 位置存在用户内容时停止，只有用户明确授权后才使用 `--replace`。

入口和 Skills 必须使用专用的接入路径，二者不能重叠，也不能指向 `.git`、`.agents`、`tools`、`iterations`、项目事实或其他工作流受管文件。setup 在写入前完成预检，失败时恢复本次已经修改的接入内容。

CLI 只管理 `AGENTS.local.md` 中的配置块：

```json
{
  "schema_version": 1,
  "agent": {
    "id": "codex"
  },
  "repositories": [
    {
      "id": "backend",
      "path": "C:/projects/backend"
    }
  ]
}
```

项目目标、仓库角色、模块、启动命令、端口、环境变量名、配置中心、联调方式和环境矩阵由 setup Skill 写入 `CONTEXT.md`、`project/index.md` 和 `project/repositories/*.md`。本机覆盖和环境权限写在 `AGENTS.local.md` 受管块之外。任何位置都不得保存凭据值。

## Doctor

```text
node tools/workflow.js doctor [--json]
```

doctor 检查 Node.js、CLI、根入口、Skills 发现、setup 配置、目标 Git 根目录、当前 Agent 入口、Skills 链接和本地排除规则。它不扫描 iteration/task，不审查 Markdown、项目事实或 ADR，也不提供修复模式；修复交给 `sw-setup`。

## Iteration 与 Task

任务按固定顺序推进：

```text
prd -> technical_design -> implementation_spec -> implementation -> verification -> done
```

`task phase` 只允许显式进入相邻下一阶段，并要求 `--confirmed`。CLI 只检查当前阶段文件存在；产物质量由对应 Skill、代码审查和用户确认负责。

`task create` 只创建任务目录和 `task.json`。各 Skill 自行创建和维护：

- `prd.md` 与 `decisions.md`
- `technical-design.md`
- `spec.md`
- `verification.md`

进入 implementation 时记录仓库 canonical root、branch、baseline HEAD 和初始脏文件；进入 done 时记录最终 HEAD、HEAD tree 和剩余脏文件。这些是追踪事实，不是质量门禁。

```text
node tools/workflow.js iteration list [--status open|closed|cancelled] [--json]
node tools/workflow.js iteration status <iteration> [--json]
node tools/workflow.js iteration close <iteration> --confirmed
node tools/workflow.js iteration cancel <iteration> --confirmed

node tools/workflow.js task list [--iteration <iteration>] [--json]
node tools/workflow.js task status <task> [--json]
node tools/workflow.js task phase <task> <next-phase> --confirmed
node tools/workflow.js task cancel <task> --confirmed
node tools/workflow.js task reopen <task> --confirmed
node tools/workflow.js task move <task> --iteration <iteration>
```

取消不会级联，也不会物理删除记录。开放迭代中的 cancelled 任务恢复到取消前阶段；done 任务固定恢复到 verification。closed/cancelled iteration 不重开。

## Simple Change 与发布

局部简单变更完成验证、审查和提交后，登记到开放迭代：

```text
node tools/workflow.js simple-change add --iteration <iteration> --summary <text> --repositories backend,frontend
```

CLI 自动记录最终 Git 快照。`iteration status --json` 聚合任务和 simple changes，供 `sw-release-plan` 编写 `release-plan.md`。CLI 不生成或确认发布方案；只有用户明确说明实际发布完成后，Skill 才运行 `iteration close --confirmed`。收口只检查全部任务已 done/cancelled 且 `release-plan.md` 存在。

## 项目长期记忆

`CONTEXT.md` 保存项目简介、专业术语和关键决策索引；ADR 位于根目录 `adr/`；`project/index.md` 和 `project/repositories/*.md` 保存验证后的当前事实。

`sw-domain-modeling` 直接维护 `CONTEXT.md` 和 ADR。ADR 编号取现有文件最大编号加一，历史和冲突由 Git 管理，不使用额外 JSON 状态。

## 命令输出

全部命令支持 `--json`。JSON 模式的 stdout 只包含一个 JSON 值；错误写入 stderr。成功退出码为 0，失败为 1；doctor 只有 warning 时仍返回 0。

CLI 不执行 stash、reset、checkout、建分支、push、merge、部署、DDL 或生产写入。
