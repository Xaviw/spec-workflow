---
name: sw-release-plan
description: 为可收口或已收口迭代预览、创建、更新或评审可选发布方案。面向外部发布评审，不执行发布，也不自行改变 task 或 iteration 状态。
---

# 生成迭代发布变更方案

## 上下文契约

必读：`node tools/workflow.js iteration status <iteration> --check --json` 的结果、[发布方案模板](references/release-plan-template.md)和[发布方案写作参考](references/release-plan-guide.md)。

按需读取：已有 `release-plan.md`；当前章节缺少结论时，再读取 done 任务的 `task.json.git.final`、`verification.md`、可选 `technical-design.md`、`spec.md`、DDL artifact 和相关仓库说明。最终 Git 状态优先使用 `task.json.git.final`，不从验证时快照推断。

初始禁止：其他迭代、未完成任务正文、全部项目知识、目标仓库全量历史、生产凭据和正式环境写操作。

输出：可收口迭代中不落盘的完整方案预览，或已收口迭代中的 `release-plan.md`。本 Skill 不自行修改 task 或 iteration 状态，不追踪外部实际发布。

## 文档定位

- 发布方案说明本次发布改变什么、按什么依赖关系交付、如何判断成功以及失败后如何恢复；它是外部评审材料，不是工作流门禁或运维操作手册。
- 只写当前迭代和按需证据支持的事实。正式环境时间、负责人、资源实例和平台工单未知时可以留空。
- 任何文档确认都不授权部署、push、DDL 或环境写入；测试和预发布证据也不代表外部实际发布完成。
- 可提交内容不记录本机绝对路径、命令包装、版本管理器、浏览器或其他可执行文件位置。

## 流程

1. 采用用户明确指定或调用方唯一传入的迭代，运行 `iteration status <iteration> --check --json`。只读预览模式允许 iteration 为 `open`，但全部任务必须为 done/cancelled；该模式不代为收口，也不写文件。直接创建、更新或提交时 iteration 必须已 `closed`。汇总 done 任务、`simple_changes` 和 final Git 快照，排除 cancelled 任务。完成：发布范围只包含可追溯的已完成工作，当前模式与 iteration 状态一致。
2. 读取模板、写作参考和已有方案，按业务能力和真实依赖组织发布概况、风险、变更、编排与验证、回滚及外部补充，不按任务顺序机械拼接。删除没有事实支撑的章节，不保留“不适用”或占位语。预览模式只在回复中形成不含首行来源标记的完整正文，不创建或修改 `release-plan.md`；落盘时在用户已审阅的正文前补入 `<!-- spec-workflow:release-plan ended_at=<iteration.json.ended_at> -->`，正文不得再改写。完成：方案结构由实际变更决定，预览无工作区副作用，落盘内容与已审阅正文一致。
3. 缺少结论时只读取对应任务证据。任务间冲突能由已确认事实解决时统一，否则保留冲突并请用户决定；不扩大到生产环境取证。完成：正确性、协作验证、风险恢复三轮评审均已执行，结论可追溯，冲突已解决或明确待决。
4. 预览模式返回完整正文、未解决阻塞和建议 commit message，不写文件。直接调用创建或更新时，先展示完整正文、拟提交文件和 message，取得确认后落盘。调用方已经展示预览并取得包含该正文的收口授权时，收口后只补入实际 `ended_at` 标记并落盘，不重复询问。落盘后运行 `iteration status <iteration> --check --json`，确认 `release_plan.status` 为 `fresh`；调用方模式将方案与 `iteration.json` 纳入已展示的同一次提交。完成：用户提交前已看到实际正文，或只读评审未产生写入；落盘方案通过新鲜度检查。

发布方案不存在、未确认或生成失败都不改变已完成 task 和已收口 iteration。正式发布仍由外部流程执行。
