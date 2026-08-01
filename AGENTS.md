# Spec Driven Template

本仓库是独立的规格驱动开发工作区。代码仓库只作为外部目标仓库接入；不要把本仓库文件写入目标代码仓库。

## 启动约定

1. 始终使用简体中文沟通、编写任务文档和注释；修改目标仓库代码时，标识符遵循该仓库现有命名约定。
2. Skill 仅在自身上下文契约或显式 task 上下文需要时读取根目录 `AGENTS.local.md`。不得提交、复述或猜测其中的敏感信息。
3. 仅当当前请求需要运行工作流且必要配置缺失，或用户要求初始化、更新配置时，调用 `sw-setup`；工作流命令失败或需要核验安装、配置及 Agent 接入时，调用 `sw-doctor`。两者的 CLI 均由 Agent 执行，不要求用户手动调用；setup 只询问 Agent 无法探测的必要信息。
4. Node.js 最低版本为 22.12.0。统一 CLI 入口是 `node tools/workflow.js`。
5. 若 Agent 不支持原生 Skill 调用，直接读取对应 `.agents/skills/<name>/SKILL.md` 并遵循其中流程。
6. 按最小上下文启动：Skill 默认只读取本文件、当前请求和自身 `SKILL.md`，再按其上下文契约扩展。显式带 task 调用时先读取 `task status <task> --json` 和当前阶段必需产物；`AGENTS.local.md`、`CONTEXT.md`、`project/index.md`、仓库说明、其他阶段文档及其引用仍按 Skill 的条件加载。Skill 明确调用其他 Skill 时才读取对方的 `SKILL.md`。
7. 不得在启动时批量读取其他任务、全部迭代、全部规范、全部 Skill 或全部目标仓库；仅在当前已加载 Skill 的“按需读取”条件命中时扩展上下文。

`tools` 从 `.agents/skills/*/SKILL.md` 动态发现全部 Skill，不按名称或前缀分类。依赖、调用条件和是否仅允许用户调用由各 Skill 自身声明。

## 工程规范

以下规则始终生效：

- 不得在代码、测试、日志、任务文档或提交记录中保存明文凭据；只记录环境变量名、依赖和获取方式。
- 认证、授权、租户和数据范围必须由服务端可信身份决定，不得信任客户端传入的身份归属。
- 工作流只设计和静态审查 DDL，不执行 DDL、生产写入或不可逆数据操作。
- 敏感信息保护优先于日志完整性，不得为排障记录令牌、口令、私钥或完整个人敏感信息。
- 目标仓库明确记录的规则优先；与根目录规范冲突且影响实施时，在 `spec.md` 对应步骤记录取舍并随实施方案取得用户确认，不得静默选择。
- 工作流仓库中可提交的文档、状态和 artifact 只保存仓库 ID、仓库根相对路径和仓库原生命令；本机绝对路径、可执行文件位置、端口覆盖、版本管理器及命令包装只保存在被 Git 排除的 `AGENTS.local.md` 或临时目录，不得写入任务文档、项目事实或提交内容。
- Git 提交沿用目标仓库已有格式；没有更具体规则时使用 Conventional Commit 的英文 type，subject 和 body 使用简体中文，例如 `feat: 增加来源链接去重能力`。提交计划必须展示每个仓库的完整 message。

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
| 当前 Shell 为 PowerShell，且任务需要执行命令 | `standards/powershell.md` |

不维护任务级规范绑定或完整规则清单。规则或例外实质影响某个实施步骤、审查发现或验证动作时，才在 `spec.md` 对应步骤或发现位置就地记录并按需引用规则 ID。

执行过程中解决新的 Shell 问题后，只把与具体用户和机器无关、稳定且可复现的规则去重写入对应 Shell standard；用户环境特有信息仍只保存在 `AGENTS.local.md` 或临时目录。不同 Shell 使用独立规范，没有实际公共规则时不创建空文件。

## `tools` 修改边界

