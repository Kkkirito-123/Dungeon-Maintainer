# Dungeon Maintainer 仓库指南

本文件是本仓库的开发权威。默认使用中文沟通、计划、开发说明和复盘；源码与文档使用 UTF-8，
TypeScript 标识符使用清晰英文领域词。

## 产品目标与非目标

本仓库只实现 SQL Dungeon 专用的本地 Coding Agent：Pi RPC 驱动统一 Chromium Shell 的聊天，
维护器 Extension
负责受限代码工具、游戏语义工具、detached worktree、固定检查、浏览器复现和显式 apply。

```text
Chromium Shell -> Pi RPC -> src/pi/extension.ts
  -> session-policy + game-runtime
  -> inspect / patch / check / finish
  -> look / go / use / query
  -> task + workspace + repair + game + logging
```

1.0 固定单 Agent、单 Pi、单活动任务、单活动 worktree、单 Vite 和单 Chromium Context。历史任务只持久化，
切换时必须先停止旧 Pi，不能在后台继续消耗 Token。不要加入公网 Dashboard、
Electron、自建模型循环、Harness、面向用户的任意终端、多 Agent、长期记忆、自动 commit、push、PR 或部署。
Pi 原生 Bash 不加载；用户批准具体总方案后，当前 Agent 也只能使用受边界约束的原生 Coding 工具。
允许且仅允许由 src/shell 提供绑定 127.0.0.1 的任务级 HTTP/SSE 界面。维护器和游戏始终是两个独立仓库。

## 模块所有权

```text
src/main.ts              外部 start/resume 参数入口
src/app.ts               公开启动入口，不承载启动副作用
src/app/                  仓库事实、Pi 进程、任务生命周期及 start/resume
src/config.ts            维护器 MAINTAINER_* 和本地数据目录
src/pi/extension.ts      Pi Provider、工具、命令和生命周期装配
src/pi/session-policy.ts Pi 会话绑定、模型/会话切换阻断
src/pi/game-runtime.ts   单 Vite、临时 Chromium 和 GameDriver 生命周期
src/pi/tool-policy.ts    只读诊断与本轮完整执行的活动工具集合
src/pi/tools/            十一个固定领域工具（含总方案审批与工作树切换；另加载 Pi 原生 write）
src/pi/commands/         五个固定用户命令
src/shell/               Chromium Shell 页面、HTTP/SSE 协议和状态栏
src/task/                当前 schema v4 任务事实与状态机
src/workspace/           Git、realpath、补丁、检查、apply 与 worktree
src/game/                Vite、临时 Chromium、协议客户端与语义驱动
src/repair/              复现、刷新重放与验证
src/logging/             低敏事件、脱敏与 500 条语义 Trace
src/eval/domain/         Dataset、Scenario、Oracle 和 Profile 共用结果契约
src/eval/execution/      Workspace、预检、单次运行、并行 Suite 和进度事件
src/eval/profiles/       互不依赖的 Maintainer 与 Pi Baseline
src/eval/reporting/      运行身份、checkpoint 和结果汇总
src/eval/ui/             Eval 静态进度页和本地 SSE 服务
eval-datasets/           冻结评测输入；不读取当前游戏工作树
tests/                   Node 测试；安全边界优先使用真实临时 Git 仓库
```

不要在相邻模块复制权威：任务状态只由 `TaskStore` 持久化；正式仓库写入只由
`workspace/apply.ts` 执行；浏览器只能调用当前协议 v3 固定方法；Pi prompt 不能替代执行层权限。

## 开发规则

- 修改前读取 Git 状态、拥有行为的模块、对应测试和设计文档；保留无关用户工作。
- 只实现当前明确目标，优先最小完整切片；不要为单次调用建立泛化抽象或兼容层。
- 诊断阶段可以提出精确 write/patch；第一次调用由执行层按目标文件申请用户批准，批准后才真正写入；
  本轮结束必须自动收权。
- 任意 Bash 不加载；原生 write 也必须经过 detached worktree 的项目相对路径和 realpath 边界。
- 所有文件访问必须先规范项目相对路径，再通过 `realpath`/最近存在父目录检查符号链接逃逸。
- `patch` 必须绑定最新 `baseHash`、唯一旧文本和 3 文件/120 行预算；模型调用时复用当前已批准的
  精确写入范围，不得为同一文件重复打断用户。
- 第一字节源码写入前必须存在浏览器复现检查点；写入后按刷新、恢复、重建检查点、重放的顺序执行。
- 所有 Agent 修改只进入 detached worktree。正式仓库仅由用户 `/apply` 修改，且不自动提交。
- 来源工作树允许脏状态；启动时复制为隔离 index 基线，后续 Diff 只包含 Agent 增量。
- `tree` 只能枚举同一 Git common-dir 的合法游戏 worktree；切换必须确认并创建新任务，不能原地偷换 cwd。
- 不输出、记录或持久化 API Key、模型正文、SQL、答案、完整地图、正式存档、背包、身份或帧画面。
- 删除终态 worktree 前必须验证解析后的精确目标是配置 `worktrees/` 下的单个任务子目录。

