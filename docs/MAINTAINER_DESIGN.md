# Dungeon Maintainer 1.0 设计

## 1. 目标

Dungeon Maintainer 1.0 是 SQL Dungeon 专用的本地 Coding Agent。用户在一个 Chromium Shell 中与
Pi RPC 驱动的聊天 CLI 协作，右侧 iframe 运行 detached worktree 中的真实游戏。Agent 根据自然语言问题定位、
复现、修改并触发页面更新；用户显式 `/apply` 前，正式游戏仓库保持不变。

```text
用户问题 -> Pi CLI（单会话）
  -> Dungeon Maintainer Extension
       -> 代码定位与固定检查
       -> 浏览器语义复现
       -> detached worktree 精确修改
       -> 刷新、恢复、重放
  -> finish(result) 验证（或自然结束后由用户 /verify） -> /apply -> 正式游戏工作区（无提交）
```

1.0 非目标：多 Agent、Dashboard、Electron、面向用户的任意终端、任意浏览器脚本、自建模型循环、长期记忆、
自动发布和通用仓库适配。

运行时始终只有一个 Pi、一个活动任务、一个游戏 Vite 和一个 Chromium Context。工作树/任务切换由
`AppController` 串行执行：保存旧任务并停止旧 Pi 后才启动新 Pi；旧任务只留在磁盘，不后台消耗 Token。

Shell 界面代码必须集中在维护器 src/shell 文件夹：

    src/shell/protocol.ts  状态栏、SSE 事件和确认框数据契约
    src/shell/server.ts    127.0.0.1 HTTP/SSE、令牌校验和事件环形缓存
    src/shell/page.ts      聊天、游戏 iframe、拖拽分栏和底部状态栏

父进程通过 Pi RPC/JSONL 与 Agent 通信，游戏由 Playwright 在同一个 Chromium Page 的 iframe
中驱动。Shell 只传输低敏摘要，不传输 API Key、完整 Prompt、thinking、SQL、管理员答案、
隐藏裁判或浏览器帧。

用户提交输入后，Shell 不等待模型首个 Token：立即显示一个固定活动栏，并由 Pi/工具事件更新为
读取游戏状态、复现、定位、修改、刷新、验证、生成结论或等待确认。活动栏每 5 秒只更新 elapsed，
不写入聊天历史、不调用模型；本轮结束或错误时恢复输入，防止同一会话并发提交造成顺序混乱。

Chromium 使用 `--app=<shell-url>` 打开无标签栏、无地址栏的独立窗口。Context 使用 Playwright
临时 Profile，且不设置固定虚拟 viewport，使 CSS 视口始终等于真实窗口内容区；这既保证窗口可自由
缩放，也避免高 DPI 环境将 CLI 输入框或底部状态栏裁出可视区域。

底部状态栏严格为两排且每排独立横向滚动：第一排显示工作树、任务、阶段、模型、Thinking 和上下文，
第二排显示本轮/会话 Token、缓存、工具预算、运行时、Diff 和验证。工作树按钮展开合法 worktree、
可恢复任务和当前 detached worktree 文件树；文件按允许修改、已修改、禁止和验证结果标记。

## 2. 两仓库边界

- 维护器拥有 Pi Extension、任务事实、worktree、权限、检查、浏览器生命周期和 apply。
- 游戏拥有玩法规则、Vite、DOM/Phaser、SQLite，以及只在开发态安装的当前协议 v3 桥。
- 维护器不把运行时代码复制进游戏；游戏不导入维护器包。
- 游戏根 `.maintainer/project.json` 只能包含 `schemaVersion: 1` 和 `adapter: sql-dungeon`。

## 3. 启动与恢复

`start` 校验 Git 根、项目标识和依赖，记录来源工作树的 `baseHead` 与完整快照 Hash，创建 detached
worktree 与 Pi 会话目录，再以隔离树为 cwd 启动 Pi。来源树允许已有修改：已跟踪 Diff 与未跟踪
普通文件被复制后暂存到隔离树 index，作为只读基线；复制期间发生漂移则回收任务并阻断。

