---
name: sw-domain-modeling
description: 维护项目长期记忆中的专业术语和关键决策。用户要求澄清或统一术语、记住项目概念、记录重要决定、更新 CONTEXT.md 或创建 ADR 时使用；其他工作流阶段形成新术语或难以逆转的真实取舍时也应调用。
---

# 维护项目专业术语与关键决策

主动澄清项目中的专业术语，并将真正重要的长期决定记录下来。仅仅读取 `CONTEXT.md` 和相关 ADR 是所有工作流的常规动作，不算调用本 Skill；只有需要改变长期记忆时才执行下面的流程。

## 上下文契约

必读：根目录 `CONTEXT.md` 和用户请求。

按需读取：当前任务的 `task.json`、`decisions.md`、相关代码和文档，以及 `CONTEXT.md` 关键决策索引指向的相关 ADR。

初始禁止：无关任务、全部目标仓库、索引中与当前主题无关的 ADR、全部项目知识。

输出：通过 `memory` CLI 原子更新的 `project/memory.json`、`CONTEXT.md` 和必要的根目录 `adr/*.md`。

## 流程

1. 运行 `memory status --json` 并记录 revision。区分当前问题是术语、关键决定还是普通任务信息。普通范围、验收和临时实施选择留在任务 `decisions.md`；验证后的项目级事实写入 `project/index.md`，仓库事实写入 `project/repositories/<repo-id>.md`；只有专业术语和满足门槛的关键决定进入受管长期记忆。完成：信息归属唯一，受管状态和当前 revision 已知。
2. 对照 `CONTEXT.md` 挑战含糊、冲突或一词多义的表达，并用具体场景和代码事实核对边界。不能从现有事实确定时再询问用户。完成：术语具有一个规范名称、明确含义和必要的避免用语。
3. 术语确认后读取 [专业术语与索引格式](references/context-format.md)，生成临时 JSON 配置并运行 `memory term --config <file>` 预览；核对预览后使用步骤 1 的 revision 添加 `--expected-revision <n> --apply`。revision 冲突时重新读取状态和用户已确认结论，不覆盖其他更新。完成：定义简短、无实现细节，CLI 已同步受管状态和 `CONTEXT.md`。
4. 只有决定同时满足“难以逆转”“脱离背景会令人意外”“存在真实取舍”时才创建 ADR。读取 [ADR 格式与门槛](references/adr-format.md)，展示拟记录的标题、范围、摘要、正文和替代关系；取得明确确认后生成临时 JSON，先运行 `memory adr --config <file>` 预览，再以当前 revision 添加 `--expected-revision <n> --apply`。编号由锁内 CLI 分配，不手工猜测。完成：ADR、状态和索引由同一次受管写入生成；不满足任一条件的决定只留在任务记录中。
5. 当代码、任务文档、专业术语或现有 ADR 互相冲突时显式指出，不静默选择。替代旧决定时在新 ADR 配置中写 `supersedes`；约束消失时使用 `memory deprecate --config <file>`。完成：当前有效含义和决定可从 `CONTEXT.md` 直接识别，历史原因仍可追溯，`doctor` 无长期记忆错误。

## 边界

- `project/memory.json`、`CONTEXT.md` 受管块和 ADR 元数据只由 `memory` CLI 修改；不要直接编辑、预分配编号或分步同步。
- `CONTEXT.md` 是项目级必读入口，只保存项目简介、专业术语和关键决策索引；不是需求、规格、实现说明、会议纪要或草稿。
- 根目录 `adr/` 保存一个逻辑项目共用的关键决策。仓库和模块只作为读取范围，不决定 ADR 的存放目录。
- `decisions.md` 保存任务级关键选择，数量可以较多；不得把每项任务决定都升级为 ADR。
- `project/index.md` 和 `project/repositories/*.md` 保存可发现的当前事实；不要把当前事实伪装成术语或决定，也不要创建无索引知识文件。
- 不在任何长期记忆中保存密钥值、个人敏感信息或仅对本机有效的私有路径。
