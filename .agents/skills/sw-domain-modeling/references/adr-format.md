# ADR 格式与门槛

ADR 位于工作流仓库根目录 `adr/`。文件名使用小写 ASCII kebab-case；标题和正文使用简体中文。编号只能由 `memory adr` 在根级锁内分配。

## 创建门槛

以下三项必须同时成立：

1. **难以逆转**：以后改变会产生明显迁移、兼容、组织或交付成本。
2. **脱离背景会令人意外**：未来维护者可能把当前做法误判为遗漏或错误。
3. **存在真实取舍**：确实有合理替代方案，并因具体原因选择了其中之一。

容易回退、显而易见或没有替代方案的决定留在任务 `decisions.md`，不创建 ADR。

## CLI 配置

```json
{
  "title": "简短决定标题",
  "slug": "ascii-kebab-case",
  "scope": "project | repo-id/module[, ...]",
  "summary": "索引中的一句话决定摘要",
  "body": "一到三句话说明背景、决定和原因。",
  "source_task": "iterations/.../task-id",
  "supersedes": "ADR-0001"
}
```

`source_task` 和 `supersedes` 可省略。多数 ADR 只需这些内容；确有价值时才在 `body` 增加考虑过的方案和后果。

## 生命周期

- 新决定取得用户明确确认后由 `memory adr` 写为 `accepted`。
- 决定变化时在新配置中写 `supersedes`，由 CLI 保留旧 ADR 并同步双方状态。
- 约束消失但没有替代决定时，通过 `memory deprecate` 的 `{ "id", "reason" }` 配置弃用。
- CLI 同一次受管写入更新 `project/memory.json`、ADR 和根 `CONTEXT.md` 索引。
- 范围只用于选择何时读取；所有 ADR 仍是一个逻辑项目共享的长期记忆。