- 修改 Skill 或 Markdown 不自动授权修改 `tools/`；只有现有 CLI 无法保证已确认的状态不变量时才修改 CLI。
- 新增 CLI 命令、持久化字段、状态文件、脚本入口或依赖前，必须说明要保证的状态不变量、现有命令为何不足、Skill 为何不能完成以及已确认调用场景；未经用户明确确认，不新增命令、别名、兼容分支、迁移、清理或诊断脚本。
- 正式发布前不保留旧命令、字段或文件结构兼容，也不为已删除能力编写测试。优先修改现有命令和共享校验，不为单一场景增加抽象、配置或持久化状态。
- CLI 只校验可确定判断的结构和状态，不通过关键词判断任务文档质量。测试只覆盖当前行为和重要不变量，不锁定提示词措辞；同一路径的等价错误只保留最小代表用例。
- 测试使用 Node.js 标准库，不新增测试依赖、框架或辅助执行脚本。只有修改 `tools/workflow.js`、`tools/workflow/**`、状态结构、阶段转换、setup/doctor 行为，或 Skill 变化同时改变 CLI 契约时，才从工作流根运行 `node --test tools/test/workflow.test.js`；普通目标仓库开发和纯 Markdown 修改不运行。
- 交付 `tools` 修改时列出命令面、持久化结构和新增文件变化；没有变化时明确说明无新增命令、字段或脚本。

## 项目长期记忆

- 根目录 `CONTEXT.md` 是项目长期记忆入口，只保存项目简介、已确认的专业术语和关键决策索引。需要项目语义的 Skill 先读取该入口；使用其中的规范名称，不得漂移到明确列出的避免用语。
- `CONTEXT.md` 的关键决策索引包含状态、范围和决定摘要；只读取与当前项目、仓库或模块范围相关的根目录 `adr/*.md`，不得批量加载全部 ADR。
- `project/index.md` 保存项目级当前事实和仓库导航；仓库事实写入按任务自动加载的 `project/repositories/<repo-id>.md`。不创建无法从这两个入口发现的知识文件。
- 用户要求澄清或记录项目概念、更新长期记忆、创建 ADR，或工作中形成新的专业术语或难以逆转的真实取舍时，调用 `sw-domain-modeling`。该 Skill 直接维护 `CONTEXT.md` 和根目录 `adr/*.md`，编号通过检查现有 ADR 分配，历史与并发冲突交给 Git。
- 多个代码仓库仍属于本工作流管理的同一个逻辑项目。ADR 统一存放在根目录 `adr/`，仓库和模块仅作为读取范围，不建立仓库级 ADR 目录。
- 任务 `decisions.md` 保存任务级选择；验证后的当前事实写入 `project/`；不得把它们无差别提升为专业术语或 ADR。

## 路由

1. 用户明确要求只做代码审查时，直接调用 `code-review`，不要求选择、新建或推进工作流任务。若用户同时指定 task，以 task Git 快照和相关文档作为明确审查范围，并提供任务文档显式引用的 `CONTEXT.md`、ADR 和项目事实；若仅指定本工作流登记的 repo ID 或模块，调用前从 `CONTEXT.md` 索引筛选相关 ADR。其他独立审查不加载本工作流记忆。
2. 用户报告现有行为报错、失败、异常、回归、性能下降或偶发问题，或明确要求排查、定位、修复 Bug 时，直接调用 `sw-fix-bug`，不经过简单任务/工作流任务分类，也不创建新任务。用户未明确 task 时只筛选候选并让用户决定是否关联；不关联时直接修复且不更新工作流文档。只要求诊断时不得实施修复。
3. 用户明确给出任务 ID、路径、链接或本轮已选定唯一任务时，直接进入该任务并按下表路由，不再搜索相关任务。
4. 用户未明确任务时，调用 `sw-route-task`，同时判断简单任务/工作流任务并筛选相关任务。
5. 新建工作流任务前，必须让用户明确选择已有开放迭代或新建迭代。
6. 不保存“当前活动任务”指针；新会话不得从未提交状态猜测用户当前任务。

| `task.json.phase` | Skill |
| --- | --- |
| `prd` | `sw-prd` |
| `technical_design` | `sw-technical-design` |
| `implementation_spec` | `sw-spec` |
| `implementation` | `sw-implement` |
| `verification` | `sw-verify` |
| `done` / `cancelled` | 只读；相关后续按规则重开或另行处理 |

阶段依次为：`prd -> [technical_design ->] implementation_spec -> implementation -> verification -> done`。技术方案只在确实需要外部技术评审时生成；PRD 确认问题必须写明建议生成或跳过技术方案，并让用户同时确认后续路径。向前推进前必须取得用户对上一阶段文档和目标阶段的明确确认，不得自动进入 `done`。

阶段 Skill 遇到必须由用户决定的未决项时调用 `grilling`，在当前请求中说明访谈主题、已知事实、待决范围和完成标准；有限选项确认不需要调用。`grilling` 只返回确认结果，阶段产物和阶段推进仍由阶段 Skill 负责。

