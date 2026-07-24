---
name: sw-spec
description: 将已确认 PRD 和技术方案转换为唯一可执行实施方案 spec.md，建立验收映射、仓库顺序、修改点、测试和可选 slices。任务进入 implementation_spec 或实施范围变化时使用。
---

# 编写实施 Spec

## 上下文契约

必读：`task.json`、`prd.md`、`decisions.md`、已确认的 `technical-design.md`。

按需读取：`AGENTS.md` 规范路由命中的文档、技术方案引用的 DDL、研究证据、目标代码符号和仓库运行说明。

初始禁止：其他任务、未引用的项目知识、无关源码、重复复制完整技术方案。

输出：唯一的 `spec.md`，以及必要时更新的 `task.json.slices`。

## 流程

1. 运行 `task status <task> --json`，确认任务处于 `implementation_spec`，PRD 和技术方案 checkpoint 有效。完成：revision、仓库范围和全部 AC 已知。
2. 将设计转换成唯一的 `spec.md`；引用设计章节和相关 ADR，不复制长篇内容。每个步骤写明仓库、修改点、依赖、验证、对应 AC 和停止条件；在“项目文档同步”用 inline code 列出本任务实际依赖、需要更新或复核的 `CONTEXT.md`、具体 ADR 和 `project/*.md` 路径。发现新的需求或技术取舍时停止编写，对必须由用户决定的事项调用 `grilling`，在当前请求中明确写出访谈主题、已知事实、待决范围和恢复编写所需的完成标准，更新并重新确认受影响的上游文档后再继续。完成：全部 AC 映射到可执行步骤和验证证据，长期记忆依赖及同步动作有明确落点。
3. 仅在一次上下文无法完成或存在可独立验证的顺序增量时定义 Slices。完成：Slice DAG 可执行，或明确无需 Slices。
4. 运行 `task validate <task>`。完成：校验通过、无阻塞项，测试策略和规则例外已随方案交由用户确认；确认后以最新 revision 进入 `implementation` 并调用 `sw-implement`。

进入 implementation 时让 CLI 自动记录每个仓库的 canonical root、branch、HEAD 和初始脏文件，不手工写 `task.json.delivery`。不在其他文档重复维护任务列表。规则或例外只在实质影响的步骤就地记录。

## Slices

仅当整个任务无法在一次上下文完成，或存在可独立验证、按顺序交付的增量时拆分。跨仓库本身不是拆分理由。

Slice ID 使用 `01-<slug>`，状态只放在 `task.json.slices`：`pending`、`in_progress`、`done`。所有 slice 完成前，任务仍处于 `implementation`。

将 Slice 数组写入一个临时 JSON 文件，通过 `task slices <task> --config <file> --expected-revision <n>` 一次性校验和保存。每项包含 `id`、`title`、`status: "pending"`、`blocked_by`；不要直接修改状态字段。

## 文档规则

填写 CLI 生成的全部章节。测试策略中，可稳定隔离的新逻辑和 Bug 优先 TDD；UI、遗留代码或缺少测试接缝时写明替代验证。本可测试却不写测试的新逻辑必须让用户确认。

阶段命令：`task phase <task> implementation --expected-revision <n> --confirmed`。实施中发现方案不成立时，先更新受影响的 PRD、技术方案、决策和 spec，再继续编码。
