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
- 游戏通过 `.maintainer/architecture-map.json` 提供稳定区域职责；维护器先搜主区域，零命中
  才扩展相邻区域。地图不登记文件，区域内部修改不产生维护成本。
- 相同有效版本的重复搜索和读取只返回短回执；部分重叠读取只返回未覆盖行，搜索命中后可用
  一次 `read_many` 读取最多四段源码。
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

## 兼容清理

当前分支的 `src/task-queue/`、LoopGuard 和 schema v4 `paused` 字段暂时保留为历史数据/
纯模块测试兼容，但 Extension 已不再引用或写入它们。后续 schema 迁移应单独完成，避免在本次
运行时修复中同时破坏已有任务数据。

`tests/architecture.test.ts` 固定检查单循环边界和中立层依赖方向。
