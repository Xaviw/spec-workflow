---
name: spec-driven-verify
description: 对工作流任务执行最终验收验证，整合 code-review、自动化检查、联调、DDL、UI、项目文档和多仓库提交证据并维护 verification.md。仅用于 phase=verification 的工作流任务。
---

# 验证工作流任务

## 上下文契约

必读：`task.json`、`prd.md` 验收标准、`spec.md` 验收映射、现有 `verification.md`、各仓库最终 diff。

按需读取：`technical-design.md` 的数据库、契约、权限和回滚章节；测试输出；截图或日志路径；更新过的项目文档。

初始禁止：其他任务、全部项目知识、与验收无关的源码。

输出：当前 `verification.md`、阻塞项、残余风险和待用户业务自测提示。

## 流程

1. 调用 `spec-driven-code-review`。P0 必须解决、证明误报或由用户明确排除；P1 必须解决或由用户明确接受并记录。
2. 逐条执行 `spec.md` 中验收标准到验证的映射，不以“测试通过”替代缺失的业务验收证据。
3. 按影响范围执行：
   - 各仓库测试、类型检查、lint、构建；
   - 前后端或小程序联调；
   - API、事件和兼容性检查；
   - DDL 静态审查、迁移顺序、回滚及验证 SQL，不执行 DDL；
   - UI 的主要状态、错误态、加载态和目标尺寸；
   - 权限、安全、日志、指标和配置检查；
   - `project/` 长期事实是否已同步。
4. 记录每个仓库最终 branch、HEAD、实施范围和仍未提交的文件。证据保存路径或摘要，不把大段日志和二进制塞入文档。
5. 自动验证无法覆盖的业务行为列为“待业务自测”，不要伪造通过。

## verification.md

至少包含：验收项与证据、仓库检查、集成验证、数据库验证、UI 证据、项目文档同步、提交范围、未验证项和残余风险。每个 PRD AC 使用独立三级标题：

```markdown
### AC-001 <验收项>

状态：pass | human-confirmed | waived | failed | unverified

证据：<命令、结果摘要或文件路径>
```

`pass` / `human-confirmed` 必须写证据；`waived` 改写为 `理由：...` 并记录用户决定。不要把 failed 或 unverified 伪装成通过。

可执行验证完成后，不自动进入 `done`。使用以下提示：

> 实现及可执行验证已完成，任务当前等待业务验收。请完成业务自测；确认通过后回复“完成任务”，我再将任务标记为 done。

用户明确“完成任务”后，先汇总代码仓库 commit 和工作流文档的一次性提交计划并取得一次授权。按依赖顺序提交各代码仓库，不得 push；随后运行：

```text
task phase <task> done --commit <repo-a=sha> --commit <repo-b=sha> --expected-revision <n> --confirmed
```

同仓多 commit 时按祖先顺序重复 `--commit repo=sha`。让 CLI 校验 commit 是基线严格后代、最后一个等于 HEAD、验证 tree 未漂移，再提交任务 done 记录。
