# Dungeon Maintainer 轻量架构说明

这份文档用于代码评审、维护交接和甲方技术讲解。它只描述当前实现，不保留旧架构的兼容分支。

## 30 秒说明

Dungeon Maintainer 不是另一套 Agent 框架。它以 **Pi Agent Loop 为唯一运行核心**，只在外面增加三类能力：

1. 一个左右分栏的本地 Shell，用来展示聊天、游戏和审批；
2. 九个面向 SQL Dungeon 的工具与五个用户命令；
3. detached worktree、证据记录、验证和显式应用/发布。

```text
用户
 │
 ▼
左右分栏 Shell ──► AppController ──► Pi RPC ──► Pi Agent Loop
                       │                            │
                       │                            ▼
                       │                    工具与插件注册器
                       │                            │
                       └──────────────► workspace / evidence / game

Eval ───────────────────────► Pi RPC ──► 同一套工具与插件注册器
```

架构只有一个循环、一个活动任务、一个 Pi 进程和一个游戏运行时。Shell 与 Eval 都是适配器，不参与 Agent 决策。

## 四层职责

| 层 | 只负责什么 | 明确不负责什么 | 主要入口 |
|---|---|---|---|
| Shell | HTTP 路由、SSE、左右分栏状态、审批交互 | 不决定工具顺序，不预测 Token，不校验补丁 | `src/shell/server.ts` |
| AppController | 启停 Pi、切换任务、连接 Shell 与 RPC | 不解析模型正文，不执行工具 | `src/app/pi-process.ts` |
| Pi 适配层 | JSONL 边界、请求关联、插件与工具注册 | 不维护第二套 Agent 状态机 | `src/pi/rpc-process.ts`、`src/pi/extension.ts` |
| 领域能力 | workspace、evidence、game、repair 的确定性操作 | 不依赖 Shell 或 Pi SDK | `src/workspace`、`src/evidence`、`src/game`、`src/repair` |

依赖方向始终从上到下。领域层和 Shell 不反向导入 Pi Adapter，架构测试会固定这条规则。

## 一次用户请求如何运行

```text
POST /api/input
  → Shell 将 prompt 原样交给 AppController
  → AppController 发送一条 Pi RPC prompt
  → Pi 原生 Agent Loop 决定何时调用九个工具
  → Extension 只记录请求目标、工具事实和任务状态
  → Pi 发出 agent_settled
  → Shell 解锁输入并展示结果
```

这里没有提交前 Token 预测器、隐藏规划器、自动续跑器或第二个模型循环。上下文自动压缩与失败重试使用 Pi 自带机制；Shell 只保留用户可见的手动压缩入口。

Shell 的请求状态只有四个值：

```text
idle → input ──────► idle
   └→ command ─────► idle
input / command → aborting → idle
```

`requestState` 是唯一请求占用事实，不再组合 `inFlight`、`abort`、`generation` 等多个布尔量。

## `edit` 是一条线性事务

`edit` 是唯一写代码的模型工具。所有必要步骤都在同一次工具执行中完成：

```text
校验参数
  → 取得或复用精确文件授权
  → 校验项目相对路径与 realpath 边界
  → 按 baseHash 执行精确修改
  → 有活动复现时刷新页面并重放
  → 记录 tool.write_outcome 与 game.refresh
```

旧实现中的写前 Map、工具调用前后双重归因和独立 Safety Gate 已删除。工具被 Pi 强制串行，因此不需要猜测哪一次工具结果对应哪一次写入。

仍保留的防御只有三类，而且各自只在边界执行一次：

- 外部输入：HTTP JSON、RPC JSONL、工具 TypeBox schema；
- 文件系统：项目相对路径、realpath、baseHash 和 detached worktree；
- 不可逆动作：首次写入、`/apply` 和 `publish` 的明确授权。

