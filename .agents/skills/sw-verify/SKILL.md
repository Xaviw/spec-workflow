---
name: sw-verify
description: 对 phase=verification 的工作流任务执行一次最终代码审查、全量门禁和 AC 验收，维护 verification.md 并完成任务交付。
---

# 验证工作流任务

## 上下文契约

必读：`task.json`、`prd.md` 验收标准、`spec.md` 验收映射、相关 `slices/*.md` 和各仓库最终 diff。

按需读取：已有 `verification.md`；命中的规范；`technical-design.md` 中实际适用的接口、数据库、安全、架构和风险结论；测试输出、截图、日志及更新过的项目文档。

初始禁止：其他任务、全部项目知识和与验收无关的源码。

输出：当前 `verification.md`、阻塞项、残余风险，以及一次完成确认或确有必要的业务自测项。

## 流程

1. 运行 `task status <task> --json`，确认任务处于 `verification`，核对 baseline、初始脏文件和最终 diff 范围。逐条检查 PRD AC 与 `spec.md` 的唯一实施落点、主要证据和实际 diff 一致。完成：审查范围固定，全部 AC 都能追到实施落点、证据计划和实际变更。
2. 以 baseline `HEAD -> HEAD/worktree` 中属于本任务的最终变更为范围调用一次完整 `code-review`，排除初始脏文件和已确认的无关修改。处理发现后只运行直接相关测试，并对改动部分复审；不机械重复历史全量命令。审查结论记录实际范围和专项参考，使用“未发现需报告的问题”或“无阻塞发现”等与报告策略一致的表述；只有明确完整覆盖全部级别时才逐级声明 P0/P1/P2/P3。完成：最终 diff 无未处置的阻塞发现，复审覆盖所有因处置产生的修改。
3. diff 稳定后，按 `spec.md` 规定的原生命令执行一次最终全量验证矩阵，并逐条形成 AC 证据。测试通过不能替代业务证据；认证、授权、租户、身份和数据隔离 AC 必须有动态负向证据。UI AC 使用 `ui-recreate` 只读验证模式；没有可复现基准时标为 `unverified`。完成：每个 AC 都有符合状态要求的证据或明确的人工判断、豁免、失败或未验证原因。
4. 创建或更新 `verification.md`。每个仓库只记录“验证时快照”：branch、baseline HEAD、验证时 HEAD/worktree 和本次审查范围，并明确这不是交付后的 final Git 状态。最终 HEAD、tree 和剩余脏文件只由进入 done 时写入 `task.json.git.final`；目标仓库提交后不为同步 HEAD 二次修改本文。完成：验证记录覆盖全部仓库和 AC，且没有把验证快照写成最终交付状态。
5. 核对 `project/`、`CONTEXT.md` 和相关 ADR 与最终实现一致，文档覆盖全部 AC，且没有旧规则、已解决 Q ID、被替代 ADR、旧验证命令、本机绝对路径或命令包装继续作为当前事实。自动验证之外只列真正需要用户判断的项目。完成：项目事实、长期记忆、任务文档和最终实现一致，待人工判断项已经最小化。
6. 到此停止，不提交、不进入 done。若证据完整，展示精简摘要并提出唯一确认问题：“确认 `verification.md` 的验收结论并完成任务，进入 `done`”；若有人工判断项，只列对应 AC、操作和通过标准后提出同一目标明确的问题。完成：已提出唯一且可判定的完成确认问题，并在获得明确确认前保持 `verification`。

## 验收记录

每个 PRD AC 使用独立三级标题并记录状态与证据：

```markdown
### AC-001 <验收项>

状态：pass | human-confirmed | waived | failed | unverified

证据：<原生命令、结果摘要或仓库根相对路径>
```

`pass` / `human-confirmed` 必须附证据；`waived` 写理由和用户决定。视觉 AC 只有在同一设计基准、视口和状态下有可复现证据时才可 `pass`。

## 完成与迭代收口

用户明确完成任务后，先汇总一次提交计划并取得一次授权；计划包含依赖顺序、各目标仓库提交、`task phase <task> done --confirmed`、工作流文档提交和每个完整 message，不得 push。CLI 自动把最终 HEAD、tree 和剩余脏文件写入 `task.json.git.final`，发布汇总优先读取该状态，不要求 `verification.md` 重复最终提交信息。

任务进入 done 并完成已授权提交后运行 `iteration status <iteration> --json`：

- 仍有非终态任务：只报告剩余项，不提示发布方案。
- 全部任务为 done/cancelled：询问用户选择“A. 收口迭代并生成发布方案”或“B. 跳过发布方案并收口迭代”，明确该选择同时确认运行 `iteration close <iteration> --confirmed` 和提交迭代状态。

两种选择都先收口并提交迭代状态。选择 A 时随后调用 `sw-release-plan` 生成可选外部评审材料；发布方案失败或被跳过不回退 iteration。工作流不追踪外部实际发布状态。