## 注释与命名

新增或重写的生产文件必须有中文文件头，说明职责、非职责、输入输出、相邻模块边界、副作用、
权限、隐私、关键失败模式和恢复方式。

所有导出的类型、类、函数和工具契约使用中文 JSDoc，覆盖参数、返回值、状态变化、可能错误、
调用前置条件和权限保证。以下位置必须解释“为什么”：

- taskId 与 Pi session-id/session-dir/cwd 固定绑定；
- 诊断/执行工具切换、总方案授权的单轮生命周期，以及会话切换阻断；
- realpath、junction 和符号链接防逃逸；
- `baseHead`、`baseHash`、完整 worktree Hash 与一次性审批；
- 检查点、刷新、恢复、重建检查点和重放顺序；
- 语义事件序号与复现窗口截取；
- 日志脱敏和禁止持久化字段；
- apply 冲突检查及持久化失败后的反向恢复。

不要逐行翻译明显赋值或条件。命名使用明确领域词，如 `TaskStore`、`GameDriver`、
`PrecisePatchInput`；禁止含糊的 `Manager`、`Helper`、`Utils`。

## 固定版本与接口

```text
@earendil-works/pi-coding-agent  0.84.2
@earendil-works/pi-agent-core    0.84.2
@earendil-works/pi-ai            0.84.2
playwright                       1.62.1
```

外部命令只允许：

```text
dungeon-maintain start --repo <游戏仓库>
dungeon-maintain resume <task-id>
```

Pi 原生工具只加载 `write`；源码读取、搜索、目录和 Diff 统一走安全 `inspect`。维护器共加载
11 个领域工具和 1 个 Pi 原生工具，领域工具固定为
`inspect/patch/check/finish/look/go/use/input_sql/query/tree`；用户命令固定为 `/play /diff /verify /apply /discard`。
新增能力前必须先修改已批准设计，不能通过配置动态扩展。

维护器内部评测统一称为 `Eval`（入口为 `pnpm eval`，代码位于 `src/eval/`）。生产 Eval 不读取
当前游戏的场景或适配器：场景只来自 `eval-datasets/`；`--dependencies` 只复用游戏的
`game/node_modules`。游戏合同由独立 `game-contract` 静态检查维护。

任务记录只接受当前 schema v4，不迁移旧格式。状态机为：

```text
created -> active -> verifying -> ready_to_apply -> applied
             ↕
      awaiting_approval
             ↓
       blocked / discarded
```

## 验证

从维护器仓库根目录运行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

测试必须覆盖 CLI/Pi 参数、诊断阶段禁写、总方案确认、单轮收权、原生编辑同步、会话绑定、
状态迁移、绝对路径与 `..`、符号链接、审批拒绝与消费、
Hash 冲突、worktree 隔离、刷新重放顺序、日志脱敏、apply 漂移和 discard 清理。Git 安全测试使用
真实临时仓库，不能只用 mock。

## 统一 Shell 目录约束

1.0 的聊天和游戏展示使用一个本地 Chromium Shell。所有界面、HTTP/SSE 事件和状态栏代码必须
集中在 src/shell 文件夹：

    src/shell/protocol.ts  状态、事件和确认框契约
    src/shell/server.ts    127.0.0.1 服务、令牌校验和事件缓存
    src/shell/page.ts      聊天、iframe、拖拽分栏和底部状态栏

Pi 子进程继续使用 RPC/JSONL；游戏由 Playwright 在同一个 Chromium Page 的 iframe 中驱动。
不得把界面状态复制到 task.json，也不得通过 Shell 传输 API Key、完整 Prompt、thinking、SQL、
管理员答案、隐藏裁判或浏览器帧。允许本地 HTTP/SSE 仅用于当前任务的 Shell，不得扩展成公网服务。

长模型请求必须通过 `activity` SSE 事件在固定 `role=status` 区域给出即时阶段反馈；反馈只使用
确定性运行时事件和计时，不得额外请求模型或向聊天记录周期性追加消息。同一任务同一时刻只运行一个
自然语言回合；回合运行中允许通过 Pi 原生 `steer` 追加文字要求，固定命令仍需等待回合结束。
用户可通过 Pi 原生 `abort` 停止当前回合；收到 `agent_settled` 或请求明确完成后必须恢复输入控件。

涉及游戏桥时，还要在目标游戏仓库运行聚焦测试、完整游戏测试、架构检查和生产构建，并确认
`game/dist` 不含 `__DUNGEON_PLAYTEST__`。只报告实际执行的检查，不把静态或 mock 证据称为端到端。
