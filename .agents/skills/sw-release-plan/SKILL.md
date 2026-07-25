---
name: sw-release-plan
description: 汇总一个迭代中已完成任务和 simple changes，创建、评审发布方案，并在用户确认实际发布完成后收口迭代。迭代准备发布、需要版本变更清单、生产变更交接、发布方案评审或发布后收口时使用；不用于执行部署、DDL 或具体运维操作。
---

# 生成迭代发布变更方案

## 上下文契约

必读：`node tools/workflow.js iteration status <iteration> --json` 的结果、已有 `release-plan.md`（若存在）、`references/release-plan-template.md` 和 `references/release-plan-guide.md`。

按需读取：done 任务的 `verification.md`、`technical-design.md`、`spec.md`、Git 快照、DDL artifact 和相关仓库说明。只有当前章节缺少发布结论时才扩展，并优先读取验证记录。

初始禁止：其他迭代、未完成任务正文、全部项目知识、目标仓库全量历史、生产凭据和正式环境写操作。

输出：当前 `release-plan.md`；用户确认实际发布完成时，由 CLI 将 iteration 标记为 closed。

## 文档定位

- 发布方案说明本次发布改变什么、按什么依赖关系交付、如何判断成功以及失败后如何恢复。它不是运维操作手册。
- 只写当前迭代状态和按需证据能够支持的事实。正式环境时间、负责人、资源实例和平台工单缺失但不影响范围成立时可以留空。
- 空白不等于“无变更”。只有证据明确证明没有该类变化时才写“无”；影响范围、顺序、安全、验证或回滚的未知项必须显式列为阻塞。
- 方案评审和实际发布是两件事；任何文档确认都不授权部署、push、DDL 或环境写入。

## 流程

1. 要求用户明确指定迭代，运行 `iteration status <iteration> --json`。汇总 done 任务和 `simple_changes`，排除 cancelled 任务，并单独列出仍未完成的任务。完成：发布来源、Git 快照和阻塞状态已知。
2. 已有方案时在其上更新；不存在时按模板创建 `release-plan.md`。按业务能力和真实依赖组织发布概况、风险与依赖、变更内容、发布编排与验证、回滚以及外部补充，不按任务顺序机械拼接。完成：每项结论都能追溯到迭代状态或按需证据。
3. 缺少结论时只读取对应任务的验证或设计材料。任务间冲突能由已确认事实解决时统一，否则保留冲突并请用户决定；不为补齐文档扩大到生产环境取证。完成：没有猜测、占位文本或隐含阻塞。
4. 按 [发布变更方案写作参考](references/release-plan-guide.md) 完成正确性、协作验证、风险恢复三轮评审，并让用户确认当前方案。确认结果只存在于对话和文档，不写 fingerprint、hash、receipt 或额外状态。完成：方案具备交接条件，未完成任务仍明确阻止收口。
5. 只有用户明确说明实际发布已经完成，且 `iteration status` 显示全部任务为 done/cancelled 时，运行 `iteration close <iteration> --confirmed`。CLI 只检查终态任务和 `release-plan.md` 存在。完成：iteration 状态为 closed。

每次调用只执行用户当前要求的生成、评审或收口分支。正式发布仍由外部发布流程执行。