```text
--tools edit,write,inspect,patch,check,finish,look,go,use,query,tree
--no-extensions --no-skills
--no-prompt-templates --no-context-files
-e <maintainer-extension>
--provider <profile-provider> --model <model-id>
--session-id <task-id> --session-dir <task-dir>/pi
```

taskId 与 Pi session-id 固定绑定，因为聊天、审批、补丁和 worktree 必须指向同一任务。Extension
通过会话生命周期钩子取消 `/new`、内置 `/resume`、`/import`、`/fork`、`/clone` 和 `/tree`，
阻断 Shell；模型和 Thinking 只能通过 Shell 暴露的 Pi RPC 改变，并以 Pi 返回状态为事实源。

全部工具只是在进程启动时加载，活动权限由 Extension 分两阶段控制：诊断阶段只有只读检索、固定
检查和游戏语义工具；Agent 定位病因后可以直接调用精确 patch/write，第一次写入按目标文件向 Shell
申请一次批准，确认后原始调用继续执行。需要提前说明多文件方案时仍可用
`finish(status=proposed)`；方案完成、拒绝或 Agent 运行结束立即恢复只读集合。普通“继续”文本不是写入授权。

`resume` 验证 schema、正式仓库 `baseHead`、worktree Git 根/HEAD、Pi 会话目录和唯一首行记录。
worktree 或会话丢失时阻断，不静默重建。

## 4. 代码结构

```text
src/
├─ main.ts
├─ app.ts                    # 公开启动入口
├─ app/
│  ├─ repository.ts         # SQL Dungeon 标识、Git 与运行依赖事实
│  ├─ pi-process.ts         # 固定 Pi 参数、子进程与会话文件
│  ├─ task-lifecycle.ts     # 任务路径绑定与终态 worktree 清理
│  ├─ start.ts
│  └─ resume.ts
├─ config.ts
├─ pi/
│  ├─ extension.ts          # Provider、工具、命令和生命周期装配
│  ├─ session-policy.ts     # Pi 绑定、模型/会话切换阻断
│  ├─ game-runtime.ts       # 单 Vite、Chromium 和 GameDriver 生命周期
│  ├─ tool-policy.ts        # 诊断/执行阶段的工具集合
│  ├─ context-shaping.ts    # 最新游戏/源码证据的回合上下文裁剪
│  ├─ prompt.ts
│  ├─ tools/
│  └─ commands/
├─ settings/                # OpenAI-compatible 模型档案与凭据边界
├─ task/                    # 当前 schema v4 任务事实
├─ workspace/
├─ game/
├─ repair/
└─ logging/
```

旧 Dashboard、自建 CLI 交互层、自建模型循环、Harness、两级缓存和通用适配器已删除；上下文控制
改由 Pi 原生 compact 加维护器的最新证据裁剪完成。
自然语言输入进入 Pi 前由 Shell 执行同步 Token 门禁：安全输入上限取
`min(contextWindow × 75%, contextWindow - maxOutputTokens)`，并加入本轮输入的保守估算。
超过安全线时先等待 Pi compact 完成；压缩后仍超过安全线才拒绝本轮，且拒绝的输入不会发送给模型。
`app.ts` 与 `pi/extension.ts` 保持轻量入口，具体副作用归入唯一职责文件；架构回归测试防止
子进程、worktree、`realpath` 或 Vite/Chromium 生命周期重新堆回装配入口。

## 5. 任务与状态

当前 schema v4 保存任务路径、Hash、状态、模型档案、Thinking 等级、精确写入范围、有限检查/复现索引和结论。
旧任务格式不迁移；恢复时只接受由 1.0 创建的当前记录。状态机：

```text
created -> active -> verifying -> ready_to_apply -> applied
             ↕
      awaiting_approval
             ↓
       blocked / discarded
```

