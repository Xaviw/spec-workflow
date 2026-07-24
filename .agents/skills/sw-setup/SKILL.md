---
name: sw-setup
description: 初始化或更新 spec-driven-template 工作流仓库，并在完成后运行 doctor 验证。当前请求需要运行工作流但必要配置缺失、代码仓库映射或 Agent 接入发生变化，或用户要求初始化、更新配置时使用。
---

# 初始化工作流

## 上下文契约

必读：`AGENTS.md`、`tools/agent-adapters.json`，以及已有的 `AGENTS.local.md`。

按需读取：候选代码仓库的 Git 元数据、README、运行时配置文件和已有项目文档。只读取当前正在确认的仓库。

初始禁止：业务代码、其他任务、全部仓库文档、密钥文件内容。

输出：`AGENTS.local.md`、根目录 `CONTEXT.md`、`project/memory.json`、`project/index.md`、`project/repositories/*.md`、必要的本地 Agent 适配器，以及 doctor 结果。

## 流程

1. 运行 `node tools/workflow.js setup`。完成：CLI 已加载现有配置并给出待确认项。
2. 复用已有项目、Agent 和仓库配置，让 CLI 探测可验证事实，只询问无法确定的选择。确认：
   - 项目名称和目标；
   - 当前使用的 Agent；
   - 每个代码仓库的稳定 ID、精确 Git 根目录、角色和主要模块；
   - 启动命令、启动端口、可选运行时版本；
   - 环境变量名、配置中心或外部服务依赖；
   - 联调方式，例如直接改代码或使用 Whistle；
   - 环境列表、本地可操作范围和切换方式。
   完成：必要字段都有确认值或 `unknown`。
3. 校验仓库 ID 为 1-64 位小写 ASCII，只登记 `git rev-parse --show-toplevel` 的根目录；拒绝重复 canonical path、子目录、保留设备名和带凭据的 remote。完成：每个仓库映射唯一且可验证。
4. 展示一次完整预览，取得确认后写入；首次 setup 使用项目名称和目标创建根 `CONTEXT.md` 及 revision=0 的 `project/memory.json`，已有受管状态则完整保留，再运行 `node tools/workflow.js doctor`。完成：预期文件已生成且 doctor 无阻塞；否则停在 setup/doctor。

## Agent 接入

以 `tools/agent-adapters.json` 为单一映射：原生接入只检查可见性并遵循 `setup_note`；非原生接入先预览适配器，确认后链接，失败时复制。自定义 Agent 由用户提供入口和 Skills 目录。生成内容只留在本仓库并保持 Git 忽略。

## 安全规则

只记录环境变量名和密钥获取方式；发现疑似值时停止写入并只指出字段。保持生产写入、部署和 DDL 权限关闭；启动服务、克隆或修改目标仓库必须另行确认。
