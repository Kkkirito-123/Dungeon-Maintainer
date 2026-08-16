# Dungeon Maintainer V1 设计

## 1. 设计目标

Dungeon Maintainer V1 把通用 Coding Agent 缩减为 SQL Dungeon 专用维护循环。模型负责理解问题、
选择工具和总结证据；确定性代码负责所有可产生副作用或泄露风险的行为。实机试玩由同一个 Pi
Agent 指挥，游戏桥只执行经过约束的工具动作。

```text
用户问题 / 游戏内按钮
  -> CLI / DashboardController / TaskStore
  -> Pi Agent
      -> inspect：有限代码证据
      -> patch：隔离 worktree 精确替换
      -> check：固定质量门禁
      -> play：Pi Agent 选择游戏工具，浏览器桥执行真实试玩
      -> finish：证据核验与补丁封装
  -> 用户 approve / apply
  -> 目标工作区
```

V1 不追求通用仓库支持、自主 Shell、自动发布、多 Agent 编排、长期记忆、HTTP 服务或独立 Web
控制台。它只提供由本地 CLI 持有的同窗 Dashboard；适配器只支持带有严格
`.maintainer/project.json` 标识的 SQL Dungeon 仓库。

## 2. Pi Runtime 与自有代码边界

Pi Core 只提供以下成熟基础能力：

- `Agent` 和 `AgentTool` 工具循环；
- 模型流式事件和 usage；
- `beforeToolCall` / `afterToolCall` 生命周期；
- `AbortSignal` 取消；
- `transformContext` 和 token 估算。

Pi 不决定路径是否可读、代码是否核心、补丁能否落地或检查是否真实通过。这些约束分别由
`safety/policy.ts`、`safety/worktree.ts`、`tools/check.ts` 和 `tools/finish.ts` 强制执行。
因此即使 prompt 被忽略、模型返回额外字段或供应商行为异常，工具协议和执行层仍会拒绝越权。

Runtime 固定每个模型回合只能调用一个工具；普通维护任务注册 `inspect/patch/check/finish`，试玩
任务再注入 `look/go/use/query`。Dashboard 排查阶段不注册 `patch/check`，修复阶段才恢复；权限
差异由工具列表和执行层共同强制，不依赖 Prompt。恢复核心
审批时创建新的 Agent 会话，只把任务目标和已批准路径重新交给模型，要求它重新 `inspect`；不把
旧代码正文持久化后重放。

## 3. 任务状态与审批

正常路径：

```text
created -> diagnosing -> editing -> verifying -> ready_to_apply -> applied
                 |            |
                 +-> needs_approval -> approved -+
applied -> reverted
```

异常终态为 `blocked`、`aborted`、`failed` 和 `reverted`。`blocked` 可用于明确的环境或证据阻断；
非法迁移由 `TaskStore` 拒绝。只读诊断以 `finish(diagnosed)` 的业务结果结束，不制造补丁。

核心路径包括领域规则、课程内容、存储、契约、应用层、入口、配置、依赖、脚本、CI、试玩桥和
在线 Agent。自动范围只包含游戏文档、测试和小型展示层。法律文件、凭据、`.git` 与生成目录永久
禁止写入。

核心 `patch` 在执行前产生十分钟有效的随机 token。任务文件只保存以下摘要：

```text
SHA-256({ taskId, baseHead, sortedPaths, token })
```

用户重新输入 token 后，批准只覆盖同一任务、同一 Git 基线和精确路径列表；token 立即标记为已
使用。新增核心路径会再次暂停，不能继承旧批准。

## 4. 路径和补丁安全

所有模型路径必须是无 NUL、无绝对地址、无 `..` 的项目相对路径。执行层先解析仓库真实根路径，
再解析目标或最近存在的父目录；若 `realpath` 落到仓库外，即使表面路径仍在仓库中，也按符号链接
逃逸拒绝。

