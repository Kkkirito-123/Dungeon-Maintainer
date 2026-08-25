# 深度定制的单 Agent Loop

Dungeon Maintainer 不复刻传统 Pi 的通用工具面，而是在 Pi 原生 Agent Loop 外增加 SQL
Dungeon 专用能力。定制发生在观察、工具和安全边界，不再增加第二套模型规划器。

```text
用户 / Chromium Shell
        │ 一条自然语言请求
        ▼
Pi RPC + Pi Agent Loop（唯一模型循环）
        │
        ▼
Dungeon Extension
├─ 观察面：实时玩家投影、游戏区域路由、当前增量文件、上下文总预算
├─ 能力面：inspect / patch / check / finish
│          look / go / use / input_sql / query / tree
├─ 安全面：detached worktree、realpath、方案审批、write scope
└─ 交付面：合批刷新、聚焦验证、隐藏断言、ready_to_apply、/apply 完整质量门
        │
        ▼
Task / Workspace / Repair / Game / Logging
```

## 核心不变量

- Pi 自主选择调查顺序，并在同一个 Agent turn 内完成复现、诊断、获批写入和验证。
- Extension 不在 `agent_settled` 后发送 `triggerTurn: true`，不创建
  reproduce/diagnose/propose/execute/verify/recover 队列，也不自动进入 paused。
- `finish(reproduced)` 和获批的 `finish(proposed)` 返回当前 Agent 继续执行；
  拒绝、diagnosed、blocked 和最终 result 才结束请求。
- 证据记录只能服务任务内 Hash 缓存、复现、检查和审计，不能规定模型必须读取哪些文件，
  也不能因为遥测或索引写入失败推翻已经通过的验证。
- 游戏通过 `.maintainer/architecture-map.json` 提供稳定 area 与选定 partition 职责；schema v1
  规范化为无 partition 的兼容形态。显式路径/partition 固定范围，自动路由依次尝试主 partition、
  partition 邻居、所属 area、area 邻居和仓库。地图不登记文件，partition 内部修改不产生维护成本。
- 源码定位默认使用一次 `inspect bundle`：在路由范围搜索并返回最多四个互不重叠的 48 行窗口，
  总计不超过 192 行和 4 KiB；窗口直接登记读取覆盖及 baseHash。同一有效版本的语义重复只返回
  短回执，部分重叠读取只返回未覆盖行。
- LoopGuard 只保护 `inspect/patch/write/check/finish`；同一无进展动作可执行两次，第三次执行前
  阻止。`go/use/input_sql/query` 不参与门禁，合法的重复游戏动作不会被冻结。
- 安全边界仍是确定性代码：审批前禁写、allowedPaths、realpath、写前检查点、写后刷新重放、
  固定验证和显式 `/apply` 都不能由 Prompt 或 Benchmark 放宽。
- 过长 tool result 使用内容确定的首尾截断，旧结果再按 16 KiB 总预算替换为稳定 Hash 回执；
  最新游戏和源码证据优先保留。
- `finish(result)` 只运行相关测试和必要重放；完整游戏测试、架构检查和构建在显式 `/apply`
  写回前按最终 worktree Hash 运行一次。

## Benchmark 边界

```text
Fixture + 公开 Prompt
        │
        ▼
单次 Pi Agent Loop ── agent_settled ──┐
                                       ▼
                              外部 Oracle + Git 安全检查
                                       │
                                       ▼
                             结果、耗时、Token、工具遥测
```

Benchmark 只观察和判卷：第一个真实 `agent_settled` 立即停止模型计时，随后由外部 Oracle
判断功能正确性。TaskState、Evidence 完整度和工具次数只作诊断，不能反馈控制 Agent。
自动矩阵默认使用 headless Chromium，因此不会为每个案例反复弹出和关闭可见窗口；生产任务
仍保持一个 headed Shell。

## 低敏遥测

一次外部 Inspect 调用只写一条 `tool.inspect` 事件；bundle 内部窗口不伪装成额外工具执行。
写入按 `rejected / failed / noop / mutated / mutated_replay_failed` 分类，事件只含工具名、分类、
计数、工作树 Hash 摘要和稳定原因码。`mutated_replay_failed` 同时计入真实 mutation 与 replay
failure；参数、补丁、源码、SQL 和模型正文不进入事件日志。Benchmark 必须满足 Inspect 与写入
两条分类等式，诊断耗时截止第一次真实 mutation。

`tests/architecture.test.ts` 固定检查单循环边界和中立层依赖方向。