`TaskStore` 使用临时文件和原子替换保存 `task.json`。Pi 会话正文仅在
`pi/`，不会复制进事件日志。

任务还记录来源分支、启动时脏文件数量和 `sourceSnapshotHash`，不记录原修改正文或敏感路径。

## 6. 路径、Hash 与审批

所有路径必须是无 NUL、无绝对地址、无 `..` 的项目相对路径。执行层对仓库根、目标或最近存在
父目录执行 `realpath`；仓库内符号链接/junction 指向仓库外时拒绝。

- `auto`：游戏文档、测试和小型展示层。
- `core`：领域、内容、契约、基础设施、应用、开发桥、Agent、脚本、CI 和根配置。
- `denied`：`.git`、`.env*`、凭据、法律文件、生成目录、虚拟环境和仓库外路径。

`patch` 只支持唯一旧文本替换或创建新文本文件。每项携带最新 `baseHash`，单任务累计最多 3 文件、
120 行。模型只能在总方案获批后看到 patch，因此核心路径复用这次总授权，不弹第二个确认框；底层仍
生成并消费精确补丁摘要。Pi 原生工具不受 patch 文本预算约束，但每批 edit/write 结束都会重新
读取 Git 增量、更新 `changedPaths` 并使旧验证失效。

任意 Bash 无法在 Pi 进程内可靠限定到 worktree，因此本版不加载。原生 edit/write 在首字节写入前
必须通过项目相对路径与 realpath 检查；正式仓库的产品级写入通道仍只有 `/apply`。

## 7. 定位与复现

Pi 原生工具只加载 `edit/write`；读取、搜索、目录和 Diff 统一走安全 `inspect`。领域工具固定为
`inspect/patch/check/finish/look/go/use/input_sql/query/tree`。诊断阶段不会激活写入工具。`tree(list)` 只返回同一 Git
common-dir 下合法游戏 worktree 的 12 位 ID、分支和脏文件数；`tree(switch)` 需要用户确认并启动
绑定目标树的新任务，旧任务保留，禁止在当前 Pi 会话中修改 cwd。运行时问题必须至少产生一个
go/use/input_sql/query 动作，再用 `finish(status=reproduced)` 保存标题、期望、实际、证据、语义动作和至少一项
结构化结果断言；查询本应成功时必须包含 `queryAccepted: true`。
构建、类型或测试问题可以失败的固定检查作为复现证据。

Agent 在形成病因后必须提交一个能直接解决问题的总方案，不能用“要继续查吗”把诊断切成多次授权。
用户确认后应在同一运行中完成所有步骤、刷新右侧游戏、运行最窄检查并提交 result；若用户拒绝，
worktree 保持不变。

`SemanticTrace` 只保存动作类型、有限参数、结果摘要和单调序号，容量 500 条。清空窗口不会重用
序号；只有显式复现窗口写入 `reproductions/`。鼠标轨迹、帧、SQL、地图、存档和隐藏裁判不落盘。

## 8. 游戏桥

当前协议 v3 固定提供 `checkpoint/look/go/use/inputSql/query/judge/events`。桥只在
`DEV + localhost + ?playtest=agent` 时安装，并通过 DEV 动态导入保证生产构建裁除。

游戏开发桥内部按职责分为 `protocol.ts`（协议/临时存储）、`actions.ts`（固定 DOM 动作）、
`projection.ts`（玩家可见投影）、`navigation.ts`（目标、frontier、BFS 与停止原因）、
`query.ts`（点击当前终端真实执行按钮）、`trace.ts` 和仅负责装配的 `bridge.ts`。
`bridge.ts` 是协议公开入口，不拥有投影、寻路或查询判定规则。

