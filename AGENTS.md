# Spec Driven Template

本仓库是独立的规格驱动开发工作区。代码仓库只作为外部目标仓库接入；不要把本仓库文件写入目标代码仓库。

## 启动约定

1. 始终使用简体中文沟通、编写任务文档和注释；修改目标仓库代码时，标识符遵循该仓库现有命名约定。
2. 工作流原生 Skill 若发现根目录 `AGENTS.local.md`，先读取其中的本地配置；无前缀 Skill 仅在用户明确要求时读取。不得提交、复述或猜测其中的敏感信息。
3. 仅当当前请求需要运行工作流且必要配置缺失，或用户要求初始化、更新配置时，调用 `sw-setup`；工作流命令失败或需要核验安装、配置及 Agent 接入时，调用 `sw-doctor`。两者的 CLI 均由 Agent 执行，不要求用户手动调用；setup 只询问 Agent 无法探测的必要信息。
4. Node.js 最低版本为 22.12.0。统一 CLI 入口是 `node tools/workflow.js`。
5. 若 Agent 不支持原生 Skill 调用，直接读取对应 `.agents/skills/<name>/SKILL.md` 并遵循其中流程。
6. 按最小上下文启动：工作流原生 Skill 默认只读取本文件、`AGENTS.local.md`、根目录 `CONTEXT.md`、`project/index.md`（若 setup 已生成）、用户明确指定的任务 `task.json` 和当前阶段 Skill；无前缀 Skill 默认只读取本文件、当前请求和自身 `SKILL.md`，再按其上下文契约扩展。工作流带 task 调用无前缀 Skill 时，由调用方提供该任务显式引用的项目记忆。Skill 明确调用其他 Skill 时才读取对方的 `SKILL.md`。
7. 不得在启动时批量读取其他任务、全部迭代、全部规范、全部 Skill 或全部目标仓库；仅在当前已加载 Skill 的“按需读取”条件命中时扩展上下文。

`sw-` 前缀表示依赖本工作流状态或文件的原生 Skill；无前缀 Skill 是可在任意仓库独立使用、也可由工作流提供精确上下文后调用的通用能力。是否仅允许用户调用由 Skill 元数据决定，不由前缀决定。

## 工程规范

以下规则始终生效：

- 不得在代码、测试、日志、任务文档或提交记录中保存明文凭据；只记录环境变量名、依赖和获取方式。
- 认证、授权、租户和数据范围必须由服务端可信身份决定，不得信任客户端传入的身份归属。
- 工作流只设计和静态审查 DDL，不执行 DDL、生产写入或不可逆数据操作。
- 敏感信息保护优先于日志完整性，不得为排障记录令牌、口令、私钥或完整个人敏感信息。
- 目标仓库明确记录的规则优先；与根目录规范冲突且影响实施时，在 `spec.md` 对应步骤记录取舍并随实施方案取得用户确认，不得静默选择。

详细规范位于根目录 `standards/`。不得批量读取；仅在任务命中下列条件时读取直接相关文档：

| 触发条件 | 读取文档 |
| --- | --- |
| 新增或修改 API、错误码、公共字段、接口版本 | `standards/api-contract.md` |
| Token、认证、权限、Cookie、个人信息或其他安全边界 | `standards/security.md` |
| 请求签名、验签、防重放或签名加密协议 | `standards/security.md`、`standards/api-signing-v2.md` |
| 表结构、索引、事务、SQL 或数据迁移 | `standards/mysql.md` |
| Redis、缓存、分布式锁或限流计数 | `standards/redis.md` |
| 上传、下载、对象存储、STS 或 CDN | `standards/security.md`、`standards/object-storage.md` |
| 日志、requestId、链路、告警或审计 | `standards/logging.md`、`standards/security.md` |

不维护任务级规范绑定或完整规则清单。规则或例外实质影响某个实施步骤、审查发现或验证动作时，才在 `spec.md` 对应步骤或发现位置就地记录并按需引用规则 ID。

## 项目长期记忆

- 根目录 `CONTEXT.md` 是项目级必读入口，只保存项目简介、已确认的专业术语和关键决策索引。使用其中的规范名称，不得漂移到明确列出的避免用语。
- `CONTEXT.md` 的关键决策索引包含状态、范围和决定摘要；只读取与当前项目、仓库或模块范围相关的根目录 `adr/*.md`，不得批量加载全部 ADR。
- `project/index.md` 保存项目级当前事实和仓库导航；仓库事实写入按任务自动加载的 `project/repositories/<repo-id>.md`。不创建无法从这两个入口发现的知识文件。
- `project/memory.json` 是专业术语和 ADR 元数据的受管状态。不得直接编辑它、`CONTEXT.md` 的受管块或 ADR 元数据；用户要求澄清或记录项目概念、更新长期记忆、创建 ADR，或工作中形成新的专业术语或难以逆转的真实取舍时，调用 `sw-domain-modeling` 并使用 `memory` CLI。
- 多个代码仓库仍属于本工作流管理的同一个逻辑项目。ADR 统一存放在根目录 `adr/`，仓库和模块仅作为读取范围，不建立仓库级 ADR 目录。
- 任务 `decisions.md` 保存任务级选择；验证后的当前事实写入 `project/`；不得把它们无差别提升为专业术语或 ADR。

