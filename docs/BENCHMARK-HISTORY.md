# Benchmark 历史记录

本页只保存可公开、可比较的汇总事实。原始运行归档继续放在被 Git 忽略的
`benchmark-results/` 或独立本地备份中，避免提交模型正文、SQL、临时源码和运行时数据。
单次真实模型结果只作为方向性工程证据，不代表统计显著性。

## 2026-08-25 · 路由 V2 · Flash 单案例

- 案例：`final-stage-boss-stuck-at-one-hp`
- Profile：`maintainer-current`
- 模型：`deepseek-v4-flash`
- Maintainer commit：`b878eebd63e92bafbb6521230213b595ee057fe1`
- Fixture Hash：`938b565a59c0ed5e1e8ebf27db467c626529624731c128342d57414ad770a183`
- 预检：通过，33,676 ms，浏览器错误 0
- 真实运行：通过；before/after Oracle、禁止路径、Git HEAD、固定验证和
  `ready_to_apply` 全部通过

| 指标 | V2 | 同案例既有 Maintainer 基线 | 变化 |
|---|---:|---:|---:|
| 总处理 Token | 305,675 | 461,884 | -33.8% |
| 总用时 | 199,303 ms | 207,327 ms | -3.9% |
| Inspect 外部调用 | 16 | 28 | -42.9% |
| Agent 用时 | 175,356 ms | — | — |
| 首次真实 mutation | 59,685 ms | — | — |

遥测闭合：

```text
inspectCalls 16 = inspectExecutions 15 + inspectReceiptHits 0 + inspectFailures 1
writeAttempts 5 = writeRejected 0 + writeFailures 4 + writeNoops 0 + writeMutations 1
routedSearchExpansions = 0
telemetryParseErrors = 0
browserErrorCount = 0
```

该轮模型没有选择新 `bundle` 动作，`inspectBundles=0`。随后提交 `cc536ff` 将 bundle
优先级和适用条件写入工具 JSON Schema；遵守“只运行一次 Flash”的约束，没有追加付费复测。
因此这轮可以证明总体 Token、时间和 Inspect 调用下降，但不能作为 bundle 收益证据。

原始归档完整性：

- 正式结果 SHA-256：`dbb6c2b23c77838d82d71cda0d0cea08af7e1a0ba6e6b473110c29d92f41c498`
- 预检结果 SHA-256：`18c25e3152233c44327e66719e9efae3e832d91e50d70fc85672f3f0b50b9400`

## 2026-08-25 · 旧双工作流 · Pro 矩阵残缺运行

这轮用于定位旧 Queue/Evidence 双工作流的等待与闭环问题，不用于比较 Flash V2：

- 12/12 零 Token 预检通过，正式运行只归档 9/12，未生成最终 summary；
- 9 例严格通过 3 例，只看外部功能 Oracle 通过 4 例；
- 合计约 3,486 秒、3,566,738 Token、273 次工具调用、157 次 Inspect；
- 浏览器错误总数为 0；
- 实际模型是 `deepseek-v4-pro`，不符合后续 Flash-only 约束；
- 未完成案例：`transaction-sandbox-state-leak`、`stale-query-plan-evidence`、
  `duplicate-final-victory-commit`。

| 案例 | 严格结果 | 总用时 | Token | 写入 |
|---|---|---:|---:|---:|
| `terminal-action-bug` | 通过 | 239.3 s | 199,678 | 1 |
| `admin-answer-hint-rejected` | 失败 | 470.2 s | 863,375 | 0 |
| `accepted-query-without-progress` | 通过 | 228.6 s | 184,634 | 1 |
| `final-stage-boss-stuck-at-one-hp` | 失败；外部 Oracle 通过 | 1,835.0 s | 713,228 | 1 |
| `boss-hp-reset-after-death` | 失败 | 106.2 s | 247,836 | 0 |
| `lesson-complete-reward-missing` | 失败 | 109.7 s | 288,841 | 0 |
| `dead-area-boss-still-blocks-portal` | 失败 | 162.6 s | 644,012 | 0 |
| `admin-floor-transition-deadlock` | 通过 | 279.4 s | 386,336 | 1 |
| `transition-lost-after-reload` | 基础设施失败 | 55.2 s | 38,798 | 0 |

旧结果揭示的是外部功能结果与内部 Queue/Evidence 状态机分裂：多个案例未写入即暂停，另有案例
功能已经修好却因内部 verifying 状态持续等待。当前单 Pi Loop 已移除隐藏阶段续跑；Evidence
只作为上下文与证据资料，有限 LoopGuard 只保护 Inspect、写入、检查和结束动作。
