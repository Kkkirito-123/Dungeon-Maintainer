# 内置 Eval

Eval 把故障复现、现场演示和版本比较放进维护器，但不并入游戏业务代码。它复用正式
Maintainer、Pi 和游戏驱动，不创建第二套 Agent Loop；场景由当前游戏仓库的 Adapter 实时提供。

## 三个独立边界

```text
当前游戏仓库             benchmark/agent-evals + scripts/benchmark-adapter.mjs
       |
       v
src/eval/               评测程序：读取 Adapter、物化、执行、判卷、报告、进度页
       |
       v
当前游戏仓库             独立开发；静态合同检查与依赖复用
```

- Adapter 每次从 `--dependencies` 指定的当前游戏工作树读取场景和源码；修改游戏后下一次运行即使用新内容。
- 物化目标是临时单提交 Git 仓库，并在其中保持本次测试的故障状态；真实游戏分支不切换、不写入。
- Eval 只复用游戏仓库的 `game/node_modules`，不会把隐藏复现、期望或 benchmark 定义复制到目标仓库。
- `game-contract` 单独检查当前游戏的目录、脚本和协议 1.0 开发桥，不读取隐藏数据，也不运行场景。

这样，游戏开发、场景基线和评测执行可以分别变化，彼此通过窄合同连接。

## 目录职责

```text
src/eval/
├─ cli.ts                 # 固定命令解析与分发
├─ config.ts              # 被测 Agent 专用 Flash 模型覆盖，不新增密钥来源
├─ game-contract.ts       # 当前游戏的独立静态合同检查
├─ main.ts                # CLI 进程入口
├─ domain/                # 无进程副作用的领域数据与判定
│  ├─ dataset.ts          # 当前游戏 Adapter 清单与内容指纹
│  ├─ scenario.ts         # Scenario 读取和严格校验
│  ├─ oracle.ts           # 正式 after 验收与显式预检共用的纯 Oracle 规则
│  └─ result.ts           # Profile 共用结果类型
├─ execution/             # 一次或一组评测的运行流程
│  ├─ workspace.ts        # 物化隔离 Git 故障仓库
│  ├─ browser-oracle.ts   # 隐藏浏览器复现与功能判定执行器
│  ├─ preflight.ts        # 可选的零模型故障失败/干净通过校准
│  ├─ run.ts              # 单 Scenario 执行
│  ├─ suite.ts            # Worker 池、整组执行与恢复
│  └─ progress.ts         # 低敏进度事件
├─ profiles/              # 可替换但互不依赖的 Agent Profile
│  ├─ maintainer.ts       # 当前维护器
│  └─ pi-baseline.ts      # 原始 Pi 基线
├─ reporting/             # 身份、checkpoint 和汇总
└─ ui/                    # 静态进度页与本地 SSE 服务
```

依赖方向固定为：

```text
cli -> execution -> domain
       |     |
       |     +-> profiles
       +-------> reporting
ui 仅接收 progress 事件
```

`domain` 不启动进程，Profile 之间不互相导入，`ui` 不决定评测行为，Oracle 结果不反馈给 Agent。

## 测试前检查

游戏尚未稳定时，只运行下列命令。它们不会启动 Vite、Chromium、模型或七个正式场景：

```powershell
pnpm eval -- check --repo "C:\path\to\select-from-dungeon"
pnpm eval -- game-contract --repo "C:\path\to\select-from-dungeon"
```

`check` 校验当前游戏 Adapter 的目录、schema、场景顺序和内容指纹。`game-contract` 只做静态合同检查；
游戏还在修改时它可以失败，但不会写入游戏仓库。

维护器自身的开发门禁同样不执行正式场景：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 正式场景命令

付费运行只在用户明确要求时执行。

单场景零模型浏览器诊断：

```powershell
pnpm eval -- preflight `
  --scenario terminal-action-bug `
  --dependencies "C:\path\to\select-from-dungeon"
```

`preflight` 是显式校准命令：故障版必须命中 before 失败 Oracle，干净版必须命中 after 通过 Oracle。
`run`、`suite` 和 `compare` 不会自动运行、读取或要求预检证书；它们只在 Agent 结束后对候选工作区
执行一次隐藏 after Oracle。

单场景真实运行：

```powershell
pnpm eval -- run `
  --scenario terminal-action-bug `
  --profile maintainer `
  --dependencies "C:\path\to\select-from-dungeon"
