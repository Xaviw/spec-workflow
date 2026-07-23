---
name: spec-driven-setup
description: 初始化或更新 spec-driven-template 工作流仓库。首次使用、AGENTS.local.md 缺失、代码仓库映射变化、Agent 接入变化，或用户要求配置项目时使用。
---

# 初始化工作流

## 上下文契约

必读：`AGENTS.md`、`tools/agent-adapters.json`、`WORKFLOW_VERSION`，以及已有的 `AGENTS.local.md`。

按需读取：候选代码仓库的 Git 元数据、README、运行时配置文件和已有项目文档。只读取当前正在确认的仓库。

初始禁止：业务代码、其他任务、全部仓库文档、密钥文件内容。

输出：`AGENTS.local.md`、`project/index.md`、`project/repositories/*.md`、必要的本地 Agent 适配器，以及 doctor 结果。

## 流程

1. 运行 `node tools/workflow.js setup` 完成必要配置。只有用户要逐项设置启动命令、端口、配置依赖、环境权限和联调方式时，才运行 `setup --detailed`。
2. 已有 `AGENTS.local.md` 时复用项目、Agent、Git 邮箱和仓库配置作为默认值；让 CLI 自动探测其他可验证事实，对无法确定的选择逐项询问。
3. 默认只确认：
   - 项目名称和目标；
   - 当前使用的 Agent；
   - 用户 Git 邮箱；
   - 每个代码仓库的稳定 ID、精确 Git 根目录和角色。
4. 在 detailed 模式再确认：
   - 启动命令、启动端口、可选运行时版本；
   - 环境变量名、配置中心或外部服务依赖；
   - 联调方式，例如直接改代码或使用 Whistle；
   - 环境列表、本地可操作范围和切换方式。
5. 使用 1-64 位小写 ASCII 仓库 ID；只登记 `git rev-parse --show-toplevel` 对应根目录。拒绝重复 canonical path、子目录、保留设备名和带凭据的 remote。未知信息记录为 `unknown`，不要猜测。
6. 让 CLI 展示一次完整预览，取得用户确认后再写入。
7. 运行 `node tools/workflow.js doctor`。只有 doctor 通过后才进入写操作工作流。

## Agent 接入

- Codex、Reasonix、Pi、Cursor、OpenCode 原生读取 `AGENTS.md` 和 `.agents/skills`，只做可见性检查。
- Trae 原生支持这两个路径，但需让用户在 Settings > Rules > Import Settings 中启用 `Include AGENTS.md in the context`，并在 Settings > Skills & Commands > Import Settings 中启用 `Enable .agents Skills Directory`。
- Claude Code 生成根 `CLAUDE.md`，内容导入 `AGENTS.md`；将 `.agents/skills` 链接到 `.claude/skills`，失败时复制。
- 自定义 Agent 必须由用户给出入口文件和项目 Skills 目录；优先链接，失败时复制。
- 所有生成适配器仅存在于当前工作流仓库，并保持 Git 忽略。

## 安全规则

- 只记录环境变量名和密钥获取方式，不读取或记录值。
- 发现 token、password、secret、private key 等疑似值时停止写入，指出字段，不回显内容。
- 默认拒绝远程环境写权限；生产写入、部署和 DDL 执行始终禁止。
- 不自动启动服务、克隆仓库或修改目标代码仓库；这些动作必须单独取得确认。
