---
name: sw-verify
description: 对工作流任务执行最终验收验证，整合 code-review、自动化检查、联调、DDL、UI、项目文档和多仓库提交证据并维护 verification.md。仅用于 phase=verification 的工作流任务。
---

# 验证工作流任务

## 上下文契约

必读：`task.json`、`prd.md` 验收标准、`spec.md` 验收映射和各仓库最终 diff。

按需读取：已有 `verification.md`；`AGENTS.md` 规范路由命中的文档；`technical-design.md` 的数据库、契约、权限和回滚章节；测试输出；截图或日志路径；更新过的项目文档。

初始禁止：其他任务、全部项目知识、与验收无关的源码。

输出：当前 `verification.md`、阻塞项、残余风险和待用户业务自测提示。

## 流程

1. 运行 `task status <task> --json`，确认任务处于 `verification`，并以 task 的 baseline Git 快照为明确范围调用 `code-review`：审查各仓库 `baseline HEAD -> HEAD/worktree` 中属于本任务的最终变更，排除初始脏文件及已确认的无关修改；任务文档和适用约束作为审查依据。本流程处理门禁，并在修复后按同一范围复审。完成：P0 已解决或证明误报，P1 已解决或由用户明确接受并记录，复审无阻塞。
2. 逐条执行 `spec.md` 的 AC 验收映射，不以“测试通过”替代业务证据；复用代码审查结论作为静态证据，并按适用范围执行测试、类型、lint、构建、联调、契约、兼容、DDL 静态方案、UI、安全配置、可观测性和配置检查，核对 `project/` 事实、`CONTEXT.md` 和相关 ADR 是否仍与最终实现一致。完成：每个 AC 有真实证据或明确的 failed/unverified/waived 状态，全部适用影响和长期记忆已检查。
3. 创建或更新 `verification.md`，记录每个仓库最终 branch、HEAD、实施范围和未提交文件；“项目文档同步”用 inline code 列出实际更新、复核后无需更新或尚未解决的 `CONTEXT.md`、具体 ADR、`project/index.md` 和仓库事实路径，证据只保存命令、摘要或路径。自行检查文档覆盖全部 AC，项目记忆仍与实现一致且没有未处置冲突；自动验证之外的行为只列为“待业务自测”。
4. 到此停止并等待用户业务验收，不提交、不进入 `done`。完成：已明确提示用户自测和回复“完成任务”。

## verification.md

每个 PRD AC 使用独立三级标题：

```markdown
### AC-001 <验收项>

状态：pass | human-confirmed | waived | failed | unverified

证据：<命令、结果摘要或文件路径>
```

`pass` / `human-confirmed` 必须写证据；`waived` 改写为 `理由：...` 并记录用户决定。不要把 failed 或 unverified 伪装成通过。

可执行验证完成后使用以下提示：

> 实现及可执行验证已完成，任务当前等待业务验收。请完成业务自测；若发现与本任务相关的缺陷，直接说明现象或调用 `sw-fix-bug` 排查修复，无需新建任务；确认通过后回复“完成任务”，我再将任务标记为 done。

用户明确“完成任务”后，先汇总一次提交计划并取得一次授权；计划包含按依赖顺序提交各目标仓库、推进任务状态和提交工作流文档，不得 push。提交目标仓库后运行：

```text
task phase <task> done --confirmed
```

CLI 自动记录各仓库最终 HEAD、HEAD tree 和剩余脏文件；随后提交本任务的工作流文档和 done 状态，提交范围不得超出已确认计划。这些快照用于后续发布方案汇总，不替代本 Skill 对提交范围和验证证据的判断。

标记完成后运行 `iteration status <iteration> --json`。仍有非终态任务时报告剩余项；全部任务均为 done/cancelled 时调用 `sw-release-plan` 生成发布方案。最后提示：`任务已完成。若随后发现本次交付遗留缺陷，直接说明现象或调用 sw-fix-bug；它会先确认是否仍关联本任务。`
