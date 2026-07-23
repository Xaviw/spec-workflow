---
name: sw-doctor
description: 只读诊断工作流安装、Agent 入口、Skills 映射、本地配置、目标 Git 仓库和 Node 版本。setup 完成后、配置或版本变化后、工作流无法触发时使用。
---

# 诊断工作流

## 上下文契约

必读：`AGENTS.md`、`tools/package.json`、`tools/agent-adapters.json`、`AGENTS.local.md`（若存在）。

按需读取：`project/index.md`、已登记仓库文档及其 Git 元数据、当前 Agent 的适配文件。

初始禁止：任务正文、业务代码、环境变量值、其他 Agent 的生成文件。

输出：按严重程度列出的通过项、警告、阻塞项和最小修复建议。

## 流程

1. 运行 `node tools/workflow.js doctor`；模板开发阶段改用 `doctor --template`。完成：获得完整检查结果或可定位的命令错误。
2. 确认结果覆盖 Node.js、核心文件、全部 Skill、本地配置与密钥、项目和仓库、Agent 接入，以及全部迭代和任务的结构、checkpoint、Slice、delivery 和发布收口状态。完成：每类检查都有结果。
3. 将无法加载、配置损坏、非 Git 仓库或疑似密钥列为阻塞；将未知可选信息、适配器副本过期或小版本不一致列为警告。完成：报告只展开阻塞、警告及最小修复建议。
4. 保持只读。用户要求修复时先展示目标；适配器先运行 `adapter install --agent <id>` 预览，确认后才添加 `--apply`。完成：本次诊断未修改文件。

setup 未完成时，只允许继续 setup、doctor 和其他只读检查。

若 schema v1 任务已经进入 implementation、verification 或 done，报告其缺失的历史交付证据，不要猜测 baseline。让用户核对每仓 baseline 后使用 `task migrate ... --reason ... --confirmed` 建立 migration receipt；旧 done 还必须核对并提供 `baseline..final` 的完整 commit 序列。
