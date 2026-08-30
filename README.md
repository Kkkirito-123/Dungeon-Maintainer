# Dungeon Maintainer 1.0

Dungeon Maintainer 是 SQL Dungeon（`SELECT * FROM DUNGEON`）专用的本地 Coding Agent。
它复用 Pi RPC 作为 Agent 内核，在一个本地 Chromium Shell 中同时展示 Pi 风格聊天 CLI 和
worktree 中的真实游戏。正式游戏仓库只有在用户显式执行 `/apply` 后才会改变。

维护器刻意保持单循环：一条请求进入一个 Pi Agent Loop，没有隐藏规划器、自动续跑、架构路由或
跨任务方案索引。当前任务 Evidence、全部领域工具、安全门禁和前端可见能力继续保留。

```text
单个 Chromium Shell
├─ 左侧：Pi 风格聊天 CLI
├─ 右侧：游戏实机 iframe
└─ 底部：上下文、Token、任务和运行状态
        ↓
Pi RPC + Dungeon Maintainer Extension
  ├─ inspect / edit / check / finish / workspace
  ├─ look / act / query
  ├─ detached worktree + 固定检查
  └─ Vite + Playwright iframe + 检查点重放
        ↓
      用户 /apply
        ↓
  正式游戏工作区（不自动提交）
```

维护器与游戏保持两个独立仓库。1.0 固定为单 Agent、单 Pi、单活动 worktree、单 Vite 和单浏览器会话；
历史任务和其他合法 worktree 可持久化并在 Shell 中切换，切换时旧 Pi 会先停止，不会后台继续调用模型。
不提供公网 Dashboard、Electron、面向用户的任意终端、多 Agent、自动提交、推送、PR、部署或长期记忆。
任意 Pi 原生工具和 Bash 均不加载；方案确认后只开放维护器自有的受限 `edit`。