`inspect read` 返回完整文件 SHA-256 作为 `baseHash`。`patch` 写入前重新计算 Hash，只有完全
一致才执行；已存在文件要求 `oldText` 恰好出现一次，新文件要求 `baseHash="missing"` 且
`oldText=""`。工具不支持删除、移动、模糊匹配、整文件任意覆盖或二进制修改。

任务累计补丁预算为最多 3 个文件、120 行成本。拆成多个工具调用仍共享同一预算；超限会停止
自动修改并要求用户缩小范围或人工处理。预算是限制模型影响面的硬边界，不因 prompt 改变。

Dashboard 修复还增加浏览器前置检查点：`patch` 完成全部 Hash、权限、唯一匹配和预算校验后，
必须先调用会话 `checkpoint()`，成功后才写入第一字节源码。检查点失败时 worktree 保持原样；
写入后 Vite 刷新必须明确恢复并核对公开楼层、模式、生命和进度，否则隐藏复测直接阻断。

## 5. Git 检查点、应用与回滚

`fix` 创建任务时记录目标仓库 `baseHead`，并从该提交创建 detached worktree。目标工作区必须
干净且 HEAD 未漂移。模型只读写任务 worktree，目标分支在整个诊断、修改和验证阶段保持不变。
Git 不会复制被忽略的 `game/node_modules`；若目标仓库已经安装依赖，worktree 只在同名忽略目录
创建链接以复用可再生依赖。路径策略永久禁止模型访问该目录，链接也不进入 Diff、Hash 或补丁。

`finish(ready)` 从 worktree 生成 `patch.diff`。它先确认目标仍干净且 HEAD 等于 `baseHead`，再用
Git clean filter 验证目标文件仍对应基线 blob，最后保存目标工作区的真实字节 Hash。这样既能识别
被隐藏的内容漂移，也不会因 Windows CRLF 与 Git blob 的 LF 规范化而误报冲突。
`reverse.diff` 保存同一份已验证补丁，回滚时由 `git apply --reverse` 解释方向，避免两份补丁独立
生成后漂移。

显式 `apply` 依次检查：

1. 任务状态为 `ready_to_apply`；
2. 目标工作区干净；
3. 当前 HEAD 等于 `baseHead`；
4. 每个目标文件当前 Hash 等于保存的基线 Hash；
5. `git apply --check` 成功。

任一条件失败都不写入目标文件。应用后保存每个文件的新 Hash；`revert` 只有在这些 Hash 仍完全
一致时才执行反向检查和反向应用，防止覆盖用户在补丁之后的继续修改。应用和回滚都不提交 Git。

## 6. 五工具契约

### inspect

提供 `status/tree/search/read/diff`。每次输出最多 400 行或 48 KiB，并附证据 ID 和内容 Hash；
单文件读取按行分页，文件上限 2 MiB。搜索通过 `execFile` 固定调用 `rg --json`，逐条解析并再次
执行路径白名单；异常时不回传可能未过滤完整的 stdout，只返回中性错误分类。

### patch

接收最多三个精确编辑项，每项包含 `path/baseHash/oldText/newText`。路径策略、核心批准、隐私
正文、唯一匹配和任务预算在写入前统一检查；返回路径与新 Hash，不把补丁正文重复写入审计日志。

### check

模型只能选择适配器代码内登记的检查 ID，不能提供命令、参数、cwd 或环境变量。子进程环境移除
常见凭据字段；完整脱敏日志写入任务目录，模型只接收状态和最后 80 行。

### review / play

每个场景创建一个 Pi Agent 会话，模型在每次语义反馈后选择 `look/go/use/query`，也可以在发现客观
代码问题后选择 `inspect/patch/check/finish`。`go` 的一次调用最多执行 64 个真实步；BFS、目标
不可达时的 frontier 回退和战斗/交互/楼层变化停止由桥内部完成。模型不会逐格调用，也不会收到
管理员答案或隐藏裁判；单层失败不阻止后续楼层，左侧页面会实时显示回合、工具、结果和 Token。

### dashboard

