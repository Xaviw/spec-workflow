# Spec Driven Template

本仓库是独立的规格驱动开发工作区。代码仓库只作为外部目标仓库接入；不要把本仓库文件写入目标代码仓库。

## 启动约定

1. 始终使用简体中文沟通、编写任务文档和注释；修改目标仓库代码时，标识符遵循该仓库现有命名约定。
2. 若根目录存在 `AGENTS.local.md`，先读取其中的本地配置。不得提交、复述或猜测其中的敏感信息。
3. 仅当当前请求需要运行工作流且必要配置缺失，或用户要求初始化、更新配置时，调用 `sw-setup`；工作流命令失败或需要核验安装、配置、版本及 Agent 接入时，调用 `sw-doctor`。两者的 CLI 均由 Agent 执行，不要求用户手动调用；setup 只询问 Agent 无法探测的必要信息。
4. Node.js 最低版本为 22.12.0。统一 CLI 入口是 `node tools/workflow.js`。
5. 若 Agent 不支持原生 Skill 调用，直接读取对应 `.agents/skills/<name>/SKILL.md` 并遵循其中流程。
6. 按最小上下文启动：默认只读取本文件、`AGENTS.local.md`、用户明确指定的任务 `task.json`，以及当前步骤对应的一个 Skill。
7. 不得在启动时批量读取其他任务、全部迭代、全部规范、全部 Skill 或全部目标仓库；仅在当前 Skill 的“按需读取”条件命中时扩展上下文。

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

## 路由

1. 用户明确给出任务 ID、路径、链接或本轮已选定唯一任务时，直接进入该任务并按下表路由，不再搜索相关任务。
2. 用户未明确任务时，调用 `sw-route-task`，同时判断简单任务/工作流任务并筛选相关任务。
3. 新建工作流任务前，必须让用户明确选择已有开放迭代或新建迭代。
4. 不保存“当前活动任务”指针；新会话不得从未提交状态猜测用户当前任务。

| `task.json.phase` | Skill |
| --- | --- |
| `prd` | `sw-prd` |
| `technical_design` | `sw-technical-design` |
| `implementation_spec` | `sw-spec` |
| `implementation` | `sw-implement` |
| `verification` | `sw-verify` |
| `done` / `cancelled` | 只读；相关后续按规则重开或新建任务 |

阶段依次为：`prd -> technical_design -> implementation_spec -> implementation -> verification -> done`。向前推进前必须取得用户对上一阶段文档的明确确认。不得自动进入 `done`。

## 完整性约定

1. `phase` 只表示任务位置，不代表当前产物合格。每次工作前运行 `task status <task> --json`；推进前运行 `task validate <task>`。
2. PRD 验收项使用稳定 ID（`AC-001` 起）；技术方案、实施方案和验证记录必须覆盖同一组 ID。`pass` 和 `human-confirmed` 必须附证据，`waived` 必须附理由。
3. 每次 `--confirmed` 都绑定当前产物及上游依赖的 hash。确认后修改上游文档会使下游 checkpoint 变为 stale，必须重新审阅并确认。
4. `task.json.revision` 是并发修改版本。长流程写入时传 `--expected-revision <n>`；冲突后重新读取状态，不覆盖他人的更新。
5. Slice 只通过 CLI 定义和推进；依赖未完成时不得开始，最多一个 `in_progress`，全部完成后才能进入 verification。
6. 进入 implementation 时 CLI 自动记录每个目标仓库的 canonical root、branch、HEAD 和初始脏文件。不要手工伪造 delivery 字段。
7. verification 完成后先给出一次多仓提交计划并取得一次用户授权，再提交各代码仓库；进入 done 时为每仓传入一个或多个 `--commit repo=sha`。CLI 校验 commit、顺序、最终 HEAD 和验证 tree。
8. `done` / `cancelled` 是普通阶段命令不可回退的终态。仅开放迭代可用 `task reopen` 显式重开；已收口迭代应在新迭代建立关联任务。

## 不可违反的边界

- 不自动 stash、reset、checkout、建分支、push、merge、部署、执行 DDL 或写生产环境。
- 不读取或输出密钥值；只记录环境变量名、配置依赖和获取方式。
- 未经用户确认，不覆盖与本任务重叠的既有修改。
- 代码审查默认只报告，不因严重级别自动修改用户代码。密钥、权限、数据、公共契约和来源不明的修改始终由用户决定处置方式。
- 多仓库提交只在验证完成后给出一次提交计划并请求一次确认；代码仓库 commit、任务 done 记录和工作流文档提交均包含在该计划内，但不得 push。
- 所有任务文档保持当前事实：需求或实现变化后，立即同步 `prd.md`、`decisions.md`、`technical-design.md`、`spec.md` 或 `verification.md` 中受影响的内容。