核心代码按单一职责分区：`src/app.ts` 是公开入口，`src/app/` 分别拥有仓库事实、Pi 进程、
任务生命周期与 start/resume；`src/pi/extension.ts` 只做 Pi 装配，会话安全策略和游戏运行时分别
位于 `session-policy.ts` 与 `game-runtime.ts`。游戏开发桥也将投影、导航、固定动作和查询执行拆开，
`bridge.ts` 只组合协议生命周期。外部命令和 Pi 工具/命令不因内部拆分改变；浏览器驱动优先消费
当前桥协议统一为 1.0，不接受其它桥协议。

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
MAINTAINER_MODEL=deepseek-v4-pro
MAINTAINER_CONTEXT_WINDOW=64000
MAINTAINER_MAX_TOKENS=4096
MAINTAINER_REASONING=true
```

进程环境变量优先于维护器 `.env`。模型、接口、上下文、输出上限和推理能力只有这一套
`MAINTAINER_*` 配置源；不再存在模型档案、`profiles.json` 或运行时模型切换。密钥只通过环境传给
Pi Provider，不进入命令行、`task.json`、事件日志、浏览器或补丁文件。

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

Pi 启动时固定使用 `--mode rpc`，不加载 Pi 原生工具，只显式加载维护器的 8 个领域工具，同时禁用外部 Extension、
Skill、Prompt Template 和上下文文件。Extension 默认只激活只读诊断工具；用户在 Shell 确认“病因 +
完整方案 + 验证方式”后，才为当前 Agent 运行临时开放 `edit`。Pi 内会在运行时真正替换会话前取消
`/new`、`/resume`、`/import`、`/fork`、`/clone` 和 `/tree`。模型固定来自进程启动时的
`MAINTAINER_MODEL`；Thinking 和压缩仍通过 Pi 原生 RPC 调整，Shell 以 Pi 返回状态为事实源。
Shell 与后端仅通过本机 HTTP/SSE 通信，API Key 不进入浏览器。

## Pi 内工具与命令

维护器只向模型注册以下 8 个领域工具。Pi 原生工具和 Bash 均不加载；源码读取、证据、编辑、
游戏操作和工作树切换都经过维护器自己的边界：

| 工具 | 作用 | 硬边界 |
|---|---|---|
| `inspect` | 查看状态、浅目录、搜索、分页文件、Diff，以及列出/回读当前任务 Evidence | 项目相对路径；read 默认 80 行、最多 160 行，单次最多 4 KiB |
| `edit` | 唯一文本替换、创建文本文件或整文件写入 | 当前 `baseHash`、realpath、精确授权路径、最多 3 文件/120 行、写前检查点与写后刷新重放 |
| `check` | 运行固定白名单检查 | 模型不能传命令、参数、cwd 或环境变量 |
| `finish` | 保存诊断、复现、总方案审批、修复结果或阻断结论 | `result` 自动执行固定检查、刷新重放和断言 |
| `workspace` | 列出或切换同一仓库的本地 Git worktree | 只接受枚举 ID；切换需确认并创建绑定目标树的新任务 |
| `look` | 读取带 revision、目标、前置说明和稳定 action ID 的玩家可见投影 | 不返回坐标、完整地图、背包、存档、隐藏答案或 Judge |
| `act` | 消费最新 revision 中的稳定动作，完成导航或固定可见交互 | 最多 64 个真实移动步；遇到 `E` 交互停止；旧修订、不可用动作和连续无进展明确失败 |
| `query` | 写入 SQL 并提交当前可见终端 | 先写固定 textarea，再点击真实执行按钮；SQL 仅在进程内用于重放 |

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
2. Agent 在只读阶段使用 `inspect` 和 `look/act/query` 定位并复现。
3. 运行时问题通过 `finish(status=reproduced)` 保存检查点后的语义动作、期望、实际、证据和结构化结果断言；
   构建、类型或测试问题以失败的固定检查作为复现证据。
4. Agent 形成唯一病因后直接使用 `edit` 做精确替换、创建或整文件写入；第一次写入时 Shell 按目标文件询问一次是否允许修改。
   需要提前说明多文件方案时仍可用 `finish(status=proposed)`；拒绝时不开放写入能力。
5. 用户确认后，原始写入调用继续执行，本轮在批准范围内自然完成修改，不重复询问同一文件。
   编辑后的实际 Git 增量会同步到任务记录，旧验证立即失效。
6. 第一字节写入前保存临时浏览器检查点。写入 worktree 后等待 Vite 更新，刷新页面、消费检查点，
   重新建立同一起点检查点并重放相同语义动作。
7. Agent 修改完成后默认自然结束，用户稍后用 `/verify` 运行固定检查、恢复重放和 hidden judge 断言；用户明确要求立即验证时，Agent 才调用 `finish(status=result)` 完成同一流程。
8. 用户执行 `/apply`。维护器重新检查来源工作树仍与启动快照完全一致、HEAD、目标文件 Hash、
   worktree Hash 和 `git apply --check`，成功后只写入 Agent 增量。

## 权限与数据边界

- 所有 Agent 写入只发生在 detached worktree。
- 来源工作树允许已有修改；快照期间若继续变化会阻断启动，任务期间漂移会阻断 `/apply`。
- 总方案授权绑定当前 `taskId + baseHead + 病因 + 完整步骤 + 验证方式`，只覆盖当前 Agent 运行；
  运行结束自动恢复只读诊断工具。
- 维护器 `edit` 执行路径、`realpath`、`baseHash`、唯一匹配、精确授权和预算校验；写入只发生在
  当前 detached worktree，正式仓库仍只有 `/apply` 能写入。
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

任务只接受当前 schema v4。旧任务不迁移，`resume` 会要求使用 `start` 创建 1.0 任务。

## 游戏开发桥

目标游戏仓库必须实现协议 1.0 开发桥。桥只有在以下条件同时成立时安装：

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

Dungeon Maintainer 现在只有一条产品线：单 Pi Loop、固定工具、当前任务 Evidence 和确定性安全门禁。
代码地图、命名规则和新手阅读顺序见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 统一 Chromium Shell

当前 1.0 使用一个本地 Chromium Shell，不再把聊天和游戏分成两个窗口：

    单个 Chromium 窗口
    ├─ 左侧：Pi RPC 驱动的聊天 CLI
    ├─ 中间：可拖动分隔条
    ├─ 右侧：worktree 游戏 iframe
    └─ 底部：上下文、Token、任务和运行状态

Chromium 以 App 模式启动，不显示标签栏和地址栏；Playwright 使用临时 Profile，并让页面视口
跟随真实窗口尺寸。用户缩放窗口或拖动分隔条时，聊天输入框、状态栏和游戏 iframe 都保持在窗口内。

左侧输入发送后会立即出现固定“当前动作”栏，不依赖模型先生成文字。它依次显示等待 Pi、读取游戏
状态、复现、定位代码、修改 worktree、验证、生成结论或等待方案确认，并每 5 秒更新已用时间。
同一条活动只更新原位置，不追加聊天气泡，也不产生模型 Token；当前回合中可以通过输入框发送 Pi
原生 steer 追加要求，也可以“停止本轮”。新请求和固定命令仍要等 `agent_settled`，不会并发进入同一 Pi 会话。

界面代码集中保存在维护器的 src/shell 文件夹，避免散落到 app、Pi 和 game 模块：

    src/shell/
    ├─ protocol.ts  # 状态栏、SSE 事件和确认框契约
    ├─ server.ts    # 127.0.0.1 HTTP/SSE、令牌校验和事件缓存
    └─ page.ts      # 聊天、游戏 iframe、拖拽分栏和状态栏

Shell 只展示低敏摘要，不传输 API Key、完整 Prompt、thinking、SQL、管理员答案、隐藏裁判
或浏览器帧。底部严格固定两排并各自横向滚动：第一排是工作树、任务、阶段、模型、Thinking 和上下文，
第二排是本轮/会话 Token、缓存、工具调用次数、运行时、Diff 和验证。工作树按钮可展开合法 worktree、
可恢复任务和当前 detached worktree 文件树。游戏 iframe 由同一个 Chromium Context 中的 Playwright
驱动，修改后执行检查点、刷新、恢复和语义重放。

## 内置 Eval

`pnpm eval` 把真实故障场景物化到独立仓库，启动正常 Maintainer 修复，并在第一次真实
`agent_settled` 时结束 Agent 回合。Profile 停止 Pi、Shell 并卸载本轮工具后，正式 Run 只在
候选工作区执行一次隐藏的 after browser Oracle。它不比较代码、Diff 或参考实现，也不调用第二个模型。
故障已成功物化是运行前提；PASS 只要求 Agent 正常 settled 且 after Oracle 命中。现场演示和 CI
共用一个 Runner；结果 schema v7 分开统计 Agent Token、Agent 工具调用和 Agent/Oracle/Run/Suite 耗时。

```powershell
pnpm eval -- suite `
  --profile maintainer `
  --workers 2 `
  --dependencies "C:\path\to\select-from-dungeon" `
  --ui progress
