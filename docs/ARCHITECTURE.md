# Dungeon Maintainer 架构

这份文档是维护器架构的唯一说明。README 负责运行方式，EVAL.md 负责评测；这里回答代码放在哪里、
模块如何依赖，以及新手应从哪里开始读。

## 一句话架构

Dungeon Maintainer 是一个带真实游戏环境和确定性安全门禁的单 Pi Agent Loop。

```text
用户 / Chromium Shell
        |
        v
AppController
启动一个 Task、一个 Pi、一个 Vite、一个 Chromium Context
        |
        v
Pi Agent Loop
        |
        v
Dungeon Extension
固定工具 + 当前任务 Evidence + 写入安全
        |
        +----------+-----------+-----------+
        v          v           v           v
   Inspection   Workspace    Repair       Game
   代码定位      Git/Hash      刷新重放     玩家操作
```

系统中没有第二个模型循环、隐藏规划器、后台 Agent、架构路由或跨任务方案记忆。

## 运行流程

```text
用户描述问题
  -> Pi 使用 inspect 或游戏工具调查
  -> Evidence 保存当前任务事实
  -> 首次写入请求用户批准
  -> 修改 detached worktree
  -> 刷新游戏并恢复检查点
  -> 重放玩家动作
  -> 运行固定检查
  -> finish(result)
  -> 用户 /apply
```

没有下一次工具调用时，Pi 按原生语义 `agent_settled`。维护器不会自动追加模型回合。

## 代码地图

```text
src/
├─ main.ts                 # start / resume / eval 命令分发
├─ app/                    # 启动、恢复和任务生命周期
├─ pi/                     # Pi 适配层
│  ├─ extension.ts         # 薄装配入口
│  ├─ native-write.ts      # edit 授权、Hash 归因和刷新失败门禁
│  ├─ request-lifecycle.ts # 输入、settled 和 shutdown
│  ├─ tool-safety-gate.ts  # 授权、allowedPaths 和 realpath
│  ├─ game-runtime.ts      # Vite/Chromium 生命周期
│  └─ tools/               # Pi 工具参数与注册
├─ inspection/             # 搜索、读取和 bundle
├─ evidence/               # 当前任务证据、缓存与失效关系
├─ workspace/              # Git、路径、Hash、patch、check、apply
├─ repair/                 # 复现、刷新、重放和验证
├─ game/                   # GameDriver、浏览器和开发桥协议
├─ shell/                  # 本地 HTTP/SSE 与前端页面
├─ task/                   # TaskStore 和状态机
├─ logging/                # 脱敏事件和语义 Trace
└─ eval/                   # 独立的内置评测
   ├─ domain/              # Dataset、Scenario、Browser Oracle 和结果契约
   ├─ execution/           # Workspace、Browser Oracle、预检、Run、Worker Pool 和 Suite
   ├─ profiles/            # Maintainer 与 Pi Baseline
   ├─ reporting/           # Identity、checkpoint 和汇总
   └─ ui/                  # 本地进度页和 SSE
```

### 依赖方向

```text
main -> app -> pi
             |
             +-> inspection -> evidence/workspace
             +-> repair -> game/workspace/task
             +-> shell

eval -> game + app/pi 的正式能力
```

领域模块不反向导入 `pi/extension.ts`，Shell 不根据遥测决定 Agent 行为，Eval 不向 Agent 反馈
Oracle 结果。`tests/architecture.test.ts` 固定检查这些边界。

## 固定工具

Pi 不加载任何原生工具或 Bash。模型工具固定且仅为：

```text
inspect  edit  check  finish  workspace
look     act   query
```

- `inspect` 统一查看源码、Git 与当前任务 Evidence。
- `edit` 使用当前 `baseHash` 做唯一替换、整文件写入或创建，并受精确路径授权和 3 文件/120 行预算约束。
- `workspace` 只查看或切换合法 Git worktree，不能偷换当前会话 cwd。
- `look/act/query` 只操作玩家可见游戏面；`act` 绑定最新 revision，`query` 合并 SQL 输入和真实提交。

工具名是外部契约，不随内部文件拆分变化。

## 领域词典

