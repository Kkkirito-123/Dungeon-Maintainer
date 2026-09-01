<div align="center">

<p><strong>简体中文</strong> | <a href="README.en.md">English</a></p>

<h1>Dungeon Maintainer</h1>

<h3>SQL Dungeon 专用的本地、安全门禁 Coding Agent</h3>

<p><em>在一个 Chromium Shell 中复现真实游戏问题，在隔离 worktree 中修复，并由用户决定何时应用或发布。</em></p>

<p>
  <a href="https://github.com/Kkkirito-123/Dungeon-Maintainer"><img src="https://img.shields.io/badge/GitHub-Code-181717?style=flat-square&logo=github" alt="GitHub repository"/></a>
  <img src="https://img.shields.io/badge/Version-1.0-2ea44f?style=flat-square" alt="Version 1.0"/>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 22.19 or newer"/>
  <img src="https://img.shields.io/badge/pnpm-11.9.0-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm 11.9.0"/>
  <img src="https://img.shields.io/badge/Agent-Single_Loop-2f6feb?style=flat-square" alt="Single Agent Loop"/>
</p>

</div>

<table>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/readme/edit-approval.png" alt="精确写入授权确认"/>
      <br/><sub><b>精确写入授权</b>：写入前展示本轮允许修改的文件</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/readme/repair-plan.png" alt="完整修复方案确认"/>
      <br/><sub><b>完整修复方案</b>：病因、步骤与验证方式一次确认</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="docs/assets/readme/worktree-diff.png" alt="隔离 worktree Diff"/>
      <br/><sub><b>隔离 Diff</b>：应用前查看 Agent 的完整增量</sub>
    </td>
    <td width="50%" align="center">
      <img src="docs/assets/readme/apply-confirmation.png" alt="应用补丁确认"/>
      <br/><sub><b>显式应用</b>：只修改正式工作区，不自动提交或部署</sub>
    </td>
  </tr>
</table>

## 📰 项目动态

- **2026-08-31**：加入窄域 `publish` 工具，经固定预览和用户确认后创建 GitHub PR，但不自动合并。
- **2026-08-31**：发布 7 场真实 Benchmark 的 Flash / Pro 与 Pi Baseline 对照结果。
- **2026-08-27**：发布 1.0，固定单 Agent、单 Pi、单活动 worktree、单 Vite 和单 Chromium Context。

## ✨ Dungeon Maintainer 是什么？