```

运行 Adapter catalog 中的完整套件：

```powershell
pnpm eval -- suite `
  --profile maintainer `
  --workers 2 `
  --dependencies "C:\path\to\select-from-dungeon" `
  --ui progress
```

同条件比较当前维护器与 Pi 基线：

```powershell
pnpm eval -- compare `
  --workers 1 `
  --dependencies "C:\path\to\select-from-dungeon" `
  --ui progress
```

默认的单次 Run 保持短链路：

```text
物化故障仓库
  -> Pi 修复，首次 agent_settled 即正常结束
  -> Profile 停止 Pi 并卸载本轮工具
  -> 候选工作区单次隐藏 after browser Oracle
  -> schema v7 结果
```

Eval Agent 与 Pi Baseline 复用当前维护器的 API Key 与 Base URL，默认使用 `deepseek-v4-flash`；
需要跨模型实测时可用 `DUNGEON_EVAL_MODEL` 显式选择同一模型。Eval 始终关闭 reasoning，且不会改变生产维护器的默认模型。Agent settled 后不再调用
第二个模型，功能结果只来自隐藏浏览器 Oracle。

单 Profile 默认 2 个 Worker，对比默认 1 个 Worker，可显式设置为 1 至 4。每个 Worker 拥有独立
Workspace 和 Pi Session；每个 Run 的 Vite、Chromium 与工具生命周期也彼此独立。隐藏 Oracle 只在
该 Profile 已停止并卸载工具后启动，不向 Agent 反馈结果。单个 Job 失败不会中止其它 Job，最终结果
仍按 Adapter catalog 顺序输出。多 Worker 的耗时不与单 Worker 历史结果直接比较，报告会写出
`timingComparable`。

`--resume <归档目录>` 只恢复运行身份一致的 checkpoint。当前游戏工作树、维护器工作树、模型配置或
Oracle 版本任一变化，旧 checkpoint 都不会复用。

## 当前游戏 Adapter

```text
select-from-dungeon/
├─ scripts/benchmark-adapter.mjs  # catalog/describe/materialize 协议
└─ benchmark/agent-evals/<id>/    # 公开任务、复现、隐藏期望和故障补丁
```

生产代码对外统一使用 `scenarioId`。Adapter JSON 使用 `fixtureId` 作为协议字段；维护器内部不会
保留第二份场景快照。`sourceFingerprint` 绑定当前游戏 HEAD、工作树和 Adapter，工作树变化会使
旧的预检证书和 checkpoint 失效。

## 判分与隐私

默认 Run 先确认故障补丁已经物化。Agent 只看到公开任务和正常产品上下文；`expected.json`、答案 SQL
和浏览器 Oracle 规则不会进入 Prompt。第一次真实 `agent_settled` 表示本次 Agent 回合正常结束；
Profile 随后停止 Pi、Shell 并卸载本轮工具，外层 Run 才在候选工作区执行一次隐藏 after Oracle。

PASS 的功能公式固定为 `agentSettled && afterOracleMatched`，故障成功物化是进入判分的基础前提。
评测不比较代码、Diff、测试数量或参考实现，也不要求候选修复与原实现一致；维护器工作流闭环只作为
诊断字段。after Oracle 失败即功能未恢复，浏览器或评测基础设施失败则单独记为基础设施错误。

显式 `preflight` 只校准当前 Adapter：故障版应失败、干净版应通过。Suite 不消费其证书，也不会把这两次
校准重复到每个正式 Run；正式 Run 始终只有一次候选 after Oracle。

Suite 报告使用 schema v7，并在 `usage` 中汇总 `agentTokens`、`totalTokens`、`toolCalls`、
`sumAgentDurationMs`、`sumOracleDurationMs`、`sumRunDurationMs` 和 `suiteWallDurationMs`。其中
`toolCalls` 只统计 Agent 工具调用，Token 也只来自被测 Agent。
`suiteWallDurationMs` 统计本次 Suite 命令的墙钟；使用 `--resume` 时不追溯上一次进程已经消耗的墙钟。

归档只保存结果、低敏诊断和指纹，不保存 Prompt、thinking、工具参数、源码、SQL、隐藏答案、
凭据、浏览器帧或临时绝对路径。进度页中的 Agent 可见回复只驻留内存。
