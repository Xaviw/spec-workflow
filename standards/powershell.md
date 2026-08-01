# PowerShell 命令执行规范

仅在当前 Shell 为 PowerShell 且任务需要执行命令时读取。本文只记录与用户和机器无关、稳定且可复现的公共规则；本机路径、端口、代理、可执行文件位置、登录状态和临时故障留在本地忽略配置或临时目录。

## 参数与转义

- Git revision 含有 PowerShell 特殊字符时使用引号，例如 `git rev-parse 'HEAD^{tree}'`。
- 搜索 Markdown 反引号或其他可能触发插值的文本时，优先使用单引号包裹模式，例如 `rg 'task phase' AGENTS.md`。
- PowerShell 不支持 Bash 风格的 `{a,b}` 路径展开；需要多个路径时逐项写出或使用 PowerShell 数组。

## 退出码与批量检查

- `rg` 无匹配返回退出码 1。允许无匹配时显式将其视为正常结果，例如：`rg 'pattern' path; if ($LASTEXITCODE -eq 1) { exit 0 }`。
- 读取可选路径前先用 `Test-Path -LiteralPath` 判断是否存在。
- 并行批次中的命令必须独立处理可预期的非零退出码，避免单个正常的无结果或可选路径缺失使其他输出丢失。
- `foreach` 结果需要继续送入管道时，先赋值再传递，例如 `$rows = foreach (...) { ... }; $rows | Format-Table`。

## 文件操作

- 递归删除或移动前解析并核对绝对目标仍位于预期目录。
- 文件枚举和操作使用 PowerShell 原生命令端到端完成，不把 PowerShell 枚举结果交给其他 Shell 执行删除或移动。

新发现与现有规则等价时完善原条目，不追加事故日志。无法稳定复现、只发生一次或由本机配置导致的问题不写入本文。Bash、zsh 等 Shell 在确有公共规则时使用各自独立 standard，不预建空规范或统一包装器。
