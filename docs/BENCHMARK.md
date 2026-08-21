# Dungeon Maintainer Benchmark

这个基准回答三个问题：用户是否立刻收到反馈、专用游戏控制面能否自主闭环、真实 Pi
会话是否在缓存和 token 预算内完成修复。报告只包含数值和布尔结果，不包含提示正文、
模型回复、源码、SQL、地图、存档或密钥。

## 运行层级

### 1. Shell 确定性基准（默认，零模型 token）

```powershell
pnpm benchmark
```

它启动真实 HTTP/SSE Shell，但用受控 Pi 事件替代网络模型，检查：

- 提交后 250 ms 内出现本地“消息已收到”反馈；
- thinking 正文不进入聊天或 SSE；
- `stopReason=length` 且无正文时显示明确错误；
- 只有 `agent_settled` 才解锁下一条输入；
- 本轮与会话的 input/cache/output/context 字段映射正确。

### 2. 真实游戏桥基准（零模型 token）

```powershell
pnpm benchmark -- --repo "C:\path\to\select-from-dungeon"
```

它启动真实 Vite 和无界面 Chromium。控制器只使用 `look/go/use/input_sql/query`，不知道地图坐标或
隐藏答案；当前终端打开后，可以读取玩家已经看见的题面、schema、textarea SQL、查询状态、
结果与计划。场景从一层真实导航到首个终端，确认这些字段完整可见且协议不包含答案、完整地图、
存档或 judge 字段，然后只提交一次当前空输入并要求得到玩家可见拒绝，不重复探测。
随后通过受控 `input_sql` 写入一条非答案查询，再用 `query` 走真实执行链并确认规则拒绝；SQL
正文不进入报告，并在同一进程内刷新后重放该输入与提交动作。

场景还从初始状态建立一个短语义窗口，执行 `checkpoint -> reload -> replay`，验证刷新后仍能重放
同一玩家动作。零模型脚本不会使用已移除的管理员答案自动填充，也不会假装能求解 SQL；真实 Agent
的“一条消息完成复现、定位、修改、刷新重放和验证”由下面的真实 Pi 任务报告单独判定。

### 3. 真实 Pi 任务报告

结束一个全新的维护任务后，把任务目录传给分析器：

```powershell
pnpm benchmark -- `
  --repo "C:\path\to\select-from-dungeon" `
  --task-dir "$env:LOCALAPPDATA\dungeon-maintainer\tasks\<task-id>" `
  --out ".\benchmark-results\<task-id>.json"
```

真实任务门槛：

| 指标 | 门槛 |
|---|---:|
| thinking-only `length` 轮次 | 0 |
| 有可见正文的终结轮次 | ≥ 95% |
| Prompt cache 命中率 | ≥ 80% |
| 每个自然语言问题的新输入 | ≤ 8,000 token |
| 每个自然语言问题的输出 | ≤ 6,000 token |
| 每个自然语言问题的工具调用 | ≤ 16 |
| 同参数连续工具调用 | ≤ 2 |
| 自动续跑创建 / 准入 | ≤ 4 / ≤ 4 |
| 过期 continuation | 0 |
| 终态后模型回合 / 工具调用 / token | 0 / 0 / 0 |
| 重复 finish / 语义重复结果 | 0 / 0 |
| 到 proposed 前 inspect 次数 | ≤ 10 |
| 诊断耗时 | ≤ 300,000 ms |
| 单次最大 prompt | ≤ context window 的 75% |
| 额外自然语言追问 | 0 |
| 修复方案确认 | ≤ 1 次 |
| 检查失败 / 刷新回放失败 | 0 / 0 |

对于产生代码修改的任务，`autonomous_closure_recorded` 还要求：保存复现、至少一个检查通过、
至少一次右侧刷新回放通过，并由 Agent 写下最终结论。分析器只看结构化元数据，不读取或输出
对话和工具正文。

## 内置 fixture

仓库已经把可复现的最小样本放在 `test-fixtures/`，布局与 Sigma 的测试目录类似：

```text
test-fixtures/
├─ agent-evals/       # 可物化的仓库基线 + source.patch
└─ smoke-tasks/       # 已脱敏的 task/events/Pi JSONL 回归样本
```

`agent-evals/terminal-action-bug/` 使用 `repository/` 保存固定 HEAD 基线，使用
`source.patch` 保存脏来源树的增量，并在 `fixture.json` 中记录 `baseCommit`、基线文件数、
脏路径和补丁 SHA-256。这样既能复现外部 benchmark-fixtures 的 Git 语义，也不会把个人绝对路径、
`.git` 目录或外部 `node_modules` Junction 带进仓库。需要物化时由 fixture materializer 创建
新的临时目标目录并应用补丁，例如：

```ts
import { materializeAgentEvalFixture } from "./src/benchmark/agent-eval-fixture.js";

await materializeAgentEvalFixture({
  id: "terminal-action-bug",
  destination: "C:/temp/dungeon-terminal-action-bug",
});
```

物化目录必须不存在；函数会重新建立固定 Git 基线并核对预期 dirty paths，失败时清理本次创建的
目标。`smoke-tasks/stale-follow-up-after-result/` 不启动模型或游戏，专门回归“终态后旧续跑”、
重复 `finish(proposed)`、终态后的工具调用和 token 浪费。

真实任务报告还会输出自动续跑创建/准入/过期丢弃、终态后模型回合/工具调用/token、重复完成提交、
语义重复结果、到方案前 inspect 次数和诊断耗时。这些指标直接对应任务编排、证据去重和诊断效率，
不需要把提示词或工具正文写进报告。

## 推荐固定用例

每次比较模型、提示词或上下文策略时都从干净任务运行以下三项，不能复用旧 Pi session：

1. `当前在哪一层，状态是什么？`：应直接使用回合前实时投影，零游戏工具、零源码工具。
2. `为什么没有传送到第二层，定位并修复。`：应自主复现、定位、修改、刷新、回放、检查并给结论。
3. 一个固定的一行 TypeScript 类型错误：应先用 `check` 取证，只改相关文件并让同一检查通过。

报告用于版本间对比；确定性场景必须全部通过，真实模型场景同时比较成功率、P50/P95 时延与
token。建议每个真实用例至少运行 5 次，最终采用成功率 ≥ 80% 且没有越权写入作为升级门槛。
