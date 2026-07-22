---
name: spec-driven-doctor
description: 只读诊断工作流安装、Agent 入口、Skills 映射、本地配置、目标 Git 仓库和 Node 版本。setup 完成后、配置或版本变化后、工作流无法触发时使用。
---

# 诊断工作流

## 上下文契约

必读：`AGENTS.md`、`WORKFLOW_VERSION`、`tools/agent-adapters.json`、`AGENTS.local.md`（若存在）。

按需读取：`project/index.md`、已登记仓库文档及其 Git 元数据、当前 Agent 的适配文件。

初始禁止：任务正文、业务代码、环境变量值、其他 Agent 的生成文件。

输出：按严重程度列出的通过项、警告、阻塞项和最小修复建议。

## 流程

1. 运行 `node tools/workflow.js doctor`。模板开发阶段可用 `doctor --template`。
2. 检查 Node.js、核心文件、11 个 Skill、`AGENTS.local.md` 格式、密钥泄漏、项目文档及目标仓库 Git 状态。
3. 检查所选 Agent 是否能读取入口和 Skills：原生接入检查路径，适配接入检查导入内容及链接/副本。
4. 不修改任何文件。用户要求修复后，先展示修复目标；适配器修复使用 `adapter install --agent <id>` 预览，再经确认添加 `--apply`。
5. 区分：
   - 阻塞：无法加载入口或 Skill、配置损坏、目标路径不是 Git 仓库、发现疑似密钥值；
   - 警告：可选信息未知、适配器副本可能过期、版本小幅不一致；
   - 通过：不要展开无关细节。

setup 未完成时，只允许继续 setup、doctor 和其他只读检查。
