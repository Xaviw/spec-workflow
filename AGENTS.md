# Spec Driven Template

本仓库是独立的规格驱动开发工作区。代码仓库只作为外部目标仓库接入；不要把本仓库文件写入目标代码仓库。

## 启动约定

1. 始终使用简体中文沟通、编写文档和注释；代码标识符遵循目标仓库约定。
2. 若根目录存在 `AGENTS.local.md`，先读取其中的本地配置。不得提交、复述或猜测其中的敏感信息。
3. 首次使用、配置缺失或 doctor 报告不兼容时，调用 `spec-driven-setup`；只读诊断调用 `spec-driven-doctor`。
4. Node.js 最低版本为 22.12.0。统一 CLI 入口是 `node tools/workflow.js`。
5. 若 Agent 不支持原生 Skill 调用，直接读取对应 `.agents/skills/<name>/SKILL.md` 并遵循其中流程。

## 最小上下文

默认只读取：本文件、`AGENTS.local.md`、用户明确指定的任务 `task.json`，以及当前步骤对应的一个 Skill。

禁止在开始时批量读取：其他任务、全部迭代、全部项目知识、全部 Skill、全部目标仓库。仅在当前 Skill 的“按需读取”条件命中时扩展上下文。

## 任务路由

1. 用户明确给出任务 ID、路径、链接或本轮已选定唯一任务时，直接进入该任务，不再搜索相关任务。
2. 用户未明确任务时，调用 `spec-driven-route-task`，同时判断简单任务/工作流任务并筛选相关任务。
3. 简单任务调用 `spec-driven-simple-change`。命中数据库结构或迁移、安全或权限、公共契约、生产环境或不可逆操作时，不得降级为简单任务。
4. 新建工作流任务前，必须让用户明确选择已有开放迭代或新建迭代。
5. 不保存“当前活动任务”指针；新会话不得从未提交状态猜测用户当前任务。

## 阶段路由

| `task.json.phase` | Skill |
| --- | --- |
| `prd` | `spec-driven-prd` |
| `technical_design` | `spec-driven-technical-design` |
| `implementation_spec` | `spec-driven-spec` |
| `implementation` | `spec-driven-implement` |
| `verification` | `spec-driven-verify` |
| `done` / `cancelled` | 只读；相关后续按规则重开或新建任务 |

阶段依次为：`prd -> technical_design -> implementation_spec -> implementation -> verification -> done`。向前推进前必须取得用户对上一阶段文档的明确确认。不得自动进入 `done`。

## 不可违反的边界

- 不自动 stash、reset、checkout、建分支、push、merge、部署、执行 DDL 或写生产环境。
- 不读取或输出密钥值；只记录环境变量名、配置依赖和获取方式。
- 未经用户确认，不覆盖与本任务重叠的既有修改。
- 代码审查默认只报告，不因严重级别自动修改用户代码。密钥、权限、数据、公共契约和来源不明的修改始终由用户决定处置方式。
- 多仓库提交只在验证完成后给出一次提交计划并请求一次确认；工作流文档与代码提交均包含在该计划内。
- 所有任务文档保持当前事实：需求或实现变化后，立即同步 `prd.md`、`decisions.md`、`technical-design.md`、`spec.md` 或 `verification.md` 中受影响的内容。
