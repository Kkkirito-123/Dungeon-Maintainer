# Dungeon Maintainer V1

Dungeon Maintainer 是 SQL Dungeon（`SELECT * FROM DUNGEON`）专用的本地 Coding Agent。
它复用 Pi RPC 作为 Agent 内核，在一个本地 Chromium Shell 中同时展示 Pi 风格聊天 CLI 和
worktree 中的真实游戏。正式游戏仓库只有在用户显式执行 `/apply` 后才会改变。

```text
单个 Chromium Shell
├─ 左侧：Pi 风格聊天 CLI
├─ 右侧：游戏实机 iframe
└─ 底部：上下文、Token、任务和运行状态
        ↓
Pi RPC + Dungeon Maintainer Extension
  ├─ inspect / patch / check / finish
  ├─ look / go / use / query
  ├─ detached worktree + 固定检查
  └─ Vite + Playwright iframe + 检查点重放
        ↓
      用户 /apply
        ↓
  正式游戏工作区（不自动提交）
```

维护器与游戏保持两个独立仓库。V1 固定为单 Agent、单任务、单 worktree 和单浏览器会话，
不提供公网 Dashboard、Electron、通用 Shell、多 Agent、自动提交、推送、PR、部署或长期记忆。

核心代码按单一职责分区：`src/app.ts` 只保留稳定导出，`src/app/` 分别拥有仓库事实、Pi 进程、
任务生命周期与 start/resume；`src/pi/extension.ts` 只做 Pi 装配，会话安全策略和游戏运行时分别
位于 `session-policy.ts` 与 `game-runtime.ts`。游戏开发桥也将投影、导航、固定动作和查询执行拆开，
`bridge.ts` 只组合协议生命周期。外部命令、Pi 工具/命令和协议 v2 均未因内部拆分改变。

## 环境要求

- Node.js `>=22.19`
- pnpm `11.9.0`
- Git
- `rg`
- 游戏仓库已执行 `pnpm --dir game install --frozen-lockfile`
- Playwright Chromium 已安装

安装与构建：

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm build
```

构建后查看帮助：

```powershell
node dist/src/main.js --help
```

需要全局命令时，可在维护器仓库执行 `pnpm link --global`。

## 配置

维护器只读取自身仓库 `.env` 或当前进程中的 `MAINTAINER_*`，不会读取目标游戏仓库的
`.env`、Python Agent 配置或浏览器数据：

```text
MAINTAINER_API_KEY=
MAINTAINER_BASE_URL=https://api.deepseek.com/v1
MAINTAINER_MODEL=deepseek-chat
MAINTAINER_CONTEXT_WINDOW=64000
MAINTAINER_MAX_TOKENS=4096
```

进程环境变量优先于维护器 `.env`。API Key 只通过环境传给 Pi Provider，不进入命令行、
`task.json`、事件日志或补丁文件。

## 启动与恢复

游戏仓库必须是干净 Git 工作区，并包含严格项目标识：

```json
{
  "schemaVersion": 1,
  "adapter": "sql-dungeon"
}
```

新建任务：

```powershell
dungeon-maintain start --repo "C:\path\to\select-from-dungeon"
```

恢复原任务：

```powershell
dungeon-maintain resume <task-id>
```

`start` 记录正式仓库 `baseHead`，在维护器数据目录创建 detached worktree 和 Pi 会话目录，
然后以该 worktree 为 `cwd` 启动项目固定版本 Pi RPC，并打开一个本地 Chromium Shell。
Shell 左侧是聊天输入，右侧 iframe 显示同一个 worktree 的游戏，拖动中间分隔条即可调整比例。
`resume` 不会静默创建新 worktree 或新会话；
任务记录、正式仓库 HEAD、worktree HEAD、Pi session-id、session-dir 或首行 cwd 任一漂移都会阻断。

Pi 启动时固定使用 `--mode rpc`，禁用内置工具、外部 Extension、Skill、Prompt Template 和上下文文件，只加载维护器
Extension。Pi 内会在运行时真正替换会话前取消 `/new`、`/resume`、`/import`、`/fork`、`/clone`
和 `/tree`；用户选择其他模型时会立即恢复任务固定模型，避免聊天、补丁和 worktree 脱离当前任务。
Shell 与后端仅通过本机 HTTP/SSE 通信，API Key 不进入浏览器。

## Pi 内工具与命令

模型只能使用八个工具：

| 工具 | 作用 | 硬边界 |
|---|---|---|
| `inspect` | 查看状态、浅目录、搜索、分页文件和 Diff | 项目相对路径；每次最多 400 行或 8 KiB |
| `patch` | 唯一文本替换或创建文本文件 | `baseHash`、唯一匹配、最多 3 文件/120 行、核心审批 |
| `check` | 运行固定白名单检查 | 模型不能传命令、参数、cwd 或环境变量 |
| `finish` | 保存诊断、复现、修复结果或阻断结论 | 不替代 `/verify` 或 `/apply` |
| `look` | 读取玩家可见游戏投影 | 不返回完整地图、SQL、答案、存档或隐藏裁判 |
| `go` | 前往主线目标或最近 frontier | 桥内 BFS；每次最多 64 个真实移动步 |
| `use` | 执行视图提供的稳定动作 ID | 不接受选择器、坐标或脚本 |
| `query` | 提交桥内预选答案 | 不接受或返回 SQL；仍经过真实 SQLite 与游戏判定 |

用户可使用五个命令：

| 命令 | 作用 |
|---|---|
| `/play` | 聚焦游戏；存在活动复现时从检查点重放相同步骤 |
| `/diff` | 显示当前 worktree 补丁 |
| `/verify` | 运行固定检查，恢复检查点并重放复现，封装补丁 |
| `/apply` | 再次确认后写回正式工作区，但不提交 |
| `/discard` | 保存最终 Diff，标记放弃并在 Pi 退出后删除 worktree |

## 标准修复闭环

1. 用户在 Pi CLI 中描述问题。
2. Agent 使用 `inspect` 定位候选代码，并用 `look/go/use/query` 操作右侧真实游戏。
3. 运行时问题通过 `finish(status=reproduced)` 保存检查点后的语义动作、期望、实际和证据；
   构建、类型或测试问题以失败的固定检查作为复现证据。
4. `patch` 完成路径、realpath、Hash、预算、隐私和唯一匹配检查；核心路径在写入前显示 Pi 确认框。
5. 第一字节写入前保存临时浏览器检查点。写入 worktree 后等待 Vite 更新，刷新页面、消费检查点，
   重新建立同一起点检查点并重放相同语义动作。
6. 用户执行 `/verify`。只有固定检查和复现重放均通过，任务才进入 `ready_to_apply`。
7. 用户执行 `/apply`。维护器重新检查正式仓库洁净度、HEAD、目标文件 Hash、worktree Hash 和
   `git apply --check`，成功后只修改正式工作区。

## 权限与数据边界

- 所有 Agent 写入只发生在 detached worktree。
- 领域、内容、契约、基础设施、应用入口、开发桥、Agent、脚本、CI 和根配置属于核心路径，
  每次修改都绑定 `taskId + baseHead + 精确路径 + 修改摘要` 一次性审批。
- 游戏文档、测试和小型展示层可自动修改。
- `.git`、`.env*`、凭据、法律文件、`node_modules`、`dist`、缓存、二进制和仓库外路径永久禁止写入。
- 路径检查使用 `realpath`，仓库内符号链接或 junction 指向仓库外同样拒绝。
- 日志不保存 API Key、模型正文、SQL、答案、完整地图、正式存档、背包、身份或浏览器帧。

本地数据默认位于 `%LOCALAPPDATA%\dungeon-maintainer\`：

```text
tasks/<task-id>/
├─ task.json
├─ events.jsonl
├─ pi/
├─ reproductions/
├─ checks/
├─ patch.diff
└─ reverse.diff

