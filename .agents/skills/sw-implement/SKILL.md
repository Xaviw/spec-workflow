---
name: sw-implement
description: 按已确认 spec.md 在一个或多个目标 Git 仓库中实施代码、测试、配置和项目文档变更。任务处于 implementation、处理 slice、修复相关 Bug 或执行已确认需求变更时使用。
---

# 实施任务

## 上下文契约

必读：`task.json`、`spec.md`、当前 slice（若有）、涉及仓库的说明和目标文件。

按需读取：`prd.md`、`technical-design.md` 的被引用章节、相关测试、DDL artifact，以及 `AGENTS.md` 规范路由命中或 spec 就地引用的文档。

初始禁止：其他任务、全部设计文档、无关仓库、未被 spec 引用的研究材料。

输出：符合 spec 的代码和测试、及时更新的任务文档、项目事实同步、代码审查和验证入口。

## 开始前

1. 运行 `task status <task> --json`，核对 phase、revision，以及每个仓库的 canonical root、branch、baseline HEAD 和初始脏文件。完成：实施基线与已确认 spec 一致。
2. 检查既有修改、前置提交、依赖、配置和环境权限。重叠修改交由用户决定；不重叠修改经确认后排除。完成：所有前置条件满足且未 stash、reset、checkout、建分支或扩大权限。

## 实施

1. 按仓库顺序和 Slice DAG 执行；Slice 状态只通过 `task slice <task> <id> in_progress|done --expected-revision <n>` 推进。完成：当前增量对应的 blocker 已完成，且最多一个 Slice 为 `in_progress`。
2. 使用目标仓库已有模式和依赖。可隔离的新逻辑和 Bug 先写失败测试再实现；UI 验证主要状态、错误态、加载态和目标尺寸。完成：当前增量代码与最小验证均通过。
3. 只产出 DDL、部署、生产写入或不可逆操作的脚本与验证方案，不执行这些动作。完成：实施没有越过环境和数据边界。
4. 发现需求、设计、spec、专业术语、ADR 或规范与事实冲突时，停止相关代码；存在必须由用户决定的未决项时调用 `grilling`，在当前请求中明确写出访谈主题、已知事实、待决范围和恢复实施所需的完成标准，再更新受影响文档与 `decisions.md` 并重新确认。涉及专业术语或关键决策时调用 `sw-domain-modeling`，不得静默改写长期记忆。每个增量完成后立即同步 Slice、已失真任务文档，以及 `project/index.md` 或对应 `project/repositories/<repo-id>.md` 中已验证的当前事实。完成：任务文档、长期记忆与实现一致；revision 冲突已通过重读解决。

## 收尾

所有 Slice 完成后运行 `task validate <task>`，再以最新 task delivery 为明确范围调用 `code-review`：审查各仓库 `baseline_head -> HEAD/worktree` 中属于本任务的实现，排除初始脏文件及已确认的无关修改；任务文档、显式长期记忆依赖和适用约束作为审查依据。本流程处理门禁，并在修复后按同一范围复审。完成：校验通过，P0 已解决或证明误报，P1 已解决或由用户明确接受并追加到 `decisions.md`，复审无阻塞。用户确认实施结果后，以最新 revision 进入 `verification` 并调用 `sw-verify`。

阶段命令：`task phase <task> verification --expected-revision <n> --confirmed`。实施阶段不提交；跨仓提交计划留到验证完成后一次确认。
