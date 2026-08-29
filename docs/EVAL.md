# 内置 Eval

Eval 把故障复现、现场演示和版本比较放进维护器，但不并入游戏业务代码。它复用正式
Maintainer、Pi 和游戏驱动，不创建第二套 Agent Loop。

## 三个独立边界

```text
eval-datasets/          冻结输入：共享基线、七个场景、复现步骤、隐藏期望
       |
       v
src/eval/               评测程序：读取、物化、执行、判卷、报告、进度页
       |
       v
当前游戏仓库             独立开发；静态合同检查与依赖复用
```

- Dataset 是维护器版本的一部分，不读取当前游戏源码；修改游戏不会自动改变历史评测。
- Eval 只从 `--dependencies` 指定的游戏仓库复用 `game/node_modules`，不会把其中源码当作场景定义。
- `game-contract` 单独检查当前游戏的目录、脚本和开发桥 v3，不读取 Dataset，也不运行场景。
- 新游戏版本要进入评测时，显式生成新的 Dataset 版本；不要原地修改 `eval-v1`。

这样，游戏开发、场景基线和评测执行可以分别变化，彼此通过窄合同连接。

## 目录职责

```text
src/eval/
├─ cli.ts                 # 固定命令解析与分发
├─ config.ts              # Eval 专用 Flash 模型覆盖，不新增密钥来源
├─ game-contract.ts       # 当前游戏的独立静态合同检查
├─ main.ts                # CLI 进程入口
├─ domain/                # 无进程副作用的领域数据与判定
│  ├─ dataset.ts          # Dataset 清单与内容指纹
│  ├─ scenario.ts         # Scenario 读取和严格校验
│  ├─ oracle.ts           # 显式浏览器预检使用的纯 Oracle 规则
│  └─ result.ts           # Profile 共用结果类型
├─ execution/             # 一次或一组评测的运行流程
│  ├─ workspace.ts        # 物化隔离 Git 故障仓库
│  ├─ browser-oracle.ts   # 显式预检的浏览器复现执行器
│  ├─ preflight.ts        # 可选的零模型故障/干净基线诊断
│  ├─ llm-judge.ts        # 单次 Flash 宽松功能判定
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
pnpm eval -- check
pnpm eval -- game-contract --repo "C:\path\to\select-from-dungeon"
```

`check` 校验内置 Dataset 的目录、schema、场景顺序和内容指纹。`game-contract` 只做静态合同检查；
游戏还在修改时它可以失败，但不会改变 Dataset。

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

`preflight` 是显式诊断命令，用来检查故障版、干净版、浏览器驱动和精确 Oracle 是否仍能协同工作。
`run`、`suite` 和 `compare` 不会自动运行、读取或要求预检证书。

单场景真实运行：

```powershell
pnpm eval -- run `
  --scenario terminal-action-bug `
  --profile maintainer `
  --dependencies "C:\path\to\select-from-dungeon"
```

运行完整 Dataset：

```powershell
pnpm eval -- suite `
  --dataset eval-v1 `
  --profile maintainer `
  --workers 2 `
  --dependencies "C:\path\to\select-from-dungeon" `
  --ui progress
```

同条件比较当前维护器与 Pi 基线：

```powershell
pnpm eval -- compare `
  --dataset eval-v1 `
  --workers 1 `
  --dependencies "C:\path\to\select-from-dungeon" `
  --ui progress
```

默认的单次 Run 保持短链路：

```text
物化故障仓库
  -> Pi 修复
  -> Git 硬门禁
  -> 单次 Flash LLM Judge
  -> schema v6 结果
```

Eval Agent、Pi Baseline 和 Judge 都复用当前维护器的 API Key 与 Base URL，并在 Eval 内固定使用
`deepseek-v4-flash`、关闭 reasoning；这不会改变生产维护器的默认模型。Judge 每个 Run 最多请求一次，
不重试，使用 `temperature=0`、`max_tokens=128` 和 30 秒超时。

单 Profile 默认 2 个 Worker，对比默认 1 个 Worker，可显式设置为 1 至 4。每个 Worker 拥有独立
Workspace 和 Pi Session；Maintainer Profile 按正常产品流程独立启动所需端口和 Chromium Context，
Judge 本身不启动浏览器。单个 Job 失败不会中止其它 Job，最终结果仍按 Dataset 顺序输出。多 Worker
的耗时不与单 Worker 历史结果直接比较，报告会写出 `timingComparable`。

`--resume <归档目录>` 只恢复运行身份一致的 checkpoint。Dataset、维护器工作树、模型配置或
Judge 版本任一变化，旧 checkpoint 都不会复用。

## Dataset

```text
eval-datasets/eval-v1/
├─ dataset.json           # 固定场景顺序
├─ base/                  # 一份共享干净仓库
└─ scenarios/<id>/        # 公开任务、复现、隐藏期望和故障补丁
```

生产代码对外统一使用 `scenarioId`。冻结 JSON 仍保留历史字段 `fixtureId`，只作为 `eval-v1` 的
只读兼容格式，不扩散到 CLI、报告或新代码命名。

## 判分与隐私

默认 Run 先确认故障补丁已经物化。Agent 只看到公开任务和正常产品上下文；`expected.json`、答案 SQL
和浏览器 Oracle 规则不会进入 Prompt。Agent 结束后先执行三个廉价 Git 硬门禁：`HEAD` 未改变、
禁写路径未改变、存在有效 Git Diff。任一硬门禁失败都不会调用 Judge。

通过硬门禁后，Judge 只接收公开任务、故障注入补丁和候选 Diff。只要候选修改能恢复公开任务描述的
正常功能且没有明显回归即通过；不要求固定实现、完整测试、格式偏好或维护器工作流闭环。模型回复只
接受固定 JSON 和四个原因码：`function-restored`、`no-effective-change`、
`function-not-restored`、`obvious-regression`。请求失败或回复非法记为基础设施错误，不做重试。

工作流闭环继续写入诊断字段，但不决定功能是否通过。显式 `preflight` 仍可用浏览器分别验证故障版和
干净版；Suite 不消费其结果，因此 Suite 通过不等于浏览器端到端验证通过。

Suite 报告使用 schema v6，并在 `usage` 中汇总 `agentTokens`、`judgeTokens`、`totalTokens`、
`toolCalls`、`sumAgentDurationMs`、`sumRunDurationMs` 和 `suiteWallDurationMs`。其中
`toolCalls` 只统计 Agent 工具调用；进度页累计 Token 包含 Agent 与 Judge。
`suiteWallDurationMs` 统计本次 Suite 命令的墙钟；使用 `--resume` 时不追溯上一次进程已经消耗的墙钟。

归档只保存结果、低敏诊断和指纹，不保存 Prompt、thinking、工具参数、源码、SQL、隐藏答案、
凭据、浏览器帧或临时绝对路径。进度页中的 Agent 可见回复只驻留内存。