如果代码已经写入但浏览器刷新或复现重放失败，`edit` 会保留 worktree 变化并设置统一刷新失败状态。后续 `check`、`finish(result)` 和 `publish` 会拒绝继续；下一次成功 `edit` 会清除该状态。

## 工具与命令契约

模型侧固定注册九个工具：

```text
inspect  edit  check  finish  workspace  look  act  query  publish
```

用户侧固定注册五个命令：

```text
/play  /diff  /verify  /apply  /discard
```

注册入口统一位于 `src/pi/tools/index.ts` 和 `src/pi/commands/index.ts`。工具名称、参数 schema、返回结构和核心行为由契约测试保护。

## 状态与持久化

`TaskRecord` 使用唯一的 schema v5。任务文件只接受当前版本：遇到旧版本会明确报错并要求新建任务，不执行迁移、字段猜测或宽松修复。

TaskStore 保存任务生命周期和授权；EvidenceStore 保存可审计事实。Evidence 查询直接扫描当前有效记录，不再维护 action/fingerprint 的重复内存索引。两者都使用声明式 TypeBox schema 在读取边界校验一次。

核心任务状态仍保持不变：

```text
created → active → verifying → ready_to_apply → applied
                   │                │
                   └──────────────► blocked

任意可放弃阶段 ──► discarded
```

正式仓库不会被 `edit` 修改。只有验证绑定当前 worktree Hash 后，用户才能显式 `/apply`；`publish` 还会经过完整质量门、临时发布 worktree、commit、push 和 PR 预览，但不会自动合并。

## Shell 为什么拆成四个文件

| 文件 | 阅读时回答的问题 |
|---|---|
| `server.ts` | 服务如何启动和关闭？ |
| `routes.ts` | 页面每个 HTTP 动作会调用什么？ |
| `session.ts` | 当前任务、请求、SSE 和状态如何保存？ |
| `events.ts` | Pi 事件如何归约成页面事件？ |

`server.ts` 不包含业务分支；`routes.ts` 采用一个端点一个处理函数；`events.ts` 按 UI、消息、生命周期三类平级处理。页面模板仍单独放在 `page.ts`。

## Eval 为什么不经过 Shell

Eval 与生产运行共享同一个 `PiRpcProcess`、Extension 和工具注册器，但不启动 HTTP 服务，也不模拟浏览器页面提交。它直接发送 Pi RPC prompt，并自动回复评测中的审批请求。

因此：

- 生产启动不依赖 Eval；
- Eval 不测 Shell 的偶然事件时序；
- Eval 与真实运行仍使用完全相同的 Agent Loop 和工具实现。

## 推荐阅读顺序

首次接手代码时，按下面顺序阅读即可建立完整心智模型：

1. `src/app/pi-process.ts`：看进程和任务如何串起来；
2. `src/pi/extension.ts`：看唯一 Extension 如何装配；
3. `src/pi/tools/index.ts`：看九个工具清单；
4. `src/pi/tools/patch.ts`：看完整写入事务；
5. `src/pi/request-lifecycle.ts`：看请求与会话状态；
6. `src/shell/server.ts` → `routes.ts` → `session.ts` → `events.ts`：看 UI 适配；
7. `src/task/store.ts` 与 `src/evidence/store.ts`：看持久化边界；
8. `src/eval/profiles/maintainer.ts`：看同一核心如何被回归评测驱动。

## 面向甲方的讲解主线

可以用四句话概括设计：

1. **核心不重造**：Pi Loop 负责模型运行、压缩和重试，维护器不再复制这些能力。
2. **功能不缩水**：九个工具、五个命令、游戏复现、验证、应用和发布完整保留。
3. **安全放在真实边界**：只校验外部输入、工作区路径和不可逆授权，不在内部层层猜测。
4. **测试与生产同核**：Shell 和 Eval 都驱动同一个 Pi RPC 与 Extension，避免两套行为逐渐漂移。

这也是本次轻量化的判断标准：删除协调代码，但不删除用户能力；减少内部状态，但不放松真实边界。
