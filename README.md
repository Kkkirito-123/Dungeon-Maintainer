# Dungeon Maintainer

Dungeon Maintainer 是面向 SQL Dungeon 的本地代码维护 Agent。它使用 Pi Core 组织模型回合，
但把文件权限、核心审批、Git 检查点、固定检查和浏览器试玩放在确定性代码中执行。

它适合完成以下工作：

- 只读诊断一个明确的游戏问题；
- 在 detached Git worktree 中生成小型补丁；
- 运行项目登记的测试、架构检查和构建；
- 用真实 Chromium 确定性试玩单层或全部八层；
- 在用户显式执行 `apply` 后，把已验证补丁应用到目标工作区。

它不是通用 Coding Agent，不提供 Shell、任意文件写入、自动提交、推送、PR、数据库或 Web 服务。
SQL Dungeon 的 Campfire、Scribe 和 Main 在线 Agent 仍由游戏仓库中的 Python 服务负责。

## 环境要求

- Node.js `>=22.19`
- pnpm `11.9.0`
- Git
- Python 与 SQL Dungeon 自身依赖，用于运行原仓库检查
- `rg`，用于 `inspect search`
- Chromium，仅在运行 `play` 时需要

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

可以从 [.env.example](.env.example) 查看字段，但程序不会自动加载 `.env`。请通过当前终端或
受信任的进程管理器注入配置。Key 只存在于模型 Provider 的内存闭包中，不写入任务、日志、
截图或报告。缺少 Key 时，`diagnose` 和 `fix` 返回 `BLOCKED_ENV`；`status`、`apply`、`revert`
和不调用模型的 `play` 仍可工作。

## 命令

```powershell
dungeon-maintain
dungeon-maintain diagnose --repo "C:\path\to\sql-dungeon" "检查第一层主路线"
dungeon-maintain fix --repo "C:\path\to\sql-dungeon" "修复一个展示层问题"
dungeon-maintain approve <task-id> <token>
dungeon-maintain status <task-id>
dungeon-maintain apply <task-id>
dungeon-maintain revert <task-id>
dungeon-maintain play --repo "C:\path\to\sql-dungeon" --floor 1
dungeon-maintain play --repo "C:\path\to\sql-dungeon" --suite game-v1
```

`fix` 要求目标 Git 工作区干净。它只修改任务专用 worktree；目标分支在 `apply` 前不会变化。
如果计划触及领域规则、课程、存储、契约、入口、配置、依赖、试玩桥、线上 Agent 或其他核心
路径，任务会暂停并显示十分钟有效的批准 token。批准绑定 `taskId + baseHead + 精确文件清单`，
不能用于另一任务或扩大范围。

`apply` 会重新检查目标 HEAD、工作区和每个文件的基线 Hash；任何漂移都会拒绝应用。
`revert` 只撤销该任务已经应用且之后未被继续修改的补丁。二者都不会创建 Git commit。

## 五个工具

| 工具 | 职责 | 硬边界 |
|---|---|---|
| `inspect` | 状态、浅目录树、搜索、分页读取、Diff | 每次最多 400 行或 48 KiB；禁止凭据和仓库外路径 |
| `patch` | 唯一文本替换或许可路径中新建文本文件 | 必须带 `baseHash`；不删除、不移动、不覆盖二进制；每任务最多 3 文件、120 行 |
| `check` | 执行适配器登记的检查 | 模型只能选择固定 ID，不能传 Shell 或参数 |
| `play` | 运行单层或八层确定性实机试玩 | 模型不逐步移动，也看不到 SQL、地图、答案或隐藏裁判状态 |
| `finish` | 核验结论并生成报告和补丁 | `ready` 必须引用当前代码 Hash 下真实通过的检查 |

固定检查 ID 为：`rules-test`、`rules-validate`、`agent-test`、`game-test`、
`game-architecture`、`game-build`。

## 试玩方式

`play` 使用 SQL Dungeon 的开发态协议 v2 桥。桥必须同时满足开发构建、本机 HTTP 地址和
`?playtest=agent` 才会安装。Node Runner 只调用 `look/go/use/query/judge`；`query()` 没有 SQL
参数，管理员预选答案只在游戏进程内读取并通过真实编辑器提交。

路线规划使用游戏桥内部 BFS。一次宏移动最多执行 64 个真实步，遇到战斗、受伤、任务变化、
交互、楼层变化或阻塞就停止并重新规划；目标暂不可达时回退最近 frontier。单层失败会保存
证据并继续下一层。确定性执行器本身消耗 `0 Token`，只有维护 Agent 在收到压缩报告后进行的
诊断会消耗模型 Token。

每次试玩使用新的 Chromium Context 和临时内存 Run，不读取用户 Profile 或正式 IndexedDB。
报告只保留楼层计数、动作类型、公开界面尾迹和隐藏裁判的有限断言；SQL、参考答案、完整地图、
完整快照、背包、身份和 Key 不写入产物。

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
└─ play/

worktrees/<task-id>/
```

单任务上限为 20 个模型回合、40 次工具调用和 64000 个累计 Token。模型上下文约达到窗口
75% 时会压缩，但保留任务目标、Git 基线、批准路径、失败证据、修改文件和检查状态。进度日志
不会回灌模型上下文。`check` 和 `play` 只在完整 worktree Hash 相同的情况下复用缓存；任意代码
变化都会使缓存失效。

完整设计和安全理由见 [docs/MAINTAINER_V1_DESIGN.md](docs/MAINTAINER_V1_DESIGN.md)。