试玩模式使用页面内存 DataStore 和临时 Chromium Context，不打开正式 IndexedDB，不读取正式
localStorage Run/Profile 或用户 Chrome Profile，并关闭游戏外部 Agent endpoint。完整地图只在
浏览器内部 BFS。终端打开时，投影包含玩家已看见的题面、schema、textarea SQL、状态、结果与计划；
关闭终端后不返回 SQL，且始终禁止读取 `adminAnswerSql`、隐藏答案、未解锁提示和 judge。
`inputSql` 只向当前已打开的固定 textarea 写入模型生成的 SQL，不执行查询、不接受选择器或脚本；
`query` 不接收 SQL 参数，只提交当前 textarea，并经过真实 AppShell、SqlEngine 和 GameSession 判定。

## 9. 修改、刷新与重放

固定顺序：

1. 病因、完整方案、验证方式和风险已经由用户一次确认。
2. `beforePatch` 确保复现起点检查点存在。
3. 写入 detached worktree，Vite 更新。
4. 浏览器 reload 并消费一次性 sessionStorage 检查点。
5. 确认 `checkpointRestored === true`。
6. 立即在恢复起点重建检查点，供后续 `/verify` 使用。
7. 按原顺序重放 go/use/input_sql/query；SQL 正文只在当前进程内保留，任务重启后缺失时明确阻断。

不能在症状状态覆盖原起点。重放失败保留 worktree 和证据，但不会进入 `ready_to_apply`。

## 10. 检查与验证

检查命令、参数和 cwd 全部由源码固定，子进程使用 `shell:false` 并移除常见凭据环境变量。检查记录
绑定完整 worktree Hash；该 Hash 覆盖 HEAD、index 快照基线、Agent diff 和所有未跟踪文件字节。

`finish(status=result)` 是 Agent 自主进入 `ready_to_apply` 的入口：要求已登记变更和复现/失败检查证据，
运行路径对应的固定检查，存在复现时恢复动作并校验玩家断言与 hidden judge，最后生成
`patch.diff`、`reverse.diff`、正式仓库基线文件 Hash 和最终 worktree Hash。`/verify` 保留为用户人工重试入口。

## 11. Apply 与 Discard

`/apply` 重新检查状态、补丁、VerificationRecord、worktree Hash、来源 `sourceSnapshotHash`、`baseHead`、
逐文件基线 Hash 和 `git apply --check`，再显示精确路径确认。来源可保持启动时的脏状态，但任何
新增漂移都会拒绝；成功只写入 Agent 增量，不创建提交。
若应用后任务保存失败，先反向 `--check` 再反向应用，避免仓库和任务事实分裂。

`/discard` 保存最终 Diff、标记 discarded、关闭浏览器/Vite 并退出 Pi。父进程回到维护器 cwd 后
才删除 `worktrees/` 下的精确任务目录；任务证据保留。

## 12. 本地数据与隐私

```text
%LOCALAPPDATA%/dungeon-maintainer/
├─ tasks/<task-id>/{task.json,events.jsonl,pi/,reproductions/,checks/,patch.diff,reverse.diff}
└─ worktrees/<task-id>/
```

事件只允许标量字段并统一脱敏、限长。禁止持久化 API Key、模型正文、SQL、答案、完整地图、
`runSeed`、完整快照、正式存档、背包、身份和浏览器帧。

## 13. 注释、命名与验收

生产文件使用中文文件头，导出契约使用中文 JSDoc；注释解释会话绑定、权限、Hash、审批、
realpath、检查点、重放、日志和 apply 恢复等非直观设计。命名使用 `TaskStore`、`GameDriver`、
`PreciseEdit` 等明确领域词，禁止 `Manager/Helper/Utils`。

维护器门禁：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`。游戏门禁：完整测试、
架构检查、生产构建，并确认 `game/dist` 不含 `__DUNGEON_PLAYTEST__`。端到端验收还需证明 Pi 与
右侧游戏同启、语义复现、worktree 隔离、刷新恢复重放、核心确认、模型/Thinking/compact 真实 RPC、
两排状态栏、Token 上下文门禁、`/verify` 门禁和显式 `/apply`。