`dashboard --repo <path> [--floor 1..8]` 只接受干净目标仓库，创建 `source=dashboard` 的 fix 任务和
detached worktree，再从该 worktree 启动 Vite 与可视 Chromium。Node 只向页面注入
`__DUNGEON_QUICK_CHECK__`、`__DUNGEON_QUICK_FIX__`、`__DUNGEON_APPLY_FIX__` 三个无参数
函数；网页不能提交路径、Prompt、SQL、Shell、检查 ID 或批准 token。同一时刻只有一个作业，
互斥标记在任何异步任务读取前设置，重复调用返回 `busy`。

快速排查复用当前浏览器会话和点击时楼层，不调用 `openScenario`，只提供
`look/go/use/query/inspect/finish`，并强制绕过两级 PASS 缓存。`finish` 必须返回经过纯文本、
敏感内容和路径策略校验的 `fault/healthy/blocked` 结构化诊断。只有 `fault` 且存在许可路径时才
能修复。修复继续复用同一任务和页面；核心文件暂停到终端批准，批准命令只更新任务，用户回到
页面点击 `继续修复` 后恢复。模型声明 ready 只是候选，固定检查和隐藏复测都通过后才封装补丁。

### finish

只接受 `diagnosed/needs_approval/ready/blocked`。`ready` 必须至少声明一个检查 ID，且该检查在
当前完整 worktree Hash 下确实通过；模型不能凭文字伪造门禁。Dashboard 的 diagnosis 最多六条
证据和三个规范化路径，拒绝 HTML、控制字符、SQL、凭据和完整游戏状态。成功后生成中文报告、
正向补丁和反向补丁，但不应用到目标仓库。

## 7. 检查与 Harness 缓存

检查缓存键不是时间或文件名，而是当前 Git HEAD、已跟踪 Diff 和未跟踪文件内容共同计算的
SHA-256。`check` 使用 `checkId + worktreeHash`；任意代码字节变化都会使旧检查结果失效。

Harness 有两级独立缓存，磁盘只保存 Hash、净化动作和有限裁判摘要：

- 决策缓存键包含适配器版本、场景、模型身份和完整可见轨迹；时间戳、usage 与 tool-call ID 不参与
  Hash。仅 `look/go/use/query` 的严格参数可以重放，TTL 为 10 分钟，上限 256 条；代码工具、
  `finish`、SQL、Key、prompt 与 completion 永不缓存。
- 结果缓存键包含适配器版本、场景和完整 worktree Hash；只保存隐藏裁判确认的 PASS，TTL 为
  24 小时，上限 128 条。命中后不启动浏览器、不调用模型，并明确显示 `0 TOKENS`。
- `--fresh` 同时绕过两级 Harness 缓存。缓存损坏、过期或写入失败只会回退正常模型路径，不能
  放宽工具、审批或路径权限。

未命中结果缓存时才创建新的临时 Chromium Context、Pi 会话和报告目录。任务只保存
`key/hash/status/reportPath` 索引，不保存提示词、回复正文或游戏快照。

## 8. 上下文与资源控制

普通维护会话硬限制为 20 个模型回合和 40 次工具调用；完整八层 Harness 每层明确使用 64/64；
Dashboard 快速排查使用 6/6/8000 个新增 Token，现场修复使用 20/40 和任务剩余 Token。整个任务
硬限制为 64000 个累计 Token。八层套件按场景重置局部计数基线，因此某层达到局部限额仍能记录
后继续下一层；核心审批、取消、供应商失败或总 Token 到顶会立即停止。Pi transcript 只存在当前进程；
`session.jsonl` 记录事件类型、工具名、状态和 usage，不保存消息正文。

当估算上下文达到模型窗口约 75% 时，发送给模型的视图被替换为“确定性事实摘要 + 最近完整工具
调用链”。摘要只保留：

- 原始任务目标、模式和 Git 基线；
- 当前状态与精确批准路径；
- 已修改文件；
- 已通过检查；
- 失败或阻断检查。

它不保留进度日志、API Key、SQL、地图、浏览器快照或补丁正文。若无法找到不拆断 tool call 与
tool result 的安全切点，则不压缩，避免制造无效上下文。

## 9. Pi Agent 试玩与 BFS

