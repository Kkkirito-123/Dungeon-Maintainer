# Dungeon Maintainer V1 设计

## 1. 设计目标

Dungeon Maintainer V1 把通用 Coding Agent 缩减为 SQL Dungeon 专用维护循环。模型负责理解问题、
选择工具和总结证据；确定性代码负责所有可产生副作用或泄露风险的行为。

```text
用户问题
  -> CLI / TaskStore
  -> Pi Agent
      -> inspect：有限代码证据
      -> patch：隔离 worktree 精确替换
      -> check：固定质量门禁
      -> play：确定性真实浏览器试玩
      -> finish：证据核验与补丁封装
  -> 用户 approve / apply
  -> 目标工作区
```

V1 不追求通用仓库支持、自主 Shell、自动发布、多 Agent 编排、长期记忆或 Web 控制面。适配器只
支持带有严格 `.maintainer/project.json` 标识的 SQL Dungeon 仓库。

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

Runtime 固定每个模型回合只能调用一个工具，并只注册 `inspect/patch/check/play/finish`。恢复核心
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

### play

一次调用完成一个楼层或全部八层。维护模型不控制逐步动作；确定性 Runner 写报告后只返回压缩
总结和产物路径。单层失败不阻止后续楼层。

### finish

只接受 `diagnosed/needs_approval/ready/blocked`。`ready` 必须至少声明一个检查 ID，且该检查在
当前完整 worktree Hash 下确实通过；模型不能凭文字伪造门禁。成功后生成中文报告、正向补丁和
反向补丁，但不应用到目标仓库。

## 7. 检查与试玩缓存

缓存键不是时间或文件名，而是当前 Git HEAD、已跟踪 Diff 和未跟踪文件内容共同计算的 SHA-256。

- `check` 使用 `checkId + worktreeHash`；
- `play` 使用 `scope/floor + worktreeHash`；
- 成功、失败和阻断均可复用，避免在相同代码上重复消耗时间；
- 任意代码字节变化会得到新 Hash，旧结果自动失效；
- 缓存只保存任务记录和产物索引，不进入模型长期记忆。

## 8. 上下文与资源控制

单任务硬限制为 20 个模型回合、40 次工具调用和 64000 个累计 Token。Pi transcript 只存在当前
进程；`session.jsonl` 记录事件类型、工具名、状态和 usage，不保存消息正文。

当估算上下文达到模型窗口约 75% 时，发送给模型的视图被替换为“确定性事实摘要 + 最近完整工具
调用链”。摘要只保留：

- 原始任务目标、模式和 Git 基线；
- 当前状态与精确批准路径；
- 已修改文件；
- 已通过检查；
- 失败或阻断检查。

它不保留进度日志、API Key、SQL、地图、浏览器快照或补丁正文。若无法找到不拆断 tool call 与
tool result 的安全切点，则不压缩，避免制造无效上下文。

## 9. 确定性试玩与 BFS

SQL Dungeon 开发态桥协议为 v2：

```ts
interface DungeonPlaytestBridge {
  version: 2;
  look(): PlaytestView;
  go(target: "objective" | "frontier", maxSteps: number): Promise<PlaytestResult>;
  use(actionId: string): Promise<PlaytestResult>;
  query(): Promise<PlaytestResult>;
  judge(floor: number): PlaytestJudge;
}
```

桥只在 `import.meta.env.DEV`、本机地址和 `?playtest=agent` 同时满足时安装。生产构建通过静态
条件消除动态桥模块。每次运行创建临时 Chromium Context 和临时内存 Run，不读写正式
IndexedDB 或 Profile；试玩期间线上 Agent 请求关闭，本地确定性文案仍可用。

路线规划由游戏桥基于已发现可行走区域执行 BFS，不使用 LLM、机器学习、动态规划或强化学习。
Runner 只发出 `objective` 或 `frontier` 目标。一个批次最多 64 步；战斗、受伤、任务变化、出现
交互、楼层变化或阻塞会立即返回并重新规划。`objective` 尚无路径时桥内部寻找最近 frontier，
路径纠错不会进入维护模型。

Runner 的固定动作优先级为：关闭阻塞覆盖层、提交桥内答案、处理结算、执行必要交互、前往目标、
探索 frontier、等待游戏自身计时器。连续五次公开状态签名不变或三次相同错误后停止并分类，避免
死循环。第八层由隐藏裁判确认五阶段 Boss 和七页 `MIGRATE`。

## 10. 隐藏裁判与脱敏

玩家投影不包含地图、管理员答案、完整快照、背包或身份。`query()` 不接收 SQL 参数；预选答案
只在游戏桥内部读取、写入真实编辑器并提交。`judge()` 的课程、Boss、升层和 MIGRATE 断言只由
确定性 Runner 用于最终结果，不作为动作提示，也不进入维护模型。

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
│  └─ play/
└─ worktrees/<task-id>/
```

配置继续以 `MAINTAINER_*` 进程环境为唯一来源，尤其不会把 API Key 复制到该目录。任务目录是本地
可审计证据，不应提交到 SQL Dungeon 或本仓库。

## 12. 验收边界

新仓库的基础门禁为 `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build`。测试必须覆盖
严格工具字段、路径越权、符号链接、审批过期、Hash 冲突、HEAD 漂移、脏工作区、安全回滚、缓存、
上下文压缩、模型限额和确定性 Runner。

浏览器变更还需在 SQL Dungeon 执行规则测试、Python 在线三角色测试、游戏测试、架构检查和生产
构建。真实八层试玩是端到端证据，不替代单元测试；模拟模型测试也不替代真实 Git 检查点。
