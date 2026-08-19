# Dungeon Maintainer V1 设计

## 1. 目标

Dungeon Maintainer V1 是 SQL Dungeon 专用的本地 Coding Agent。用户在当前终端与原生 Pi CLI
聊天，右侧 headed Chromium 运行 detached worktree 中的真实游戏。Agent 根据自然语言问题定位、
复现、修改并触发页面更新；用户显式 `/apply` 前，正式游戏仓库保持不变。

```text
用户问题 -> Pi CLI（单会话）
  -> Dungeon Maintainer Extension
       -> 代码定位与固定检查
       -> 浏览器语义复现
       -> detached worktree 精确修改
       -> 刷新、恢复、重放
  -> /verify -> /apply -> 正式游戏工作区（无提交）
```

V1 非目标：多 Agent、Dashboard、Electron、通用 Shell、任意浏览器脚本、自建模型循环、长期记忆、
自动发布和通用仓库适配。

## 2. 两仓库边界

- 维护器拥有 Pi Extension、任务事实、worktree、权限、检查、浏览器生命周期和 apply。
- 游戏拥有玩法规则、Vite、DOM/Phaser、SQLite，以及只在开发态安装的协议 v2 桥。
- 维护器不把运行时代码复制进游戏；游戏不导入维护器包。
- 游戏根 `.maintainer/project.json` 只能包含 `schemaVersion: 1` 和 `adapter: sql-dungeon`。

## 3. 启动与恢复

`start` 校验 Git 根、项目标识、洁净工作区和依赖，记录 `baseHead`，创建 detached worktree 与
Pi 会话目录，再以 worktree 为 cwd 启动 Pi。固定参数包含：

```text
--no-builtin-tools --no-extensions --no-skills
--no-prompt-templates --no-context-files
-e <maintainer-extension>
--provider dungeon-maintainer --model <fixed-model>
--session-id <task-id> --session-dir <task-dir>/pi
```

taskId 与 Pi session-id 固定绑定，因为聊天、审批、补丁和 worktree 必须指向同一任务。Extension
通过会话生命周期钩子取消 `/new`、内置 `/resume`、`/import`、`/fork`、`/clone` 和 `/tree`，
阻断 Shell，并在模型被选择为其他项时立即恢复固定维护模型。

`resume` 验证 schema、正式仓库 `baseHead`、worktree Git 根/HEAD、Pi 会话目录和唯一首行记录。
worktree 或会话丢失时阻断，不静默重建。

## 4. 代码结构

```text
src/
├─ main.ts
├─ app.ts                    # 稳定导出门面
├─ app/
│  ├─ repository.ts         # SQL Dungeon 标识、Git 与运行依赖事实
│  ├─ pi-process.ts         # 固定 Pi 参数、子进程与会话文件
│  ├─ task-lifecycle.ts     # 任务路径绑定与终态 worktree 清理
│  ├─ start.ts
│  └─ resume.ts
├─ config.ts
├─ pi/
│  ├─ extension.ts          # Provider、工具、命令和生命周期装配
│  ├─ session-policy.ts     # Pi 绑定、固定模型、Shell/会话切换阻断
│  ├─ game-runtime.ts       # 单 Vite、Chromium 和 GameDriver 生命周期
│  ├─ prompt.ts
│  ├─ tools/
│  └─ commands/
├─ task/
├─ workspace/
├─ game/
├─ repair/
└─ logging/
```

旧 Dashboard、自建 CLI 交互层、自建模型循环、上下文压缩、Harness、两级缓存和通用适配器已删除。
`app.ts` 与 `pi/extension.ts` 保持稳定门面，具体副作用归入唯一职责文件；架构回归测试防止
子进程、worktree、`realpath` 或 Vite/Chromium 生命周期重新堆回装配入口。

## 5. 任务与状态

schema v2 只保存任务路径、Hash、状态、有限检查/复现索引和结论。状态机：

```text
created -> active -> verifying -> ready_to_apply -> applied
             ↕
      awaiting_approval
             ↓
       blocked / discarded
```

`TaskStore` 使用临时文件和原子替换保存 `task.json`。旧 schema v1 明确拒绝恢复。Pi 会话正文仅在
`pi/`，不会复制进事件日志。

