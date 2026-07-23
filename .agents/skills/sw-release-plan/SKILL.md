---
name: sw-release-plan
description: 汇总一个迭代中已完成任务和独立简单变更，生成、更新或确认发布变更方案与指纹。迭代准备发布、需要版本变更清单或发布后收口时使用。
---

# 生成迭代发布方案

## 上下文契约

必读：目标 `iteration.json`、该迭代所有任务的 `task.json`、`changes.jsonl`。

按需读取：已完成任务的 `verification.md`、引用 commit、DDL artifact、相关仓库说明。只有生成具体章节时读取。

初始禁止：其他迭代、未完成任务正文、全部项目知识、目标仓库全量历史。

输出：`release-plan.md`、`iteration.json.release_plan` 的 draft/confirmed 状态和来源指纹。

## 范围

- 只纳入 `done` 任务和有效的 `changes.jsonl` 项。
- `cancelled` 任务排除。
- 存在其他状态任务时允许生成 draft，但禁止确认；先完成、取消或移到其他开放迭代。
- 产品目标版本只使用 `iteration.json.target_version` 一个字符串，可为空或非 SemVer。各仓库版本只写在发布方案中。

## 流程

1. **生成或更新草稿**：运行 `iteration release-plan <iteration-id>` 预览，用户同意后添加 `--apply`；补齐目标版本或批次、各仓库 commit 和版本、部署顺序、DDL/数据、配置、契约、联调、发布前后检查、回滚、未匹配变更和阻塞项。完成：草稿覆盖全部有效来源且无占位。
2. **确认方案**：只有迭代无未完成任务且用户明确确认完整方案时，运行 `iteration confirm-release-plan <iteration-id> --confirmed` 并提交方案与 `iteration.json`。完成：来源指纹与方案 hash 已记录为 confirmed。
3. **发布后收口**：只有用户明确说明实际发布完成时，运行 `iteration done <iteration-id> --confirmed`。完成：CLI 已复核来源指纹、方案 hash、revision、commit 和 confirmation receipt；该动作只更新文档状态。

每次调用只执行用户当前要求的分支；生成方案不授权 push、部署或 DDL。done/cancelled 迭代不可修改。

发布方案必须写出无法验证和无法回滚的部分。不要把“生成发布方案”解释为授权执行发布。
