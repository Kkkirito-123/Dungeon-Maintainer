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
├─ game-contract.ts       # 当前游戏的独立静态合同检查
├─ main.ts                # CLI 进程入口
├─ domain/                # 无进程副作用的领域数据与判定
│  ├─ dataset.ts          # Dataset 清单与内容指纹
│  ├─ scenario.ts         # Scenario 读取和严格校验
│  ├─ oracle.ts           # 纯 Oracle 规则
│  └─ result.ts           # Profile 共用结果类型
├─ execution/             # 一次或一组评测的运行流程
│  ├─ workspace.ts        # 物化隔离 Git 仓库
│  ├─ browser-oracle.ts   # 浏览器复现与判卷执行器
│  ├─ preflight.ts        # 零模型故障/干净基线预检
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

游戏准备好以后再运行。本轮重构不执行这些命令。

单场景零模型预检：

```powershell
pnpm eval -- preflight `
  --scenario terminal-action-bug `
  --dependencies "C:\path\to\select-from-dungeon"
```

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

单 Profile 默认 2 个 Worker，对比默认 1 个 Worker，可显式设置为 1 至 4。每个 Worker 拥有独立
Workspace、Pi Session、端口和 Chromium Context；单个 Job 失败不会中止其它 Job，最终结果仍按
Dataset 顺序输出。多 Worker 的耗时不与单 Worker 历史结果直接比较，报告会写出
`timingComparable`。

`--resume <归档目录>` 只恢复运行身份一致的 checkpoint。Dataset、维护器工作树、模型配置或
Oracle 版本任一变化，旧 checkpoint 都不会复用。

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

每个 Scenario 先证明故障版失败、干净版通过，成功后生成绑定运行身份的预检证书。Agent 只看到
公开任务和正常产品上下文；`expected.json`、答案 SQL 和 Oracle 规则不会进入 Prompt。

Agent 结束后，外部 Oracle 再判断功能结果和 Git 安全边界。工作流闭环与外部正确性分开报告，
不会把“功能正确但流程未闭环”误写成“功能错误”。

归档只保存结果、低敏诊断和指纹，不保存 Prompt、thinking、工具参数、源码、SQL、隐藏答案、
凭据、浏览器帧或临时绝对路径。进度页中的 Agent 可见回复只驻留内存。
