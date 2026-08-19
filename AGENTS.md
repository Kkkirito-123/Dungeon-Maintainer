# Dungeon Maintainer 仓库指南

本文件是本仓库的开发权威。默认使用中文沟通、计划、开发说明和复盘；源码与文档使用 UTF-8，
TypeScript 标识符使用清晰英文领域词。

## 产品目标与非目标

本仓库只实现 SQL Dungeon 专用的本地 Coding Agent：原生 Pi CLI 负责聊天，维护器 Extension
负责受限代码工具、游戏语义工具、detached worktree、固定检查、浏览器复现和显式 apply。

```text
Pi CLI -> src/pi/extension.ts
  -> session-policy + game-runtime
  -> inspect / patch / check / finish
  -> look / go / use / query
  -> task + workspace + repair + game + logging
```

V1 固定单 Agent、单任务、单 worktree、单 Vite 和单 Chromium Context。不要加入 Dashboard、
Electron、自建模型循环、上下文压缩、Harness、通用 Shell、多 Agent、长期记忆、自动 commit、push、
PR、部署或 HTTP 服务。维护器和游戏始终是两个独立仓库。

## 模块所有权

```text
src/main.ts              外部 start/resume 参数入口
src/app.ts               稳定兼容导出门面，不承载启动副作用
src/app/                  仓库事实、Pi 进程、任务生命周期及 start/resume
src/config.ts            维护器 MAINTAINER_* 和本地数据目录
src/pi/extension.ts      Pi Provider、工具、命令和生命周期装配
src/pi/session-policy.ts Pi 会话绑定、固定模型、Shell 与会话切换阻断
src/pi/game-runtime.ts   单 Vite、临时 Chromium 和 GameDriver 生命周期
src/pi/tools/            八个固定模型工具
src/pi/commands/         五个固定用户命令
src/task/                schema v2 任务事实与状态机
src/workspace/           Git、realpath、补丁、检查、apply 与 worktree
src/game/                Vite、临时 Chromium、协议客户端与语义驱动
src/repair/              复现、刷新重放与验证
src/logging/             低敏事件、脱敏与 500 条语义 Trace
tests/                   Node 测试；安全边界优先使用真实临时 Git 仓库
```

不要在相邻模块复制权威：任务状态只由 `TaskStore` 持久化；正式仓库写入只由
`workspace/apply.ts` 执行；浏览器只能调用协议 v2 固定方法；Pi prompt 不能替代执行层权限。

## 开发规则

- 修改前读取 Git 状态、拥有行为的模块、对应测试和设计文档；保留无关用户工作。
- 只实现当前明确目标，优先最小完整切片；不要为单次调用建立泛化抽象或兼容层。
- 模型不能提供 Shell 字符串、任意参数、JavaScript、选择器、鼠标坐标、SQL、删除或移动指令。
- 所有文件访问必须先规范项目相对路径，再通过 `realpath`/最近存在父目录检查符号链接逃逸。
- `patch` 必须绑定最新 `baseHash`、唯一旧文本、3 文件/120 行预算和精确核心审批。
- 第一字节源码写入前必须存在浏览器复现检查点；写入后按刷新、恢复、重建检查点、重放的顺序执行。
- 所有 Agent 修改只进入 detached worktree。正式仓库仅由用户 `/apply` 修改，且不自动提交。
- 不输出、记录或持久化 API Key、模型正文、SQL、答案、完整地图、正式存档、背包、身份或帧画面。
- 删除终态 worktree 前必须验证解析后的精确目标是配置 `worktrees/` 下的单个任务子目录。

## 注释与命名

新增或重写的生产文件必须有中文文件头，说明职责、非职责、输入输出、相邻模块边界、副作用、
权限、隐私、关键失败模式和恢复方式。

所有导出的类型、类、函数和工具契约使用中文 JSDoc，覆盖参数、返回值、状态变化、可能错误、
调用前置条件和权限保证。以下位置必须解释“为什么”：

- taskId 与 Pi session-id/session-dir/cwd 固定绑定；
- 禁用内置工具、Shell 和会话切换；
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

Pi 工具固定为 `inspect/patch/check/finish/look/go/use/query`；用户命令固定为
`/play /diff /verify /apply /discard`。新增能力前必须先修改已批准设计，不能通过配置动态扩展。

任务 schema 固定为 v2。旧 v1 不自动迁移。状态机为：

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

测试必须覆盖 CLI/Pi 参数、会话绑定、状态迁移、绝对路径与 `..`、符号链接、审批拒绝与消费、
Hash 冲突、worktree 隔离、刷新重放顺序、日志脱敏、apply 漂移和 discard 清理。Git 安全测试使用
真实临时仓库，不能只用 mock。

涉及游戏桥时，还要在目标游戏仓库运行聚焦测试、完整游戏测试、架构检查和生产构建，并确认
`game/dist` 不含 `__DUNGEON_PLAYTEST__`。只报告实际执行的检查，不把静态或 mock 证据称为端到端。