| 概念 | 固定名称 | 含义 |
|---|---|---|
| `Task` | 维护任务 | 一个来源仓库、detached worktree 和 Pi Session |
| `Evidence` | 当前任务证据 | 事实、Hash、关系和安全工件 |
| `Inspection` | 代码检查 | 搜索、读取、目录和 bundle |
| `Repair` | 修复闭环 | 复现、刷新、重放和验证 |
| `GameRuntime` | 游戏运行环境 | Vite、Chromium 和 GameDriver 生命周期 |
| `EvalScenario` | 故障场景 | 公开任务、复现步骤和隐藏 Oracle 规格 |
| `EvalRun` | 单次评测 | 一个 Scenario、Profile 和结果 |
| `EvalSuite` | 评测集合 | 固定场景、重复次数和独立 Worker 的并行编排 |
| `EvalOracle` | 浏览器功能判定 | 正式 Run 的单次隐藏 after 验收，并供预检校准故障版与干净版 |
| `EvalPreflight` | 浏览器诊断 | 可选地证明故障版失败且干净版通过，不阻塞 Suite |

禁止使用不能表达领域含义的 `Manager`、`Helper`、`Utils`、`Common` 和泛化 `Service`。

### 函数命名

| 前缀 | 含义 |
|---|---|
| `readX` | 读取外部或持久化数据 |
| `writeX` | 写入持久化数据 |
| `runX` | 执行一个完整流程 |
| `registerX` | 注册 Pi 工具、命令或 Hook |
| `parseX` | 解析并校验外部输入 |
| `isX / hasX / canX` | 返回布尔判断 |
| `requireX / assertX` | 不满足条件时抛错 |
| `createX` | 构造对象，不启动长期流程 |

## 安全边界

- Agent 只修改 detached worktree；正式仓库仅由用户显式 `/apply` 改变。
- 所有模型路径必须是项目相对路径，并经过 `realpath` 和符号链接检查。
- `.git`、`.env*`、凭据、法律文件、生成目录和仓库外路径始终拒绝。
- 第一次写入按精确文件请求批准，批准只在当前请求有效。
- 源码变化会使旧检查和旧验证失效。
- `/apply` 再检查来源漂移、worktree Hash、文件基线和 `git apply --check`。
- 模型不获得 Bash、任意浏览器脚本、隐藏答案、完整地图或正式存档。

## 状态与持久化

```text
created -> active -> verifying -> ready_to_apply -> applied
             |
             +-> awaiting_approval
             +-> blocked / discarded
```

`TaskStore` 使用原子替换保存任务。Pi Session 正文只保存在任务的 `pi/` 目录；事件日志只允许
脱敏标量。Evidence 只属于当前任务，源码变化会使相关旧证据失效。

## Eval 边界

```text
EvalScenario
  -> 物化故障仓库
  -> 单个 Pi 修复
  -> 首次 agent_settled
  -> Profile 停止 Pi 并卸载本轮工具
  -> 单次隐藏 after browser Oracle
  -> schema v7 EvalRunResult / EvalSuiteReport
```

Eval 内部为 Agent 与 Pi Baseline 复用当前 Key 与 Base URL，统一固定 `deepseek-v4-flash` 并关闭
reasoning，不改变生产维护器默认模型。首次 `agent_settled` 表示本次 Profile 正常结束；Profile 停止
并卸载工具后，外层 Run 才启动隐藏 Browser Oracle，不再调用第二个模型，也不向 Agent 反馈结果。

故障成功物化是判分基础；PASS 只要求 `agentSettled && afterOracleMatched`。Eval 不比较候选代码、Diff
或参考实现。每个 Run 拥有独立 Workspace、Pi Session、Vite 和 Chromium，Worker 之间不共享运行态。

`EvalPreflight -> Browser Oracle` 是单独的显式校准路径，用于证明故障版失败且干净版通过；默认
`run`、`suite` 和 `compare` 不读取或要求预检证书，而是各自只执行一次候选 after Oracle。
详细命令、schema v7 和 Token/工具/时间统计口径见 [EVAL.md](EVAL.md)。

## 新手阅读顺序

第一次阅读只看下面七处：

1. `src/main.ts`：有哪些命令。
2. `src/app/start.ts`：任务如何启动。
3. `src/pi/extension.ts`：Pi 如何装配。
4. `src/pi/tools/index.ts`：有哪些工具。
5. `src/pi/tools/inspect.ts`：薄工具适配是什么样子。
6. `src/workspace/apply.ts`：正式仓库何时改变。
7. `src/eval/execution/suite.ts`：如何运行整组真实故障。

读完这条主线，再按问题进入 inspection、evidence、repair 或 game，不需要先理解整个仓库。

## 验证门禁

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

游戏仍在开发时停在维护器自身门禁和 `pnpm eval -- check`；需要校准故障版失败、干净版通过以及
精确 Oracle 的真实集成时，再显式运行零模型 `preflight`。该校准不阻塞默认 Suite；正式 Run 仍会
独立执行一次候选 after Oracle。