SQL Dungeon 开发态桥协议为 v2：

```ts
interface DungeonPlaytestBridge {
  version: 2;
  readonly checkpointRestored: boolean;
  checkpoint(): boolean;
  look(): PlaytestView;
  go(target: "objective" | "frontier", maxSteps: number): Promise<PlaytestResult>;
  use(actionId: string): Promise<PlaytestResult>;
  query(): Promise<PlaytestResult>;
  judge(floor: number): PlaytestJudge;
}
```

`checkpoint` 是维护器刷新控制专用扩展，只把完整 Run/Profile 放入当前临时 Chromium Context 的
一次性 `sessionStorage`。页面启动时读取后立即删除，并向 Node 暴露不含数据的恢复布尔值；恢复
失败时不得回到楼层初始状态继续伪造成功。普通试玩仍只使用五个既有动作/裁判方法。

桥只在 `import.meta.env.DEV`、本机地址和 `?playtest=agent` 同时满足时安装。生产构建通过静态
条件消除动态桥模块。每次运行创建临时 Chromium Context 和临时内存 Run，不读写正式
IndexedDB 或 Profile；试玩期间线上 Agent 请求关闭，游戏本地文案仍可用。

路线规划由游戏桥基于已发现可行走区域执行 BFS，不使用额外机器学习、动态规划或强化学习。
Pi Agent 只发出 `objective` 或 `frontier` 目标。一个批次最多 64 步；战斗、受伤、任务变化、出现
交互、楼层变化或阻塞会立即返回并重新规划。`objective` 尚无路径时桥内部寻找最近 frontier，
路径纠错不会进入维护模型。

桥的固定执行优先级为：关闭阻塞覆盖层、提交桥内答案、处理结算、执行必要交互、前往目标、
探索 frontier、等待游戏自身计时器。模型只在这些语义事件后重新决策，避免按格消耗 Token。
第八层由隐藏裁判确认五阶段 Boss 和七页 `MIGRATE`。

## 10. 隐藏裁判与脱敏

玩家投影不包含地图、管理员答案、完整快照、背包或身份。`query()` 不接收 SQL 参数；预选答案
只在游戏桥内部读取、写入真实编辑器并提交。`judge()` 的课程、Boss、升层和 MIGRATE 断言只由
Node 侧运行器用于最终结果，不作为动作提示，也不进入维护模型。

控制台写盘前移除 SQL 和凭据样式；截图前清空编辑器并隐藏管理员菜单、地图、答题复盘和终端。
步骤报告只保留动作类型、耗时、计数，以及限长的 `mission/prompt/banner/actions` 公开尾迹。
报告不保存 SQL、答案、完整地图、完整快照、背包、身份、prompt、completion 或 Key。

## 11. 本地数据

默认数据根为 Windows `%LOCALAPPDATA%\dungeon-maintainer`；非 Windows 环境回退到用户数据目录。

```text
dungeon-maintainer/
├─ tasks/<task-id>/
│  ├─ task.json
│  ├─ session.jsonl
│  ├─ events.ndjson
│  ├─ report.md
│  ├─ patch.diff
│  ├─ reverse.diff
│  ├─ checks/
│  ├─ play/
│  └─ dashboard/
└─ worktrees/<task-id>/
```

配置继续以 `MAINTAINER_*` 进程环境为唯一来源，尤其不会把 API Key 复制到该目录。任务目录是本地
可审计证据，不应提交到 SQL Dungeon 或本仓库。

## 12. 验收边界

新仓库的基础门禁为 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`。测试必须覆盖
严格工具字段、路径越权、符号链接、审批过期、Hash 冲突、HEAD 漂移、脏工作区、安全回滚、缓存、
上下文压缩、模型限额、Dashboard 并发、诊断结构、检查点前置和确定性 Runner。

浏览器变更还需在 SQL Dungeon 执行规则测试、Python 在线三角色测试、游戏测试、架构检查和生产
构建。真实八层试玩是端到端证据，不替代单元测试；模拟模型测试也不替代真实 Git 检查点。
