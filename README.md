# spec-driven-template

独立于代码仓库的规格驱动工作流。一个工作流仓库管理一个逻辑项目，可关联多个分散的 Git 仓库；目标仓库无需安装工作流文件。

## 五分钟开始

要求 Git 和 Node.js 22.12.0 或更高版本。

1. 复制本模板并在目录中初始化 Git 仓库。
2. 从仓库根目录启动支持的 Agent；若没有自动读取入口，发送：`请读取 AGENTS.md，并执行 sw-setup。`
3. Agent 探测目标仓库，并按提示确认项目目标、Agent、代码仓库及其启动、环境和联调信息。
4. 运行 `node tools/workflow.js doctor`，确认输出为 `阻塞 0`。
5. 创建迭代和任务：

```text
node tools/workflow.js iteration create --title "首个迭代" --goal "交付目标"
node tools/workflow.js task create --iteration <iteration-id> --title "任务名" --summary "需求摘要" --repositories backend,frontend
node tools/workflow.js task status <task-path>
```

setup 只修改工作流仓库，并首次创建根目录 `CONTEXT.md` 和 `project/memory.json` 作为项目长期记忆入口及受管状态。私有路径和偏好写入 Git 忽略的 `AGENTS.local.md`；密钥值仍保存在环境变量、`.env` 或密钥管理系统中。

## 核心模型

工作流仍只有六个顺序阶段：

```text
prd -> technical_design -> implementation_spec -> implementation -> verification -> done
```

但阶段不是质量结论。任务完整性由四部分共同决定：

| 维度 | 含义 | 查看方式 |
| --- | --- | --- |
| Phase | 当前工作位置 | `task status` |
| Readiness | 文档、AC、Slice、仓库证据是否满足门禁 | `task validate` |
| Approval | 用户确认的产物和上游 hash 是否仍新鲜 | `task.json.checkpoints/approvals` |
| Delivery | 多仓基线、验证 tree 和最终 commit 是否可追溯 | `task status --json` |

PRD 使用 `AC-001` 等稳定验收 ID。技术方案和 spec 必须覆盖全部 AC；验证记录为每个 AC 写 `pass`、`human-confirmed`、`waived`、`failed` 或 `unverified`。通过状态必须有证据，豁免必须有理由。

确认后修改上游文档，或修改阶段文档显式引用的 `CONTEXT.md`、ADR、项目事实，会自动使相关 checkpoint 变为 stale，不能仅靠再次添加 `--confirmed` 跳过。`task.json.revision` 与 `project/memory.json.revision` 分别保护任务和共享长期记忆，写入时传 `--expected-revision <n>`。

## 术语参考

| 术语 | 含义 |
| --- | --- |
| grilling / `grilling` | 按决策依赖分轮追问并确认需求、方案或其他未决取舍。 |
| 项目长期记忆 | 跨任务保留的项目级认知，由 `CONTEXT.md` 中的专业术语和关键决策索引、根目录 ADR，以及 `project/index.md` 和 `project/repositories/*.md` 中验证后的当前事实共同组成。 |
| 专业术语 | 项目内反复使用、含义明确且有统一名称的业务或产品概念；同义词和避免用语记录在 `CONTEXT.md`。 |
| `CONTEXT.md` | 工作流原生 Skill 的项目级必读入口，保存项目简介、专业术语和关键决策索引。 |
| ADR | 关键决策记录；只记录难以逆转、脱离背景会令人意外且存在真实取舍的项目级决定。完整正文位于根目录 `adr/`。 |
| domain modeling / `sw-domain-modeling` | 维护专业术语和关键决策的过程与 Skill；可由用户直接调用，也会在其他阶段形成新术语或重要取舍时调用。 |
| `decisions.md` | 单个任务的追加式选择记录；只有达到 ADR 门槛的决定才进入项目长期记忆。 |
| AC / `AC-001` | 验收标准及其稳定 ID。 |
| checkpoint | 已确认阶段产物及依赖的快照。 |
| `revision` | 防止并发覆盖的修改计数器。 |
| `fresh` / `stale` | checkpoint 有效或已失效。 |
| Slice | 可独立推进的实施增量。 |
| DAG | 无循环的依赖图。 |
| artifact | 工作流产物。 |
| DDL | 数据库结构定义语句。 |
| canonical root | 仓库的真实根目录。 |
| baseline HEAD | 实施开始时的仓库提交。 |
| verification tree / delivery tree | 验证后的交付内容。 |
| fingerprint | 发布来源状态的摘要。 |
| receipt | 确认或收口的结构化凭据。 |
| `pass` / `human-confirmed` / `waived` / `failed` / `unverified` | 通过、人工确认、豁免、失败或未验证。 |

