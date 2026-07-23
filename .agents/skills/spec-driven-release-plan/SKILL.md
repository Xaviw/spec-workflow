---
name: spec-driven-release-plan
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

1. 运行 `node tools/workflow.js iteration release-plan <iteration-id>` 预览聚合结果，用户同意创建草稿后添加 `--apply`。
2. 补齐 `release-plan.md`：目标版本或发布批次、各仓库 commit 和版本、部署顺序、DDL/数据、配置和环境、公共契约、联调、发布前后检查、回滚、未匹配 Git 变更和阻塞项。文件已存在时 CLI 保留内容，按预览手动同步。
3. 来源指纹覆盖迭代目标、任务 schema/revision、全部阶段产物 hash、checkpoint/approval、Slice、delivery tree/commit 和 change items。任一来源变化都使已确认方案失效并回到 draft。
4. 用户明确确认完整方案后，运行 `iteration confirm-release-plan <iteration-id> --confirmed`。占位内容会阻止确认；确认同时记录方案文件哈希。
5. 提交方案与 `iteration.json`。
6. 实际发布完成后，只有用户明确确认才运行 `iteration done <iteration-id> --confirmed`。CLI 会再次校验来源指纹、方案 hash、确认 revision、commit 和 confirmation receipt；该动作只更新文档状态，不执行 push、部署或 DDL。done/cancelled 迭代不可再次修改。

发布方案必须写出无法验证和无法回滚的部分。不要把“生成发布方案”解释为授权执行发布。
