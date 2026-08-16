# Dungeon Maintainer

Dungeon Maintainer 是面向 SQL Dungeon 的本地代码维护 Agent。它使用 Pi Core 组织模型回合，
但把文件权限、核心审批、Git 检查点、固定检查和浏览器试玩放在确定性代码中执行。

它适合完成以下工作：

- 只读诊断一个明确的游戏问题；
- 在 detached Git worktree 中生成小型补丁；
- 运行项目登记的测试、架构检查和构建；
- 用真实 Chromium 运行单 Pi Agent，按工具反馈试玩单层或全部八层；
- 在同一 Chromium 窗口中快速排查、展示方案、隔离修复、复测并显式应用；
- 在用户显式执行 `apply` 后，把已验证补丁应用到目标工作区。

它不是通用 Coding Agent，不提供 Shell、任意文件写入、自动提交、推送、PR、数据库或 Web 服务。
SQL Dungeon 的 Campfire、Scribe 和 Main 在线 Agent 仍由游戏仓库中的 Python 服务负责。

## 环境要求

- Node.js `>=22.19`
- pnpm `11.9.0`
- Git
- Python 与 SQL Dungeon 自身依赖，用于运行原仓库检查
- `rg`，用于 `inspect search`
- Chromium，仅在运行 `review/play/dashboard` 时需要

安装并验证：

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

构建后可直接运行：

```powershell
node dist/src/cli.js --help
```

需要全局的 `dungeon-maintain` 命令时，可在本仓库执行 `pnpm link --global`。仓库的
`package.json` 已声明同名 `bin` 入口。

## 配置

维护模型只读取当前进程的 `MAINTAINER_*` 环境变量，不扫描目标仓库，也不读取 SQL Dungeon
的 `agent/.env` 或 `MAIN_*`：

```text
MAINTAINER_API_KEY=
MAINTAINER_BASE_URL=https://api.deepseek.com/v1
MAINTAINER_MODEL=deepseek-chat
MAINTAINER_CONTEXT_WINDOW=64000
MAINTAINER_MAX_TOKENS=4096
MAINTAINER_TIMEOUT_MS=60000
```

可以从 [.env.example](.env.example) 查看字段。复制为维护器根目录的 `.env` 后，程序会加载其中的
`MAINTAINER_*` 配置；当前进程环境变量优先，目标游戏仓库的 `.env` 永远不会读取。Key 只存在于模型 Provider 的内存闭包中，不写入任务、日志、
截图或报告。缺少 Key 时，`diagnose` 和 `fix` 返回 `BLOCKED_ENV`；`status`、`apply`、`revert`
不需要模型，`review/play/dashboard` 则需要有效模型 Key，缺少 Key 时明确返回 `BLOCKED_ENV`。

## 命令

```powershell
dungeon-maintain
dungeon-maintain diagnose --repo "C:\path\to\sql-dungeon" "检查第一层主路线"
dungeon-maintain fix --repo "C:\path\to\sql-dungeon" "修复一个展示层问题"
dungeon-maintain approve <task-id> <token>
dungeon-maintain status <task-id>
dungeon-maintain apply <task-id>
dungeon-maintain revert <task-id>
dungeon-maintain review --repo "C:\path\to\sql-dungeon" --floor 1 --headed --fresh
dungeon-maintain review --repo "C:\path\to\sql-dungeon" --suite game-v1
dungeon-maintain play ... # review 的兼容别名
dungeon-maintain dashboard --repo "C:\path\to\sql-dungeon" --floor 1
```

`fix` 要求目标 Git 工作区干净。它只修改任务专用 worktree；目标分支在 `apply` 前不会变化。
如果计划触及领域规则、课程、存储、契约、入口、配置、依赖、试玩桥、线上 Agent 或其他核心
路径，任务会暂停并显示十分钟有效的批准 token。批准绑定 `taskId + baseHead + 精确文件清单`，
不能用于另一任务或扩大范围。

`apply` 会重新检查目标 HEAD、工作区和每个文件的基线 Hash；任何漂移都会拒绝应用。
`revert` 只撤销该任务已经应用且之后未被继续修改的补丁。二者都不会创建 Git commit。

`dashboard` 要求目标工作区干净，先建立任务 worktree，再从该 worktree 启动同窗游戏。左侧
`快速排查` 始终读取点击时的当前楼层，不重置进度；发现可复现故障后才启用 `现场修复`。
核心路径仍需在终端执行一次性 `approve`，随后回到原窗口点击 `继续修复`。只有固定检查和隐藏
复测都通过后，`应用到项目` 才会启用；页面函数不接受路径、Prompt、SQL、命令或批准 token。

