---
name: sw-implement
description: 按已确认 spec.md 和当前 Slice 在一个或多个目标 Git 仓库中实施代码、测试、配置和项目文档变更。任务处于 implementation 或执行已确认需求变化时使用。
---

# 实施任务

## 上下文契约

必读：`task.json`、`spec.md`、`task status <task> --json` 输出，以及当前未完成的 `slices/*.md`（若存在）。一次只读取当前 Slice。

按需读取：当前步骤涉及的仓库说明、目标文件和相关测试；`spec.md` 或当前 Slice 明确引用的 PRD、技术方案章节、DDL artifact、规范和项目记忆。

初始禁止：其他任务、完整上游文档、后续 Slice、无关仓库和未被实施单元引用的研究材料。

输出：符合当前实施单元的代码、测试、配置和项目文档变更，以及进入 verification 所需的稳定 diff。

## 开始前

1. 运行 `task status <task> --json`，核对 phase、仓库 ID、branch、baseline HEAD 和初始脏文件。CLI 已把任务绑定到进入 implementation 时的 exact root；Agent 不写回本机路径。
2. 检查既有修改、依赖、配置和环境权限。重叠修改交由用户决定；不重叠修改明确排除。不得 stash、reset、checkout、建分支或扩大权限。

完成：phase、仓库 binding、实施基线、任务自有范围和可用环境均已明确，重叠修改已由用户决定。

## 实施

1. 按 `spec.md` 的仓库顺序执行唯一当前步骤；存在 Slice 时只读取和执行第一个未完成 Slice，达到停止条件后在 `spec.md` 现有索引中标记进度，再自动读取下一个，不创建额外状态文件，也不请求逐 Slice 确认。
2. 使用目标仓库已有模式和依赖。采用 TDD 时按行为完成有效 red、最小 green，再进入下一个行为；预期来自规格或独立样例，只在系统边界使用 mock。公共契约、Schema、持久化结构或多运行时边界发生变化时，在当前 Slice 内立即运行 spec 安排的最小正向消费和负向兼容检查。其他验证方式按当前实施单元执行。
3. 高保真 UI Slice 调用 `ui-recreate` 实现模式；普通前端工作不调用。视觉证据不能替代可稳定隔离的状态、校验和数据转换测试。
4. 只产出 DDL、部署、生产写入或不可逆操作的脚本与静态验证方案，不执行这些动作。
5. 发现需求、方案、术语、ADR 或规范与事实冲突时停止相关代码，列出受影响文档并一次同步确认；必须由用户决定时调用 `grilling`，达到长期记忆门槛时调用 `sw-domain-modeling`。

每个实施单元完成：达到当前步骤或 Slice 的停止条件，直接相关行为和检查通过，文档保持当前事实，且没有越过安全边界或读取后续 Slice。

## 收尾

实施中反复运行当前行为的直接相关测试；每个步骤或 Slice 完成时只运行该增量必要的测试及适用类型、lint 或构建检查。implementation 不执行最终全量验证矩阵和完整 code review；这些统一由 `sw-verify` 在最终 diff 上完成。

全部实施单元完成后，检查 diff 与 `spec.md` 一致、任务文档和项目事实未失真、计划提交的工作流文件不含本机绝对路径或命令包装。实施方案的确认已授权内部验证衔接；直接运行 `task phase <task> verification --confirmed` 并调用 `sw-verify`，只向用户报告实施结果和已运行的局部检查，不再请求重复确认。

完成：全部实施单元和局部检查已闭合，diff 与 `spec.md` 一致，并已自动进入 `verification`；只有上游事实变化或用户授权范围被突破时才停止确认。

实施阶段不提交；跨仓提交计划留到验证完成后一次确认。业务自测发现相关缺陷时直接调用 `sw-fix-bug`。
