---
name: spec-driven-spec
description: 将已确认 PRD 和技术方案转换为唯一可执行实施方案 spec.md，建立验收映射、仓库顺序、修改点、测试和可选 slices。任务进入 implementation_spec 或实施范围变化时使用。
---

# 编写实施 Spec

## 上下文契约

必读：`task.json`、`prd.md`、`decisions.md`、已确认的 `technical-design.md`。

按需读取：技术方案引用的 DDL、研究证据、目标代码符号和仓库运行说明。

初始禁止：其他任务、未引用的项目知识、无关源码、重复复制完整技术方案。

输出：唯一的 `spec.md`，以及必要时更新的 `task.json.slices`。

## 原则

- `spec.md` 是执行计划，不是第二份技术方案；引用设计章节，不复制长篇内容。
- 每个步骤必须能回答：在哪个仓库、改什么、依赖谁、怎样验证、对应哪个验收标准。
- 在 spec 中声明预期仓库顺序和停止条件。进入 implementation 时让 CLI 自动记录每个仓库的 canonical root、branch、HEAD 和初始脏文件，不手工写 `task.json.delivery`。
- 不在不同文档中维护重复任务列表。

## Slices

仅当整个任务无法在一次上下文完成，或存在可独立验证、按顺序交付的增量时拆分。跨仓库本身不是拆分理由。

Slice ID 使用 `01-<slug>`，状态只放在 `task.json.slices`：`pending`、`in_progress`、`done`。所有 slice 完成前，任务仍处于 `implementation`。

将 Slice 数组写入一个临时 JSON 文件，通过 `task slices <task> --config <file> --expected-revision <n>` 一次性校验和保存。每项包含 `id`、`title`、`status: "pending"`、`blocked_by`；不要直接修改状态字段。

## 文档结构

```markdown
# 实施方案
## 本轮实施基线
## 实施顺序与依赖
## 按仓库的修改计划
## 数据库与配置动作
## 验收标准到验证的映射
## 测试与联调
## 项目文档同步
## Slices（如需要）
## 风险和停止条件
```

测试策略需明确：可稳定隔离的新逻辑和 Bug 优先 TDD；UI、遗留代码或缺少测试接缝时写明替代验证。对本可测试却不写测试的新逻辑，必须让用户确认。

确保验收映射覆盖全部 AC，运行 `task validate <task>`。用户确认实施方案后，使用当前 revision 运行 `task phase <task> implementation --expected-revision <n> --confirmed`；该命令捕获多仓基线。实施中发现方案不成立时，先更新受影响的 PRD、技术方案、决策和 spec，再继续编码。
