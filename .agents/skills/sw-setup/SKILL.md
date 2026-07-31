---
name: sw-setup
description: 初始化或更新工作流的 Agent 接入、仓库映射和项目事实，并在完成后运行 doctor。当前请求需要运行工作流但必要配置缺失，代码仓库映射或 Agent 接入发生变化，或用户要求初始化、更新配置时使用。
---

# 初始化工作流

## 上下文契约

必读：`AGENTS.md` 和已有的 `AGENTS.local.md`。

按需读取：当前 Agent 的入口与 Skills 约定；用户已明确指定或确认的代码仓库的 Git 元数据、README、运行时配置和已有项目文档。一次只探测一个已确认仓库。

初始禁止：业务代码、其他任务、全部仓库文档和密钥文件内容。

输出：CLI 受管的 `AGENTS.local.md` 配置与 Agent 接入；Skill 维护的 `CONTEXT.md`、`project/index.md`、`project/repositories/*.md` 和本地环境说明；doctor 结果。

## 职责边界

CLI 只记录稳定的机器配置：Agent ID、可选入口路径、可选 Skills 路径、仓库 ID 到 canonical Git 根目录的映射，以及实施中任务到 exact root 的临时绑定。CLI 写入入口受管块、Skills 链接和本地 Git 排除规则；任务绑定进入 done 后自动移除。

本 Skill 负责理解并写入项目事实：

- 项目名称、目标和仓库角色写入 `CONTEXT.md`、`project/index.md`；
- 模块、仓库原生启动与验证命令、默认端口、运行时要求、环境变量名、配置中心、外部依赖、联调方式、环境列表和切换方式写入 `project/repositories/<repo-id>.md`；
- 除 CLI 受管的仓库映射和临时任务绑定外，本机绝对路径、命令包装、版本管理器、可执行文件位置、端口覆盖、本地可操作环境和远程只读环境写在 `AGENTS.local.md` 的 CLI 受管块之外。

本地事实不能扩大 `AGENTS.md` 的安全授权。任何位置都只记录环境变量名、依赖和获取方式，不记录凭据值。

目标仓库选择门禁：只有用户在当前请求中明确给出的仓库，或用户对 Agent 提示的候选仓库明确确认后，才可作为目标仓库。Agent 可基于可见工作区信息提出候选及依据，但名称相似、相邻目录、已有文档、Git remote 和其他推断都不构成授权；在用户选择前不得读取候选仓库内容、为其确定 ID、执行 setup、写入仓库映射或项目事实。用户未指定时必须先提示并等待，不得以默认候选继续。

## 流程

1. 读取已有配置并探测当前 Agent。若 Agent 原生读取根 `AGENTS.md` 或 `.agents/skills`，对应路径不传；否则确认专用的入口文件和 Skills 目录。两个路径不得重叠或指向工作流核心、任务、项目事实和 Git 元数据。CLI 不维护 Agent 名单，无法从当前环境确定时再询问用户。完成：得到 Agent ID 及必要的两个可选相对路径。
2. 对每个已由用户明确指定或确认的目标仓库运行 Git 根目录检查，确认稳定的小写 ASCII ID。拒绝重复 canonical path、子目录和非 Git 根目录。完成：仓库映射唯一且可验证。
3. 探测已确认目标仓库的项目事实，只询问无法从仓库或现有文档确定的内容。至少确认项目名称和目标、仓库角色、主要模块、启动方式、配置依赖、联调方式和环境边界；未知事实明确写为未知，不猜测。完成：共享事实与本机事实已经分开。
4. 使用完整期望配置运行一次 setup；传入 `--agent` 会替换 Agent 接入设置，传入一个或多个 `--repo` 会替换仓库映射：

   ```text
   node tools/workflow.js setup --agent <id> [--entry-path <path>] [--skills-path <path>] --repo <repo-id>=<git-root> ... --json
   ```

   若目标 Skills 位置已有用户内容，停止并展示冲突；只有用户明确允许覆盖这些精确目标后才添加 `--replace`。核对 JSON `actions` 已逐项反映受管路径的 `created/updated/unchanged/removed`；实际内容变化却没有对应 action 时视为 setup 失败，不用额外写入掩盖。完成：CLI 受管配置和接入已同步，不存在部分替换。
5. 创建或更新 `CONTEXT.md`、`project/index.md`、对应仓库说明，以及 `AGENTS.local.md` 受管块外的本机事实。保留用户已有内容和当前事实，不创建额外状态文件；提交前检查项目事实没有本机绝对路径、命令包装、版本管理器或可执行文件位置。完成：项目事实可从约定入口发现且可跨环境复用。
6. 运行 `node tools/workflow.js doctor --json`。只处理其报告的接入错误；doctor 无 error 后结束。完成：工作流、Agent、Skills 和仓库映射均可用。

## 安全规则

setup 不启动服务、不克隆或修改目标代码仓库，不授予生产写入、部署或 DDL 执行权限。发现疑似密钥值或来源不明的重叠内容时停止写入，只指出位置和所需决定。
