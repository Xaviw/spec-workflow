---
name: sw-doctor
description: 只读诊断工作流安装、Agent 入口、Skills 映射、本地配置、目标 Git 仓库和 Node 版本。工作流命令失败，或安装、配置、Agent 接入发生变化后需要核验时使用；不要仅因新建会话而调用。
---

# 诊断工作流

## 上下文契约

必读：`AGENTS.md` 和 doctor 输出。

按需读取：仅在定位对应检查项时读取 `AGENTS.local.md`、当前 Agent 的入口文件、Skills 目录、Git 本地排除文件或已登记仓库的 Git 元数据。

初始禁止：iteration/task 正文、项目事实、业务代码、环境变量值和其他 Agent 的文件。

输出：按稳定检查 ID 列出的 error、warn、通过项和最小修复建议。

## 流程

1. 运行 `node tools/workflow.js doctor --json`。完成：获得完整检查数组或可定位的命令错误。
2. 确认结果只覆盖 Node.js 版本、CLI 与根入口、从 `.agents/skills/*/SKILL.md` 动态发现的 Skills、setup 受管配置、仓库 canonical Git 根目录、当前 Agent 入口、Skills 链接和本地排除规则。完成：没有把任务、Markdown 质量、项目事实或 ADR 一致性误报为接入问题。
3. 只展开 error、warn 及对应 hint；error 使 doctor 退出码为 1，只有 warn 时退出码仍为 0。完成：用户能根据检查 ID 定位最小修复动作。
4. 保持只读。需要修复时调用 `sw-setup`，由 setup 根据当前期望配置同步；doctor 不提供修复模式，也不直接修改文件。完成：本次诊断没有产生写入。

setup 未完成时，只继续 setup、doctor 和必要的只读探测。
