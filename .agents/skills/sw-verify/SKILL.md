---
name: sw-verify
description: 对工作流任务执行最终验收验证，整合 code-review、自动化检查、联调、DDL、UI、项目文档和多仓库提交证据并维护 verification.md。仅用于 phase=verification 的工作流任务。
---

# 验证工作流任务

## 上下文契约

必读：`task.json`、`prd.md` 验收标准、`spec.md` 验收映射、现有 `verification.md`、各仓库最终 diff。

按需读取：`AGENTS.md` 规范路由命中的文档；`technical-design.md` 的数据库、契约、权限和回滚章节；测试输出；截图或日志路径；更新过的项目文档。

初始禁止：其他任务、全部项目知识、与验收无关的源码。

输出：当前 `verification.md`、阻塞项、残余风险和待用户业务自测提示。

## 流程

1. 运行 `task status <task> --json`，确认任务处于 `verification`、全部 Slice 已完成且 delivery 未漂移；调用 `sw-code-review`。完成：P0 已解决或证明误报，P1 已解决或由用户明确接受并记录。
2. 逐条执行 `spec.md` 的 AC 验收映射，不以“测试通过”替代业务证据；按适用范围检查测试、类型、lint、构建、联调、契约、兼容、DDL 静态方案、UI 状态、安全、可观测性、配置和 `project/` 事实。完成：每个 AC 有真实证据或明确的 failed/unverified/waived 状态，全部适用影响已检查。
3. 更新 `verification.md`，记录每个仓库最终 branch、HEAD、实施范围和未提交文件；证据只保存命令、摘要或路径。运行 `task validate <task>`。完成：文档覆盖全部 AC，校验通过，自动验证之外的行为只列为“待业务自测”。
4. 到此停止并等待用户业务验收，不提交、不进入 `done`。完成：已明确提示用户自测和回复“完成任务”。

## verification.md

保留 CLI 生成的全部章节。每个 PRD AC 使用独立三级标题：

```markdown
### AC-001 <验收项>

状态：pass | human-confirmed | waived | failed | unverified

证据：<命令、结果摘要或文件路径>
```

`pass` / `human-confirmed` 必须写证据；`waived` 改写为 `理由：...` 并记录用户决定。不要把 failed 或 unverified 伪装成通过。

可执行验证完成后使用以下提示：

> 实现及可执行验证已完成，任务当前等待业务验收。请完成业务自测；确认通过后回复“完成任务”，我再将任务标记为 done。

用户明确“完成任务”后，先汇总代码仓库 commit 和工作流文档的一次性提交计划并取得一次授权。按依赖顺序提交各代码仓库，不得 push；随后运行：

```text
task phase <task> done --commit <repo-a=sha> --commit <repo-b=sha> --expected-revision <n> --confirmed
```

同仓多 commit 时按祖先顺序重复 `--commit repo=sha`。让 CLI 校验 commit 是基线严格后代、最后一个等于 HEAD、验证 tree 未漂移，再提交任务 done 记录。