## Skill 协作

`sw-` 前缀表示依赖任务状态、工作流文件或 CLI 的原生 Skill。无前缀 Skill 是独立能力，可由用户在任意仓库直接使用，也可由工作流 Skill 提供更精确的当前请求后调用；是否仅允许用户调用由 Skill 元数据决定。

`grilling` 是无状态的结构化澄清 Skill。当前请求提供访谈主题、已知事实、待决范围和完成标准；它返回确认结果，但不写阶段产物、不推进阶段、不实施结论。

- `sw-prd` 调用 `grilling` 完成需求澄清，再维护 `prd.md` 和 `decisions.md`。
- `sw-technical-design` 仅在代码、项目事实和 ADR 无法确定技术取舍时调用 `grilling`。
- `sw-spec` 或 `sw-implement` 发现新的用户决策时调用 `grilling`，并先同步、重新确认受影响的上游文档。
- 访谈形成专业术语或达到 ADR 门槛的关键决定时，由调用方同时调用 `sw-domain-modeling`。

## 项目长期记忆

根目录 `CONTEXT.md` 和 `project/index.md` 是工作流原生 Skill 开始前的必读入口。前者使用“专业术语”统一项目表达，并用“关键决策”索引列出所有 ADR 的状态、范围和一句话摘要；后者提供项目级当前事实和仓库导航。Agent 只读取当前任务范围命中的 ADR 正文和仓库事实，避免把全部历史决定装入上下文。

用户可以直接调用 `sw-domain-modeling` 澄清一个项目概念、统一叫法或记录关键决定。它通过 `memory` CLI 在根级锁内更新 `project/memory.json`、`CONTEXT.md` 和 ADR，并使用 revision 防止并发覆盖。普通任务选择继续写入任务 `decisions.md`；验证后的项目级事实写入 `project/index.md`，仓库事实写入 `project/repositories/<repo-id>.md`，不创建无法从入口发现的知识文件。

用户也可以随时调用 `code-review` 审查明确指定的代码或变更范围；未指定范围时审查当前 Git 的暂存、未暂存和未跟踪变更。独立调用不依赖本工作流记忆；工作流带 task 调用时，由调用方使用 task delivery 或现场基线限定范围，并注入任务显式引用的项目事实和 ADR。

`writing-great-skills` 仅在用户明确调用时创建、改进或诊断任意 Agent Skill，不依赖本工作流的任务、阶段或文件结构。

一个工作流仓库管理一个逻辑项目，因此所有 ADR 统一放在根目录 `adr/`。即使决定只影响某个代码仓库，也只在索引和 ADR 的“范围”中标记仓库或模块，不建立仓库级 ADR 目录。

## 日常命令