```

Benchmark 场景由 `--dependencies` 指定的当前游戏仓库中的 `scripts/benchmark-adapter.mjs`
实时列出；每次 Run 都从当下工作树生成独立临时仓库并注入故障，不修改真实游戏分支。物化目标只
复用已安装的 `game/node_modules`，不会复制隐藏 benchmark 数据。单 Profile 默认并行 2 个独立
Worker，公平对比默认 1 个；每个 Run 拥有独立的 Workspace、Pi Session、Vite 和 Chromium。
Eval 复用当前 Key 与 Base URL，被测 Agent 和 Pi Baseline 默认使用 `deepseek-v4-flash`，可用
`DUNGEON_EVAL_MODEL` 显式选择同一模型，并始终关闭 reasoning；这不改变生产默认模型。`preflight` 是显式的零模型校准：确认故障版命中失败 Oracle、
干净版命中通过 Oracle；它不阻塞 `run`、`suite` 或 `compare`，正式 Run 仍只执行一次候选 after Oracle。
目录分层、判定边界、统计口径、版本指纹和断点恢复见 [docs/EVAL.md](docs/EVAL.md)。

### 7 场真实 Benchmark

当前游戏 Adapter `full` 套件的实测结果如下。四组都关闭 reasoning；公平的 Pro 对比和 Pi Flash
基线使用单 Worker。Maintainer Flash 使用 2 个 Worker，并在中断后通过 `--resume` 继续，因而它的
通过率、Token 和工具调用可比较，但累计耗时不能与三个单 Worker 结果严格横向比较。

| 方案 | 模型 | Workers | 通过 | Timeout | 总 Token | 缓存命中率 | 工具调用 | 累计 Run 耗时 | 平均 Run |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Dungeon Maintainer | Flash | 2 | **7/7** | 0 | **3,667,555** | 95.14% | **226** | 1,550.786s | **221.541s** |
| Dungeon Maintainer | Pro | 1 | **7/7** | 0 | 4,662,858 | 95.67% | 254 | 1,890.915s | 270.131s |
| Pi 原版 Baseline | Pro | 1 | **7/7** | 0 | 9,975,944 | 94.26% | 317 | 2,680.705s | 382.958s |
| Pi 原版 Baseline | Flash | 1 | **2/7** | **5** | 9,796,788 | 96.17% | 355 | 3,929.883s | 561.412s |

每个明细单元格依次为 `结果 / Token / 缓存命中率 / 工具调用 / Run 耗时`：

| 场景 | Maintainer Flash | Maintainer Pro | Pi 原版 Pro | Pi 原版 Flash |
|---|---|---|---|---|
| `terminal-action-bug` | 通过 / 367,095 / 92.94% / 26 / 139.541s | 通过 / 597,521 / 94.71% / 31 / 216.319s | 通过 / 2,050,118 / 92.02% / 57 / 518.079s | 通过 / 678,913 / 95.35% / 35 / 505.403s |
| `accepted-query-without-progress` | 通过 / 431,384 / 94.20% / 31 / 252.097s | 通过 / 718,144 / 96.14% / 39 / 203.730s | 通过 / 636,671 / 95.66% / 33 / 230.444s | 通过 / 987,840 / 95.71% / 37 / 315.838s |
| `final-stage-boss-stuck-at-one-hp` | 通过 / 292,238 / 93.75% / 25 / 264.581s | 通过 / 460,351 / 95.22% / 26 / 276.167s | 通过 / 887,680 / 96.03% / 33 / 225.708s | **timeout** / 1,112,392 / 97.23% / 48 / 621.412s |
| `admin-floor-transition-deadlock` | 通过 / 798,980 / 96.16% / 42 / 307.311s | 通过 / 679,837 / 95.33% / 38 / 340.768s | 通过 / 1,343,521 / 91.88% / 43 / 392.968s | **timeout** / 3,353,168 / 96.89% / 94 / 620.410s |
| `transition-lost-after-reload` | 通过 / 778,869 / 96.37% / 35 / 184.844s | 通过 / 936,003 / 96.41% / 43 / 283.846s | 通过 / 2,043,908 / 95.55% / 58 / 567.158s | **timeout** / 1,618,725 / 94.27% / 59 / 620.285s |
| `stale-query-plan-evidence` | 通过 / 624,037 / 95.32% / 36 / 193.503s | 通过 / 818,892 / 95.95% / 45 / 279.379s | 通过 / 1,872,357 / 94.13% / 54 / 466.116s | **timeout** / 1,451,540 / 97.15% / 44 / 626.066s |
| `duplicate-final-victory-commit` | 通过 / 374,952 / 94.37% / 31 / 208.909s | 通过 / 452,110 / 95.12% / 32 / 290.706s | 通过 / 1,141,689 / 96.78% / 39 / 280.232s | **timeout** / 594,210 / 94.54% / 38 / 620.469s |

在同为单 Worker 且 7/7 通过的 Pro 对比中，Maintainer 相比 Pi 原版减少 53.26% Token、
19.87% 工具调用和 29.46% 累计 Run 耗时。缓存命中率只表示输入复用比例；Pi Flash 在 5 个
超时循环中也会持续命中缓存，因此不能单独作为效率或成功率指标。

模型上下文保留 Pi 原生 Session 历史和 compact。维护器不设置请求级工具次数或 Token 强制上限；
自动重试、compact、steer、abort 和自然结束保持 Pi 原生语义。每条自然语言输入发送前仍执行
确定性的上下文预算检查，必要时先使用 Pi compact。