worktrees/<task-id>/
```

旧 schema v1 任务不会自动迁移；`resume` 会给出明确错误。

## 游戏开发桥

目标游戏仓库需要实现协议 v2 的开发桥。桥只有在以下条件同时成立时安装：

- `import.meta.env.DEV`
- 页面主机为 `127.0.0.1`、`localhost` 或 `[::1]`
- URL 包含 `?playtest=agent`

试玩模式使用页面内存 DataStore、临时 Chromium Context 和一次性 `sessionStorage` 检查点，
不读取正式 IndexedDB、localStorage Run/Profile 或用户 Chrome Profile，并关闭游戏的外部 Agent
请求。生产构建必须裁掉桥模块，构建后可执行：

```powershell
rg --fixed-strings "__DUNGEON_PLAYTEST__" game/dist
```

预期无匹配。

## 固定检查

维护器登记的检查 ID：

```text
rules-test
rules-validate
agent-test
game-test
game-architecture
game-build
```

修改 `game/src/` 时，`/verify` 固定要求游戏测试、架构检查和生产构建。检查记录绑定完整
worktree Hash；源码变化后旧结果不会复用。

维护器仓库验证：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

详细设计见 [docs/MAINTAINER_V1_DESIGN.md](docs/MAINTAINER_V1_DESIGN.md)。

## 统一 Chromium Shell

当前 V1 使用一个本地 Chromium Shell，不再把聊天和游戏分成两个窗口：

    单个 Chromium 窗口
    ├─ 左侧：Pi RPC 驱动的聊天 CLI
    ├─ 中间：可拖动分隔条
    ├─ 右侧：worktree 游戏 iframe
    └─ 底部：上下文、Token、任务和运行状态

界面代码集中保存在维护器的 src/shell 文件夹，避免散落到 app、Pi 和 game 模块：

    src/shell/
    ├─ protocol.ts  # 状态栏、SSE 事件和确认框契约
    ├─ server.ts    # 127.0.0.1 HTTP/SSE、令牌校验和事件缓存
    └─ page.ts      # 聊天、游戏 iframe、拖拽分栏和状态栏

Shell 只展示低敏摘要，不传输 API Key、完整 Prompt、thinking、SQL、管理员答案、隐藏裁判
或浏览器帧。游戏 iframe 由同一个 Chromium Context 中的 Playwright 驱动，修改后执行检查点、
刷新、恢复和语义重放。