```text
node tools/workflow.js task candidates --json
node tools/workflow.js task status <task> [--json]
node tools/workflow.js task validate <task> [--phase <phase>] [--json]
node tools/workflow.js task phase <task> <phase> --confirmed
node tools/workflow.js task slices <task> --config slices.json
node tools/workflow.js task slice <task> <slice-id> in_progress
node tools/workflow.js task slice <task> <slice-id> done
node tools/workflow.js context <skill-name> --task <task>
node tools/workflow.js memory status [--json]
node tools/workflow.js memory term --config term.json --expected-revision <n> --apply
node tools/workflow.js memory adr --config adr.json --expected-revision <n> --apply
node tools/workflow.js memory deprecate --config deprecate.json --expected-revision <n> --apply
node tools/workflow.js doctor
```

`task slices` 的 JSON 是数组，每项包含 `id`、`title`、`status: "pending"` 和 `blocked_by`。Slice 只在 implementation_spec 定义，只在 implementation 按 `pending -> in_progress -> done` 推进；最多一个进行中，依赖完成后才能启动。

全局强制规则和读取条件统一写在 `AGENTS.md`。详细规范位于根目录 `standards/`；Agent 只在任务命中 API、安全、数据库、Redis、对象存储或日志条件时读取相关文件，不批量加载。任务不保存规范绑定和完整规则清单；规则或例外实质影响实施时，才在 `spec.md` 对应步骤就地记录并随实施方案确认。

删除、移动和适配器替换默认只预览，确认目标后添加 `--apply`。`done` 和 `cancelled` 是终态；开放迭代中需要修订时使用 `task reopen <task> <phase> --reason "..." --confirmed`，已结束迭代则新建关联任务。

## 多仓交付

进入 implementation 时，CLI 自动捕获每个登记仓库的真实根目录、branch、HEAD 和初始脏文件。实现与可执行验证完成后：

1. Agent 汇总一次跨仓提交计划，用户只确认一次。
2. 按依赖顺序提交代码仓库，不 push。
3. 使用最终 commit 完成任务：

```text
node tools/workflow.js task phase <task> done \
  --commit backend=<sha> \
  --commit frontend=<sha> \
  --confirmed
```

同一仓库有多个有序 commit 时可重复传同一 repo。CLI 要求 commit 是基线的严格后代、按祖先顺序排列，最后一个等于当前 HEAD，并且验证后的 tree 未漂移。

迭代发布方案只聚合 done 任务和已登记简单变更，来源指纹包含任务 revision、全部阶段产物、checkpoint、Slice、delivery tree 和 commit：

```text
node tools/workflow.js iteration release-plan <iteration-id>
node tools/workflow.js iteration release-plan <iteration-id> --apply
node tools/workflow.js iteration confirm-release-plan <iteration-id> --confirmed
node tools/workflow.js iteration done <iteration-id> --confirmed
```

任何来源或方案正文变化都会使确认失效。以上命令不执行 push、部署或 DDL。

## Agent 接入

| Agent | 项目入口 | 项目 Skills | setup 动作 |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` | `.claude/skills` | 生成入口并链接或复制 Skills |
| Codex / Reasonix / Pi / Cursor | `AGENTS.md` | `.agents/skills` | 原生检查 |
| Trae | `AGENTS.md` | `.agents/skills` | 原生检查，并提示启用导入开关 |
| OpenCode | `AGENTS.md` | `.agents/skills` | 原生检查 |

未知工具可在 setup 中选择 `custom`。生成的适配文件只位于工作流仓库，并写入当前 Git 仓库的 exclude。

## 目录与测试

```text
AGENTS.md                  跨 Agent 最小入口
.agents/skills/            工作流原生与独立能力 Skills
CONTEXT.md                 setup 生成的专业术语与关键决策必读入口
adr/                       按需创建的项目级关键决策记录
tools/                     无第三方依赖的 Node.js CLI
standards/                 由 AGENTS.md 按任务内容路由的工程规范
project/                   受管 memory 状态、项目索引和外部仓库事实
iterations/                迭代、任务和发布记录
AGENTS.local.md            本地配置，不提交
```

运行回归测试：

```text
cd tools
npm test
```

文本产物统一以 LF 提交，checkpoint hash 会规范化本地 CRLF/LF 差异。