Dungeon Maintainer 是为 [SQL Dungeon（`SELECT * FROM DUNGEON`）](https://github.com/Kkkirito-123/Select-From-Dungeon) 构建的本地 Coding Agent。它复用 Pi RPC 作为 Agent 内核，在同一个 Chromium Shell 中并排展示聊天与隔离 worktree 内的真实游戏，让“观察、复现、修改、重放、验证”发生在同一条可审查链路上。

它刻意保持一个简单边界：一条用户请求只进入一个 Pi Agent Loop，没有隐藏规划器、自动续跑、多 Agent 路由或任意终端。

- **🎮 同窗复现**：左侧是 Pi 风格聊天，右侧是由 Playwright 驱动的游戏 iframe，底部统一展示任务、Token、Diff 与验证状态。
- **🔁 确定性闭环**：修改前记录浏览器检查点，写入后刷新、恢复检查点，并重放相同语义动作。
- **🧱 隔离修改**：Agent 只写 detached worktree；正式游戏仓库只接收经过 Hash 与补丁检查的 Agent 增量。
- **✅ 用户掌舵**：写入范围、完整方案、`/apply` 和 `publish` 都有显式确认；PR 创建后仍由用户决定是否合并。

## 📊 7 场真实 Benchmark

当前游戏 Adapter 的 `full` 套件覆盖 7 个真实故障场景。四组运行均关闭 reasoning；公平的 Pro 对比和 Pi Flash 基线使用单 Worker。Maintainer Flash 使用 2 个 Worker，并在中断后通过 `--resume` 继续，因此其通过率、Token 和工具调用可比较，累计耗时不与单 Worker 结果做严格横向比较。

| 方案 | 模型 | Workers | 通过 | Timeout | 总 Token | 缓存命中率 | 工具调用 | 累计 Run 耗时 | 平均 Run |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Dungeon Maintainer | Flash | 2 | **7/7** | 0 | **3,667,555** | 95.14% | **226** | 1,550.786s | **221.541s** |
| Dungeon Maintainer | Pro | 1 | **7/7** | 0 | 4,662,858 | 95.67% | 254 | 1,890.915s | 270.131s |
| Pi 原版 Baseline | Pro | 1 | **7/7** | 0 | 9,975,944 | 94.26% | 317 | 2,680.705s | 382.958s |
| Pi 原版 Baseline | Flash | 1 | **2/7** | **5** | 9,796,788 | 96.17% | 355 | 3,929.883s | 561.412s |

在同为单 Worker 且 7/7 通过的 Pro 对比中，Dungeon Maintainer 相比 Pi 原版减少 **53.26% Token**、**19.87% 工具调用**和 **29.46% 累计 Run 耗时**。缓存命中率只表示输入复用比例，不能单独代表效率或成功率。

<details>
<summary><b>展开查看 7 个场景明细</b></summary>

每个单元格依次为 `结果 / Token / 缓存命中率 / 工具调用 / Run 耗时`。

| 场景 | Maintainer Flash | Maintainer Pro | Pi 原版 Pro | Pi 原版 Flash |
|---|---|---|---|---|
| `terminal-action-bug` | 通过 / 367,095 / 92.94% / 26 / 139.541s | 通过 / 597,521 / 94.71% / 31 / 216.319s | 通过 / 2,050,118 / 92.02% / 57 / 518.079s | 通过 / 678,913 / 95.35% / 35 / 505.403s |
| `accepted-query-without-progress` | 通过 / 431,384 / 94.20% / 31 / 252.097s | 通过 / 718,144 / 96.14% / 39 / 203.730s | 通过 / 636,671 / 95.66% / 33 / 230.444s | 通过 / 987,840 / 95.71% / 37 / 315.838s |
| `final-stage-boss-stuck-at-one-hp` | 通过 / 292,238 / 93.75% / 25 / 264.581s | 通过 / 460,351 / 95.22% / 26 / 276.167s | 通过 / 887,680 / 96.03% / 33 / 225.708s | **timeout** / 1,112,392 / 97.23% / 48 / 621.412s |
| `admin-floor-transition-deadlock` | 通过 / 798,980 / 96.16% / 42 / 307.311s | 通过 / 679,837 / 95.33% / 38 / 340.768s | 通过 / 1,343,521 / 91.88% / 43 / 392.968s | **timeout** / 3,353,168 / 96.89% / 94 / 620.410s |
| `transition-lost-after-reload` | 通过 / 778,869 / 96.37% / 35 / 184.844s | 通过 / 936,003 / 96.41% / 43 / 283.846s | 通过 / 2,043,908 / 95.55% / 58 / 567.158s | **timeout** / 1,618,725 / 94.27% / 59 / 620.285s |
| `stale-query-plan-evidence` | 通过 / 624,037 / 95.32% / 36 / 193.503s | 通过 / 818,892 / 95.95% / 45 / 279.379s | 通过 / 1,872,357 / 94.13% / 54 / 466.116s | **timeout** / 1,451,540 / 97.15% / 44 / 626.066s |
| `duplicate-final-victory-commit` | 通过 / 374,952 / 94.37% / 31 / 208.909s | 通过 / 452,110 / 95.12% / 32 / 290.706s | 通过 / 1,141,689 / 96.78% / 39 / 280.232s | **timeout** / 594,210 / 94.54% / 38 / 620.469s |

</details>

完整判分边界、结果契约和断点恢复方式见 [内置 Eval 文档](docs/EVAL.md)。

## 🧭 工作方式

```text
用户请求
   |
   v
单个 Chromium Shell
├─ 左侧：Pi RPC 驱动的聊天
├─ 右侧：隔离 worktree 的游戏 iframe
└─ 底部：上下文、Token、任务、Diff 与验证状态
   |
   v
Dungeon Maintainer Extension
├─ inspect / edit / check / finish / workspace
├─ look / act / query / publish
├─ Evidence + 检查点刷新重放
└─ detached worktree + 固定检查
   |
   +─ /apply  -> 正式工作区（不提交）
   └─ publish -> 临时发布 worktree -> commit -> push -> GitHub PR（不合并）
```

一次标准修复遵循以下闭环：

1. `start` 固定来源仓库 HEAD 与完整工作区快照，并创建 detached worktree。
2. Agent 在只读阶段使用 `inspect` 与 `look / act / query` 定位并复现问题。
3. 首次 `edit` 前，Shell 展示精确文件范围；需要完整方案时同时展示病因、步骤和验证方式。
4. 写入后等待 Vite 更新，刷新页面、恢复检查点，并重放相同语义动作。
5. `/verify` 只运行直接改动测试和必要架构检查，再恢复重放并封装补丁。
6. `/apply` 只检查已验证 worktree Hash、来源漂移、目标 Hash 和 `git apply --check`，成功后直接写入 Agent 增量；完整质量门只在 `publish` 前运行。
7. 用户明确要求发布时，`publish` 从已验证补丁创建临时发布 worktree，经确认后创建 PR；合并始终留给用户。

## 🚀 快速开始

### 环境要求

- Node.js `>=22.19`
- pnpm `11.9.0`
- Git 与 `rg`
- Playwright Chromium
- 已安装依赖的 SQL Dungeon 游戏仓库
- 已登录的 GitHub CLI `gh`，仅在使用 `publish` 时需要

### 安装

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm build
```

构建后可查看 CLI 帮助：

```powershell
node dist/src/main.js --help
```

需要全局命令时，在维护器仓库执行：

```powershell
pnpm link --global
```

### 配置

维护器只读取自身仓库 `.env` 或当前进程中的 `MAINTAINER_*`，不会读取目标游戏仓库的 `.env`、浏览器数据或其他 Agent 配置。

```dotenv
MAINTAINER_API_KEY=
MAINTAINER_BASE_URL=https://api.deepseek.com/v1
MAINTAINER_MODEL=deepseek-v4-pro
MAINTAINER_CONTEXT_WINDOW=64000
MAINTAINER_MAX_TOKENS=4096
MAINTAINER_REASONING=true
```

进程环境变量优先于 `.env`。API Key 只通过环境传给 Pi Provider，不进入命令行、`task.json`、事件日志、浏览器或补丁文件。

### 启动与恢复

目标游戏仓库必须提供严格的 `.maintainer/project.json`：

```json
{
  "schemaVersion": 1,
  "adapter": "sql-dungeon"
}
```

```powershell
# 新建任务
dungeon-maintain start --repo "C:\path\to\select-from-dungeon"

# 恢复原任务
dungeon-maintain resume <task-id>
```

来源工作树可以包含未提交修改。`start` 会将当前状态快照为隔离基线，之后的普通 Diff 只包含 Agent 新增的修改；`resume` 遇到仓库、HEAD、worktree、Pi session 或 cwd 漂移时会明确阻断。

## 🧰 Pi 工具与用户命令

Pi 原生工具和 Bash 均不加载。维护器只向模型注册以下 9 个领域工具：

| 工具 | 作用 | 硬边界 |
|---|---|---|
| `inspect` | 查看状态、浅目录、搜索、分页文件、Diff 和 Evidence | 项目相对路径；read 默认 80 行、最多 160 行；单次最多 4 KiB |
| `edit` | 唯一替换、创建文本文件或整文件写入 | 最新 `baseHash`、realpath、精确授权路径；最多 3 文件 / 120 行 |
| `check` | 运行固定白名单检查 | 模型不能传命令、参数、cwd 或环境变量 |
| `finish` | 保存诊断、复现、方案、结果或阻断结论 | `result` 自动执行直接改动检查、刷新重放和断言 |
| `workspace` | 列出或切换同一仓库的合法 Git worktree | 只接受枚举 ID；切换需确认并创建新任务 |
| `look` | 读取带 revision、目标和稳定 action ID 的玩家可见投影 | 不返回完整地图、存档、隐藏答案或 Judge |
| `act` | 消费最新 revision 的稳定动作，完成导航或固定交互 | 最多 64 个真实移动步；拒绝旧修订和不可用动作 |
| `query` | 写入 SQL 并点击真实执行按钮 | SQL 只在进程内用于当前复现与重放 |
| `publish` | 提交、推送并创建中文 GitHub PR | 只接受空参数；要求已验证或已 apply；固定 GitHub origin；不合并 |

用户可使用五个固定命令：

| 命令 | 作用 |
|---|---|
| `/play` | 聚焦游戏；存在活动复现时从检查点重放相同步骤 |
| `/diff` | 显示当前 worktree 补丁 |
| `/verify` | 运行直接改动测试和必要架构检查，恢复重放并封装补丁 |
| `/apply` | 再次确认后写回正式工作区，但不提交 |
| `/discard` | 保存最终 Diff，标记放弃并在 Pi 退出后删除 worktree |

## 🔒 权限与数据边界

- 所有 Agent 源码写入先进入 detached worktree；正式仓库只由 `/apply` 写入，`publish` 只从已验证补丁创建发布提交。
- 写入授权绑定当前任务、基线、病因、完整步骤、验证方式与精确路径，并在当前 Agent 运行结束后自动收回。
- `edit` 校验 realpath、符号链接逃逸、`baseHash`、唯一匹配和行数预算；`/apply` 额外校验来源漂移、完整 worktree Hash 与补丁可应用性。
- `.git`、`.env*`、凭据、法律文件、`node_modules`、`dist`、缓存和二进制文件不属于 Agent 修复范围。
- 日志不保存 API Key、模型正文、SQL、答案、完整地图、正式存档、背包、身份或浏览器帧。
- Shell 仅绑定 `127.0.0.1`，使用临时 Chromium Profile，不提供公网 Dashboard 或用户任意终端。

<details>
<summary><b>任务状态与本地数据</b></summary>

任务记录固定为 schema v4，可处于 `created`、`active`、`awaiting_approval`、`verifying`、`paused`、`ready_to_apply`、`applied`、`blocked` 或 `discarded`。旧 schema 不迁移。

```text
%LOCALAPPDATA%\dungeon-maintainer\
├─ tasks/<task-id>/
│  ├─ task.json
│  ├─ events.jsonl
│  ├─ pi/
│  ├─ reproductions/
│  ├─ checks/
│  ├─ patch.diff
│  └─ reverse.diff
└─ worktrees/<task-id>/
```

</details>

## 🗂️ 仓库结构

| 目录 | 职责 |
|---|---|
| [`src/app/`](src/app/) | 仓库事实、Pi 进程、任务生命周期以及 `start / resume` |
| [`src/pi/`](src/pi/) | Extension 装配、会话策略、9 个工具和 5 个命令 |
| [`src/shell/`](src/shell/) | 本地 HTTP/SSE 协议、统一 Chromium Shell 与状态栏 |
| [`src/game/`](src/game/) | Vite、临时 Chromium、协议客户端与语义驱动 |
| [`src/evidence/`](src/evidence/) | 当前任务的诊断、复现、检查与结论证据 |
| [`src/repair/`](src/repair/) | 检查点恢复、刷新重放与验证 |
| [`src/workspace/`](src/workspace/) | Git、realpath、补丁、检查、apply、worktree 与 PR 发布 |
| [`src/eval/`](src/eval/) | Eval 场景、执行、Profile、报告与本地进度页 |
| [`tests/`](tests/) | Node 测试；安全边界优先使用真实临时 Git 仓库 |

## 🧪 运行 Eval

`pnpm eval` 从当前游戏 Adapter 读取场景，将故障物化到独立临时仓库，再启动正常 Maintainer 修复。真实游戏分支不会被切换或写入。

```powershell
pnpm eval -- suite `
  --profile maintainer `
  --workers 2 `
  --dependencies "C:\path\to\select-from-dungeon" `
  --ui progress
```

每个 Run 拥有独立 Workspace、Pi Session、Vite 和 Chromium。正式判分只执行一次候选 after browser Oracle，不比较代码、Diff 或参考实现。详见 [docs/EVAL.md](docs/EVAL.md)。

## 🔌 游戏开发桥

目标游戏使用协议 1.0 开发桥。桥只在 `DEV`、本地主机且 URL 带有 `?playtest=agent` 时安装；试玩使用页面内存 DataStore、临时 Chromium Context 和一次性 `sessionStorage` 检查点，不读取正式存档或用户 Chrome Profile。

生产构建必须裁掉桥模块，可在游戏仓库构建后检查：

```powershell
rg --fixed-strings "__DUNGEON_PLAYTEST__" game/dist
```

预期无匹配。

## ✅ 开发验证

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 📚 深入阅读

| 文档 | 内容 |
|---|---|
| [架构说明](docs/ARCHITECTURE.md) | 运行流程、代码地图、依赖方向、领域词典、安全边界和新手阅读顺序 |
| [Eval 说明](docs/EVAL.md) | 场景物化、Profile、判分、结果契约、隐私边界和断点恢复 |
