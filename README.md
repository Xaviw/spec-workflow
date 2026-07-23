# spec-driven-template

独立于代码仓库的规格驱动工作流。一个工作流仓库管理一个逻辑项目，可关联多个分散的 Git 仓库；目标仓库无需安装工作流文件。

## 五分钟开始

要求 Git 和 Node.js 22.12.0 或更高版本。

1. 复制本模板并在目录中初始化 Git 仓库。
2. 从仓库根目录启动支持的 Agent；若没有自动读取入口，发送：`请读取 AGENTS.md，并执行 spec-driven-setup。`
3. 按提示填写项目目标、Agent、Git 邮箱和代码仓库根目录。默认流程只询问必要信息；需要端口、环境和联调细项时运行 `node tools/workflow.js setup --detailed`。
4. 运行 `node tools/workflow.js doctor`，确认输出为 `阻塞 0`。
5. 创建迭代和任务：

```text
node tools/workflow.js iteration create --title "首个迭代" --goal "交付目标"
node tools/workflow.js task create --iteration <iteration-id> --title "任务名" --summary "需求摘要" --repositories backend,frontend
node tools/workflow.js task status <task-path>
```

setup 只修改工作流仓库。私有路径和偏好写入 Git 忽略的 `AGENTS.local.md`；密钥值仍保存在环境变量、`.env` 或密钥管理系统中。

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

确认后修改上游文档会自动使相关 checkpoint 变为 stale，不能仅靠再次添加 `--confirmed` 跳过。`task.json.revision` 用于并发保护，长流程可传 `--expected-revision <n>`。

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
node tools/workflow.js doctor
```

`task slices` 的 JSON 是数组，每项包含 `id`、`title`、`status: "pending"` 和 `blocked_by`。Slice 只在 implementation_spec 定义，只在 implementation 按 `pending -> in_progress -> done` 推进；最多一个进行中，依赖完成后才能启动。

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
.agents/skills/            分阶段 Skills
tools/                     无第三方依赖的 Node.js CLI
project/                   setup 生成的项目事实
iterations/                迭代、任务和发布记录
AGENTS.local.md            本地配置，不提交
```

运行回归测试：

```text
cd tools
npm test
```

文本产物统一以 LF 提交，checkpoint hash 会规范化本地 CRLF/LF 差异。

升级模板时只合并上游 `AGENTS.md`、`.agents/skills/`、`tools/` 和 `.gitattributes`，保留 `project/`、`iterations/` 与 `AGENTS.local.md`，再运行测试和 doctor。项目特殊规则写入可选的 `project/policies.md`。
