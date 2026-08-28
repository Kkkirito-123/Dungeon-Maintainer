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
│  ├─ native-write.ts      # 原生 write 批次、归因和刷新
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
   ├─ domain/              # Dataset、Scenario、Oracle 和结果契约
   ├─ execution/           # Workspace、预检、Run、Worker Pool 和 Suite
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

Pi 原生只加载完整文件写入工具 `write`。领域工具固定为：

```text
inspect  evidence  patch  check  finish
look     go        use    input_sql  query  tree
```

- `inspect(files)` 查看源码目录；`tree` 专门查看或切换 Git worktree，两者不再同名。
- `patch` 使用 `baseHash` 做唯一旧文本替换；`write` 写完整文件。
- `look/go/use/input_sql/query` 只操作玩家可见游戏面。
- `evidence` 只回读当前任务事实，不提供跨任务 Solution。

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
| `EvalOracle` | 判卷规则 | Agent 结束后的外部功能判断 |
| `EvalPreflight` | 故障预检 | 证明故障版失败且干净版通过 |

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
  -> EvalPreflight
  -> 单个 Pi 修复
  -> agent_settled
  -> EvalOracle + Git 安全检查
  -> EvalRunResult / EvalSuiteReport
```

现场演示、CI 和版本对比共用同一个 Runner。Oracle 只在 Agent 结束后判卷，不泄漏答案、不修改
Prompt、不控制工具选择。详细命令和报告字段见 [EVAL.md](EVAL.md)。

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

游戏仍在开发时停在维护器自身门禁和 `pnpm eval -- check`；游戏稳定后再运行零模型
`preflight`，证明物化、浏览器和 Oracle 的真实集成可用。