## 6. 路径、Hash 与审批

所有路径必须是无 NUL、无绝对地址、无 `..` 的项目相对路径。执行层对仓库根、目标或最近存在
父目录执行 `realpath`；仓库内符号链接/junction 指向仓库外时拒绝。

- `auto`：游戏文档、测试和小型展示层。
- `core`：领域、内容、契约、基础设施、应用、开发桥、Agent、脚本、CI 和根配置。
- `denied`：`.git`、`.env*`、凭据、法律文件、生成目录、虚拟环境和仓库外路径。

`patch` 只支持唯一旧文本替换或创建新文本文件。每项携带最新 `baseHash`，单任务累计最多 3 文件、
120 行。核心审批绑定 `taskId + baseHead + 精确路径 + baseHash + 旧/新正文 Hash`，只能消费一次。
拒绝审批时不会建立浏览器检查点，也不会写入任何源码字节。

## 7. 定位与复现

模型工具固定为 `inspect/patch/check/finish/look/go/use/query`。运行时问题必须至少产生一个
go/use/query 动作，再用 `finish(status=reproduced)` 保存标题、期望、实际、证据和语义动作。
构建、类型或测试问题可以失败的固定检查作为复现证据。

`SemanticTrace` 只保存动作类型、有限参数、结果摘要和单调序号，容量 500 条。清空窗口不会重用
序号；只有显式复现窗口写入 `reproductions/`。鼠标轨迹、帧、SQL、地图、存档和隐藏裁判不落盘。

## 8. 游戏桥

协议 v2 固定提供 `checkpoint/look/go/use/query/judge/events`。桥只在
`DEV + localhost + ?playtest=agent` 时安装，并通过 DEV 动态导入保证生产构建裁除。

游戏开发桥内部按职责分为 `protocol.ts`（协议/临时存储）、`actions.ts`（固定 DOM 动作）、
`projection.ts`（玩家可见投影）、`navigation.ts`（目标、frontier、BFS 与停止原因）、
`query.ts`（不向模型暴露正文的真实查询执行）、`trace.ts` 和仅负责装配的 `bridge.ts`。
`bridge.ts` 保留旧导出作为兼容门面，但不再拥有投影、寻路或答案执行规则。

试玩模式使用页面内存 DataStore 和临时 Chromium Context，不打开正式 IndexedDB，不读取正式
localStorage Run/Profile 或用户 Chrome Profile，并关闭游戏外部 Agent endpoint。完整地图只在
浏览器内部 BFS；答案只在浏览器内部经过真实 SqlEngine 和 GameSession 判定；`judge` 不暴露给模型。

## 9. 修改、刷新与重放

固定顺序：

1. 所有静态校验和核心确认完成。
2. `beforePatch` 确保复现起点检查点存在。
3. 写入 detached worktree，Vite 更新。
4. 浏览器 reload 并消费一次性 sessionStorage 检查点。
5. 确认 `checkpointRestored === true`。
6. 立即在恢复起点重建检查点，供后续 `/verify` 使用。
7. 按原顺序重放 go/use/query。

不能在症状状态覆盖原起点。重放失败保留 worktree 和证据，但不会进入 `ready_to_apply`。

## 10. 检查与验证

检查命令、参数和 cwd 全部由源码固定，子进程使用 `shell:false` 并移除常见凭据环境变量。检查记录
绑定完整 worktree Hash；该 Hash 覆盖 HEAD、已跟踪 diff 和所有未跟踪文件字节。

`/verify` 是 `ready_to_apply` 的唯一入口：要求已登记变更和复现/失败检查证据，运行路径对应的
固定检查，存在复现时恢复并重放，最后生成 `patch.diff`、`reverse.diff`、正式仓库基线文件 Hash
和最终 worktree Hash。

## 11. Apply 与 Discard

`/apply` 重新检查状态、补丁、VerificationRecord、worktree Hash、正式仓库洁净度、`baseHead`、
逐文件基线 Hash 和 `git apply --check`，再显示精确路径确认。成功只修改正式工作区，不创建提交。
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
右侧游戏同启、语义复现、worktree 隔离、刷新恢复重放、核心确认、`/verify` 门禁和显式 `/apply`。
