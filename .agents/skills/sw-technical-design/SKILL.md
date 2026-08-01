---
name: sw-technical-design
description: 为确实需要外部技术评审的工作流任务编写或评审精简技术方案，或将一个迭代内已有任务方案去重汇总。任务处于 technical_design，或用户要求编写、评审、汇总技术方案时使用。
---

# 编写技术方案

## 上下文契约

单任务必读：`task.json`、已确认的 `prd.md`、`decisions.md`、[单任务技术方案模板](references/task-technical-design-template.md)、[技术方案写作参考](references/technical-design-guide.md)和涉及仓库的说明文档。

迭代汇总必读：`iteration.json`、迭代内未取消任务的 `task.json`、已有任务 `technical-design.md`、[迭代技术方案模板](references/technical-design-template.md)和写作参考。

按需读取：实际命中的工程规范，以及为确认接口、数据、关键链路、安全边界、架构或风险所需的少量源码、配置和项目知识。每次扩展上下文都必须服务于一个明确的外部评审问题。

初始禁止：逐文件实施调查、完整源码扫描、测试命令验证、TDD 步骤、无关任务和全部项目知识。

输出：单任务更新任务目录的 `technical-design.md`；迭代汇总更新 `iterations/<iteration-id>/technical-design.md`。两者都是可脱离实施过程阅读的精简外部评审材料，不是实施核心依据。

## 内容边界

只写本次实际命中的接口和字段契约、数据库及历史数据方案、前后端或跨服务关键链路、安全与权限、架构和兼容取舍、容量与发布风险、关键技术难点及方案选择。

不写源码文件或函数清单、逐步修改方案、TDD 步骤、测试命令、停止条件、完整 AC 映射、Slice 状态或内部取证过程。可以引用真正影响评审结论的 AC、ADR 或项目事实，但引用不能成为理解方案的前置条件。

本 Skill 只设计和静态审查 DDL，不执行 DDL、生产写入或其他不可逆操作，也不记录凭据值。

## 单任务流程

1. 运行 `task status <task> --json`，确认 phase 为 `technical_design`，读取已确认 PRD、决定、仓库范围和全部 AC。
2. 识别需要外部评审的接口、数据、关键链路、安全、架构、兼容和风险问题；只调查形成这些结论所需的当前事实。
3. 按模板写入精简结论。没有实际评审内容的章节删除，不用“不适用”或占位语填充。
4. 检查字段、状态、权限、异常和跨端约定是否一致。必须由用户决定且阻塞方案的取舍调用 `grilling`；新术语或达到 ADR 门槛的决定调用 `sw-domain-modeling`。
5. 展示评审结论和未决风险。确认问题写明“确认 `technical-design.md` 的关键技术结论并进入 `implementation_spec`”；用户明确确认后运行 `task phase <task> implementation_spec --confirmed` 并调用 `sw-spec`。

## 迭代汇总

只汇总已有任务技术方案，不从缺少方案的任务补造设计。按接口、数据、关键链路、安全、架构和风险去重组织；冲突无法由已确认事实解决时调用 `grilling`。汇总不修改任务阶段或单任务方案。

## 写法

- 优先使用短段落、列表和表格；只有复杂关系或时序才使用 Mermaid。
- 同一字段、状态或规则只定义一次。
- 实施以已确认的 `spec.md` 和当前 Slice 为准；技术方案只提供已评审约束。
