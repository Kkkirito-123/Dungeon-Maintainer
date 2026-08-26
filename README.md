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

维护器与游戏保持两个独立仓库。V1 固定为单 Agent、单 Pi、单活动 worktree、单 Vite 和单浏览器会话；
历史任务和其他合法 worktree 可持久化并在 Shell 中切换，切换时旧 Pi 会先停止，不会后台继续调用模型。
不提供公网 Dashboard、Electron、面向用户的任意终端、多 Agent、自动提交、推送、PR、部署或长期记忆。
任意 Bash 不加载；方案确认后只开放隔离 worktree 内的 `edit/write` 和受限 `patch`。

核心代码按单一职责分区：`src/app.ts` 只保留稳定导出，`src/app/` 分别拥有仓库事实、Pi 进程、
任务生命周期与 start/resume；`src/pi/extension.ts` 只做 Pi 装配，会话安全策略和游戏运行时分别
位于 `session-policy.ts` 与 `game-runtime.ts`。游戏开发桥也将投影、导航、固定动作和查询执行拆开，
`bridge.ts` 只组合协议生命周期。外部命令和 Pi 工具/命令不因内部拆分改变；浏览器驱动优先消费
协议 v3，同时保留协议 v2 兼容。

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
MAINTAINER_REASONING=true
```

进程环境变量优先于维护器 `.env`。首版模型档案保存在维护器数据目录的
`settings/profiles.json`，只包含名称、OpenAI-compatible 地址、模型 ID、上下文、输出上限和
推理支持；Windows 上的 API Key 写入凭据管理器，开发环境仍可用环境变量。密钥只通过环境传给
Pi Provider，不进入命令行、`task.json`、事件日志或补丁文件。

## 启动与恢复

游戏仓库必须包含严格项目标识和可用运行依赖；来源工作树允许已有未提交修改，维护器会把它们
快照到隔离 worktree 的 index 基线：

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

`start` 记录来源工作树的 `baseHead` 和完整快照 Hash，在维护器数据目录创建 detached worktree 和
Pi 会话目录。来源树可以有未提交修改：维护器把它们复制到隔离树的 Git index 作为快照基线，
Agent 后续普通 Diff 只包含新增修改。随后以隔离树为 `cwd` 启动固定版本 Pi RPC 并打开 Chromium Shell。
Shell 左侧是聊天输入，右侧 iframe 显示同一个 worktree 的游戏，拖动中间分隔条即可调整比例。
`resume` 不会静默创建新 worktree 或新会话；
任务记录、正式仓库 HEAD、worktree HEAD、Pi session-id、session-dir 或首行 cwd 任一漂移都会阻断。

Pi 启动时固定使用 `--mode rpc`，显式加载 Pi 原生 Coding 工具和维护器领域工具，同时禁用外部 Extension、
Skill、Prompt Template 和上下文文件。Extension 默认只激活只读诊断工具；用户在 Shell 确认“病因 +
完整方案 + 验证方式”后，才为当前 Agent 运行临时开放 `edit/write/patch`。Pi 内会在运行时真正替换会话前取消
`/new`、`/resume`、`/import`、`/fork`、`/clone` 和 `/tree`。模型、Thinking 和压缩通过 Pi 原生 RPC
切换，Shell 以 Pi 返回状态为事实源；保存并启用新的模型档案时才会重启这一唯一 Pi。
Shell 与后端仅通过本机 HTTP/SSE 通信，API Key 不进入浏览器。

## Pi 内工具与命令

维护器提供十个领域工具，并只复用 Pi 原生 `edit/write`。原生 `read/grep/find/ls` 不加载；源码读取、
搜索、目录和 Diff 统一通过安全 `inspect`：

| 工具 | 作用 | 硬边界 |
|---|---|---|
| `inspect` | 查看状态、浅目录、搜索、分页文件和 Diff | 项目相对路径；read 默认 80 行、最多 160 行，单次最多 4 KiB |
| `patch` | 唯一文本替换或创建文本文件 | `baseHash`、唯一匹配、最多 3 文件/120 行、核心审批 |
| `check` | 运行固定白名单检查 | 模型不能传命令、参数、cwd 或环境变量 |
| `finish` | 保存诊断、复现、总方案审批、修复结果或阻断结论 | `result` 自动执行固定检查、刷新重放和断言 |
| `look` | 读取玩家可见游戏投影 | 终端打开时包含题面、schema、当前 textarea SQL、状态、结果与计划；不返回隐藏答案或完整地图 |
| `go` | 前往主线目标或最近 frontier | 桥内 BFS；每次最多 64 个真实移动步 |
| `use` | 执行视图提供的稳定动作 ID | 不接受选择器、坐标或脚本 |
| `input_sql` | 填写当前终端 textarea | 只写固定玩家输入框，不执行查询、不接受选择器或脚本 |
| `query` | 提交当前终端 textarea | 不接受 SQL 参数；点击真实执行按钮并经过 AppShell、SQLite 与游戏判定 |
| `tree` | 列出或切换同一仓库的本地工作树 | 只接受枚举 ID；切换需确认并创建绑定目标树的新任务 |

用户可使用五个命令：

| 命令 | 作用 |
|---|---|
| `/play` | 聚焦游戏；存在活动复现时从检查点重放相同步骤 |
| `/diff` | 显示当前 worktree 补丁 |
| `/verify` | 运行固定检查，恢复检查点并重放复现，封装补丁 |
| `/apply` | 再次确认后写回正式工作区，但不提交 |
| `/discard` | 保存最终 Diff，标记放弃并在 Pi 退出后删除 worktree |

## 标准修复闭环

1. 用户在 Shell 左侧描述问题。
2. Agent 在只读阶段使用 `inspect` 和 `look/go/use/input_sql/query` 定位并复现。
3. 运行时问题通过 `finish(status=reproduced)` 保存检查点后的语义动作、期望、实际、证据和结构化结果断言；
   构建、类型或测试问题以失败的固定检查作为复现证据。
4. Agent 形成唯一病因后，用 `finish(status=proposed)` 一次提交完整修复方案、验证方式和风险；Shell
   询问是否执行。拒绝时不开放任何写入能力。
5. 用户确认后，本轮开放 Pi 原生 `edit/write` 和精确 `patch`，Agent 一次完成方案，不重复询问。
   原生编辑后的实际 Git 增量会同步到任务记录，旧验证立即失效。
6. 第一字节写入前保存临时浏览器检查点。写入 worktree 后等待 Vite 更新，刷新页面、消费检查点，
   重新建立同一起点检查点并重放相同语义动作。
7. Agent 调用 `finish(status=result)` 自动运行固定检查、恢复重放和 hidden judge 断言；全部通过才进入 `ready_to_apply`。`/verify` 只用于人工重试。
8. 用户执行 `/apply`。维护器重新检查来源工作树仍与启动快照完全一致、HEAD、目标文件 Hash、
   worktree Hash 和 `git apply --check`，成功后只写入 Agent 增量。

## 权限与数据边界

- 所有 Agent 写入只发生在 detached worktree。
- 来源工作树允许已有修改；快照期间若继续变化会阻断启动，任务期间漂移会阻断 `/apply`。
- 总方案授权绑定当前 `taskId + baseHead + 病因 + 完整步骤 + 验证方式`，只覆盖当前 Agent 运行；
  运行结束自动恢复只读诊断工具。
- 维护器 `patch` 仍执行路径、`realpath`、`baseHash`、唯一匹配和预算校验；Pi 原生工具没有操作系统
  沙箱，因此 Prompt 明确要求它只能修改当前 detached worktree。正式仓库仍只有 `/apply` 能写入。
- `.git`、`.env*`、凭据、法律文件、`node_modules`、`dist`、缓存和二进制不属于修复方案允许范围。
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

schema v2 任务会在 `resume`/读取时自动迁移到 v3；旧 schema v1 任务不会迁移，`resume` 会给出明确错误。

## 游戏开发桥

目标游戏仓库需要实现协议 v2 或 v3 的开发桥。当前游戏使用 v3，维护器保留 v2 兼容。桥只有在以下条件同时成立时安装：

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

Chromium 以 App 模式启动，不显示标签栏和地址栏；Playwright 使用临时 Profile，并让页面视口
跟随真实窗口尺寸。用户缩放窗口或拖动分隔条时，聊天输入框、状态栏和游戏 iframe 都保持在窗口内。

左侧输入发送后会立即出现固定“当前动作”栏，不依赖模型先生成文字。它依次显示等待 Pi、读取游戏
状态、复现、定位代码、修改 worktree、验证、生成结论或等待方案确认，并每 5 秒更新已用时间。
同一条活动只更新原位置，不追加聊天气泡，也不产生模型 Token；当前回合完成前输入框会暂时禁用，
避免重复消息并发进入同一个 Pi 会话。

界面代码集中保存在维护器的 src/shell 文件夹，避免散落到 app、Pi 和 game 模块：

    src/shell/
    ├─ protocol.ts  # 状态栏、SSE 事件和确认框契约
    ├─ server.ts    # 127.0.0.1 HTTP/SSE、令牌校验和事件缓存
    └─ page.ts      # 聊天、游戏 iframe、拖拽分栏和状态栏

Shell 只展示低敏摘要，不传输 API Key、完整 Prompt、thinking、SQL、管理员答案、隐藏裁判
或浏览器帧。底部严格固定两排并各自横向滚动：第一排是工作树、任务、阶段、模型、Thinking 和上下文，
第二排是本轮/会话 Token、缓存、工具预算、运行时、Diff 和验证。工作树按钮可展开合法 worktree、
可恢复任务和当前 detached worktree 文件树。游戏 iframe 由同一个 Chromium Context 中的 Playwright
驱动，修改后执行检查点、刷新、恢复和语义重放。

## Benchmark 与 Token 门禁

`pnpm benchmark` 默认使用真实 HTTP/SSE Shell 和受控 Pi 事件，不调用模型；传入
`--repo` 后再启动真实 Vite 与无头 Chromium，验证首个终端的玩家可见投影、一次空输入拒绝，以及
短复现窗口的检查点恢复与同动作重放；它不依赖隐藏答案。详细指标和真实 Pi 任务分析见
[docs/BENCHMARK.md](docs/BENCHMARK.md)。

内置回归样本位于 [test-fixtures](test-fixtures/)，分为可物化的 `agent-evals` 仓库 fixture 和
不启动模型的 `smoke-tasks` 生命周期 fixture；使用方式、目录约束和新增的续跑/终态 token 指标见
[Benchmark 文档](docs/BENCHMARK.md#内置-fixture)。

发给模型的临时上下文会优先保留最新游戏/源码证据并对完全重复的工具结果去重，单个临时工具结果
最多约 2.25 KiB，单轮所有临时工具结果最多约 20 KiB；原始 session 和证据文件不改写。底部状态栏分开显示本轮与会话 input/cache/output 及缓存命中率。
每条自然语言输入发送前还会刷新 Pi 的上下文用量；预计超过状态栏“安全线”时先同步压缩，压缩后
仍超线才拒绝发送。安全线同时预留 25% 上下文和当前模型最大输出空间，不新增模型调用。