`prd` 阶段若无法在一次上下文内形成完整需求，使用 `sw-prd` 在现有阶段内渐进探索：先确认目标和非目标，再于 `prd.md` 的“未决问题”中维护当前前沿、后续问题和尚未明确；每解决一个问题立即同步 PRD 与 `decisions.md`。所有开放问题清空前不得推进阶段，不新增 wayfinding 阶段或额外状态机。

## 完整性约定

1. `phase` 只表示任务位置，不代表当前产物合格。每次工作前运行 `task status <task> --json`；CLI 在阶段推进时检查产物存在、AC ID 集合一致且不含可识别的本机绝对路径，内容质量仍由阶段 Skill、审查和用户确认负责。阶段 Skill 在申请确认前必须完成自身的一致性检查。
2. PRD 验收项使用稳定 ID（`AC-001` 起）；实施方案和验证记录必须覆盖同一组 ID，技术方案只引用实际影响外部评审结论的 AC。`pass` 和 `human-confirmed` 必须附证据，`waived` 必须附理由。
3. `--confirmed` 只声明用户已经确认本次推进，不保存审批、hash 或回执。上游事实变化时由当前 Skill 识别受影响文档、重新审阅并再次取得确认。
4. 阶段文档用 inline code 写出实际依赖的仓库根相对路径，例如 `CONTEXT.md`、`adr/0001-example.md` 或 `project/repositories/backend.md`；不要引用未读取的长期记忆。
5. CLI 写入使用原子替换和简单文件锁；长流程写入前重新读取状态，不维护 revision 或乐观并发协议。
6. `task create` 只创建目录和 `task.json`。`prd.md`、`decisions.md`、`spec.md`、`verification.md` 由对应 Skill 创建和维护；`technical-design.md` 仅在用户确认需要外部技术评审时创建。
7. 进入 implementation 时 CLI 根据本地仓库映射记录各目标仓库的 ID、branch、baseline HEAD 和初始脏文件，并在被 Git 排除的本地配置中创建任务与 exact canonical root 的 binding，不把 root 写入任务状态；binding 只在此时创建并保留供 done 重开复用，implementation 后缺失时必须失败，不得按当前映射重建。进入 done 时校验本地 binding、分支和 baseline 历史后记录最终 HEAD、tree 和剩余脏文件。这些是事实，不是质量门禁。
8. verification 完成后先给出一次多仓提交计划并取得一次用户授权，再提交各代码仓库；用户确认任务完成后运行相邻阶段推进命令，CLI 自动采集最终 Git 快照。
9. `task phase` 只能按已定义的向前转换推进；`prd` 可经 `technical_design` 或直接进入 `implementation_spec`，其余阶段只能相邻推进。开放迭代中的 cancelled 任务恢复到取消前阶段，done 任务固定恢复到 verification；已收口迭代应在新迭代建立关联任务。
10. 上游事实变化时，先列出受影响的当前任务文档、`CONTEXT.md` 和相关 ADR，一次完成同步，再在该有限集合内检查旧术语、已解决 Q ID、被替代 ADR 和旧验证命令是否仍被当作当前事实引用；同一批受影响文档一次请求确认。
11. `spec.md` 和 `verification.md` 只记录仓库说明中的原生验证命令，例如 `npm test`；Agent 可按本机环境临时包装执行，但不得把包装器写回工作流文档，并须确认实际命令退出状态与结果摘要一致。
12. 短回复只解释为对紧邻且唯一确认问题的回答。上下文压缩、新会话或同时存在多个待确认项时，重新展示包含文档名称、关键决定和目标阶段的精简确认摘要，不从未提交文件或历史短回复猜测。

## 不可违反的边界

- 不自动 stash、reset、checkout、建分支、push、merge、部署、执行 DDL 或写生产环境。
- 不读取或输出密钥值；只记录环境变量名、配置依赖和获取方式。
- 未经用户确认，不覆盖与本任务重叠的既有修改。
- 代码审查默认只报告，不因严重级别自动修改用户代码。密钥、权限、数据、公共契约和来源不明的修改始终由用户决定处置方式。
- 多仓库提交只在验证完成后给出一次提交计划并请求一次确认；代码仓库 commit、任务 done 记录和工作流文档提交均包含在该计划内，但不得 push。
- 所有任务文档和项目长期记忆保持当前事实：需求、实现、专业术语或关键决定变化后，立即同步受影响的 `prd.md`、`decisions.md`、`technical-design.md`、`spec.md`、`verification.md`、`CONTEXT.md` 或 ADR。