## 路由

1. 用户明确要求只做代码审查时，直接调用 `code-review`，不要求选择、新建或推进工作流任务。若用户同时指定 task，以 task delivery 和相关文档作为明确审查范围，并提供任务文档显式引用的 `CONTEXT.md`、ADR 和项目事实；若仅指定本工作流登记的 repo ID 或模块，调用前从 `CONTEXT.md` 索引筛选相关 ADR。其他独立审查不加载本工作流记忆。
2. 用户明确给出任务 ID、路径、链接或本轮已选定唯一任务时，直接进入该任务并按下表路由，不再搜索相关任务。
3. 用户未明确任务时，调用 `sw-route-task`，同时判断简单任务/工作流任务并筛选相关任务。
4. 新建工作流任务前，必须让用户明确选择已有开放迭代或新建迭代。
5. 不保存“当前活动任务”指针；新会话不得从未提交状态猜测用户当前任务。

| `task.json.phase` | Skill |
| --- | --- |
| `prd` | `sw-prd` |
| `technical_design` | `sw-technical-design` |
| `implementation_spec` | `sw-spec` |
| `implementation` | `sw-implement` |
| `verification` | `sw-verify` |
| `done` / `cancelled` | 只读；相关后续按规则重开或新建任务 |

阶段依次为：`prd -> technical_design -> implementation_spec -> implementation -> verification -> done`。向前推进前必须取得用户对上一阶段文档的明确确认。不得自动进入 `done`。

阶段 Skill 遇到必须由用户决定的未决项时调用 `grilling`，在当前请求中说明访谈主题、已知事实、待决范围和完成标准；有限选项确认不需要调用。`grilling` 只返回确认结果，阶段产物和阶段推进仍由阶段 Skill 负责。

## 完整性约定

1. `phase` 只表示任务位置，不代表当前产物合格。每次工作前运行 `task status <task> --json`；推进前运行 `task validate <task>`。
2. PRD 验收项使用稳定 ID（`AC-001` 起）；技术方案、实施方案和验证记录必须覆盖同一组 ID。`pass` 和 `human-confirmed` 必须附证据，`waived` 必须附理由。
3. 每次 `--confirmed` 都绑定当前产物及上游依赖的 hash。确认后修改上游文档会使下游 checkpoint 变为 stale，必须重新审阅并确认。
4. 阶段文档必须用 inline code 写出实际依赖的仓库根相对路径，例如 `CONTEXT.md`、`adr/0001-example.md` 或 `project/repositories/backend.md`。CLI 将这些路径的内容 hash 纳入 checkpoint；不要引用未读取的长期记忆。
5. `task.json.revision` 和 `project/memory.json.revision` 分别保护任务与共享长期记忆。长流程写入时传 `--expected-revision <n>`；冲突后重新读取状态，不覆盖他人的更新。
6. Slice 只通过 CLI 定义和推进；依赖未完成时不得开始，最多一个 `in_progress`，全部完成后才能进入 verification。
7. 进入 implementation 时 CLI 自动记录每个目标仓库的 canonical root、branch、HEAD 和初始脏文件。不要手工伪造 delivery 字段。
8. verification 完成后先给出一次多仓提交计划并取得一次用户授权，再提交各代码仓库；进入 done 时为每仓传入一个或多个 `--commit repo=sha`。CLI 校验 commit、顺序、最终 HEAD 和验证 tree。
9. `done` / `cancelled` 是普通阶段命令不可回退的终态。仅开放迭代可用 `task reopen` 显式重开；已收口迭代应在新迭代建立关联任务。

## 不可违反的边界

- 不自动 stash、reset、checkout、建分支、push、merge、部署、执行 DDL 或写生产环境。
- 不读取或输出密钥值；只记录环境变量名、配置依赖和获取方式。
- 未经用户确认，不覆盖与本任务重叠的既有修改。
- 代码审查默认只报告，不因严重级别自动修改用户代码。密钥、权限、数据、公共契约和来源不明的修改始终由用户决定处置方式。
- 多仓库提交只在验证完成后给出一次提交计划并请求一次确认；代码仓库 commit、任务 done 记录和工作流文档提交均包含在该计划内，但不得 push。
- 所有任务文档和项目长期记忆保持当前事实：需求、实现、专业术语或关键决定变化后，立即同步受影响的 `prd.md`、`decisions.md`、`technical-design.md`、`spec.md`、`verification.md`、`CONTEXT.md` 或 ADR。
