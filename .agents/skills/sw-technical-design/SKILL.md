---
name: sw-technical-design
description: 基于已确认 PRD 和实际代码证据编写或更新技术方案，覆盖多仓库、数据库 DDL、接口、安全、配置、前后端、迁移和回滚。任务进入 technical_design 或技术事实变化时使用。
---

# 编写技术方案

## 上下文契约

必读：`task.json`、已确认的 `prd.md`、`decisions.md` 和涉及仓库的说明文档。

按需读取：`AGENTS.md` 规范路由命中的文档、目标模块源码和测试、配置说明、项目知识。每次读取都必须服务于一个明确的设计问题。

初始禁止：其他任务正文、无关仓库、完整项目知识库、实施步骤细节。

输出：`technical-design.md`，必要时产生 `artifacts/ddl/*.sql` 或 `research/*.md`。

## 流程

1. 运行 `task status <task> --json`，确认任务处于 `technical_design` 且 PRD checkpoint 有效。完成：revision、仓库范围和全部 AC 已知。
2. 围绕明确设计问题扫描实际入口、调用链、数据模型、复用点和边界，关键证据记录为 `repo_id / path / symbol / line`。完成：每个关键设计判断都有代码或文档证据。
3. 完成固定影响扫描，逐项写出设计或“不适用”理由；区分当前事实与目标事实，差异写成待实现或迁移项。完成：全部 AC 有设计落点，跨章节字段和状态一致。
4. 更新唯一的 `technical-design.md`，必要时生成 DDL 或研究 artifact。运行 `task validate <task>`；完成：校验通过且无阻塞未决问题。只有用户明确确认后，才以最新 revision 进入 `implementation_spec` 并调用 `sw-spec`。

复杂调查可暂存 `research/`；只保留方案引用的证据。可复用事实在验证后提升到 `project/knowledge/`。

## 设计约束

填写 CLI 生成的全部章节，每章给出设计或“不适用”理由；这组章节共同覆盖数据、公共契约、安全、配置、各端实现、可观测性、跨仓依赖、迁移、发布、回滚和验证。

## 数据库要求

涉及结构或数据迁移时必须提供：当前 schema 证据、目标 DDL、迁移或回填、锁与容量风险、执行顺序、回滚方式和验证 SQL。

短且单步的 DDL 放在正文；复杂或多步 DDL 写入 `artifacts/ddl/*.sql` 并由正文引用。DDL 仅作为方案产物，绝不执行。没有项目数据库规范时，不擅自发明命名或索引规则，将其列为待确认项。

规范用于约束设计，不在技术方案维护适用规则或例外清单；无法兼容时保留为阻塞项。阶段命令：`task phase <task> implementation_spec --expected-revision <n> --confirmed`。