## 工具边界

| 工具 | 职责 | 硬边界 |
|---|---|---|
| `inspect` | 状态、浅目录树、搜索、分页读取、Diff | 每次最多 400 行或 48 KiB；禁止凭据和仓库外路径 |
| `patch` | 唯一文本替换或许可路径中新建文本文件 | 必须带 `baseHash`；不删除、不移动、不覆盖二进制；每任务最多 3 文件、120 行 |
| `check` | 执行适配器登记的检查 | 模型只能选择固定 ID，不能传 Shell 或参数 |
| `finish` | 核验结论并生成报告和补丁 | `ready` 必须引用当前代码 Hash 下真实通过的检查 |

`review` 场景会在上述维护工具之外注入 `look/go/use/query` 四个环境工具。它们只能操作临时游戏
会话；连续移动由游戏桥执行，模型看不到 SQL、地图、答案或隐藏裁判状态。
Dashboard 的排查阶段只暴露 `look/go/use/query/inspect/finish`；修复阶段才恢复
`patch/check`，并继续沿用 3 文件、120 行预算。

固定检查 ID 为：`rules-test`、`rules-validate`、`agent-test`、`game-test`、
`game-architecture`、`game-build`。

## 试玩方式

`review`（以及兼容别名 `play`）使用 SQL Dungeon 的开发态协议 v2 桥。桥必须同时满足开发构建、本机 HTTP 地址和
`?playtest=agent` 才会安装。Node Runner 只调用 `look/go/use/query/judge`；`query()` 没有 SQL
参数，管理员预选答案只在游戏进程内读取并通过真实编辑器提交。

Pi Agent 通过 `look` 获取有限玩家投影，再选择 `go`、`use` 或 `query`；每次工具反馈都是
新的模型回合，左侧同一窗口会流式显示回合、工具结果和累计 Token。`go` 只执行一次最多 64
步的真实移动，路径规划、frontier 回退和语义事件停止由游戏桥内部完成，不让模型逐格消耗 Token。
单层失败会保存证据并继续下一层；模型可在发现客观代码问题后调用 `inspect/patch/check/finish`，
补丁仍受 worktree、Hash、审批和 `apply` 边界保护。

每次试玩使用新的 Chromium Context 和临时内存 Run，不读取用户 Profile 或正式 IndexedDB。
报告只保留楼层计数、动作类型、公开界面尾迹和隐藏裁判的有限断言；SQL、参考答案、完整地图、
完整快照、背包、身份和 Key 不写入产物。

Dashboard 每次快速排查都强制调用模型，不复用 PASS 缓存，单次上限为 6 回合、6 次工具调用和
8000 个新增 Token。现场修复前先把当前 Run/Profile 写入临时 Chromium Context 的一次性
`sessionStorage` 检查点，再写 worktree；刷新后必须明确消费并核对楼层、模式、生命和进度，
否则停止复测。检查点不进入正式存档、模型、日志或报告。

## 数据位置

所有任务数据集中在 `%LOCALAPPDATA%\dungeon-maintainer\`：

```text
tasks/<task-id>/
├─ task.json
├─ session.jsonl
├─ events.ndjson
├─ report.md
├─ patch.diff
├─ reverse.diff
├─ checks/
├─ play/
└─ dashboard/

worktrees/<task-id>/
cache/harness-v1.json
```

普通维护会话上限为 20 个模型回合和 40 次工具调用；完整八层 Harness 每层使用 64/64，
Dashboard 快速排查使用 6/6/8000，现场修复使用 20/40 且受任务剩余 Token 限制。整个任务上限为
64000 个累计 Token。
模型上下文约达到窗口 75% 时会压缩，但保留任务目标、Git 基线、批准路径、失败证据、修改文件和检查状态。进度日志
不会回灌模型上下文。`check` 缓存绑定检查 ID 和完整 worktree Hash。Harness 只会在可见轨迹
完全一致时重放净化后的 `look/go/use/query`，并只缓存同适配器版本、场景和代码 Hash 下的 PASS；
`--fresh` 可绕过两级 Harness 缓存。任意代码变化都会使结果缓存失效。

完整设计和安全理由见 [docs/MAINTAINER_V1_DESIGN.md](docs/MAINTAINER_V1_DESIGN.md)。
