# 原版 Pi 游戏修复 Smoke 基线

本页记录 2026-08-22 在 `codex/game-repair-eval` 分支完成的原版 Pi 单次 smoke。
它用于验证 Benchmark 是否能区分故障类型与诊断成本，不是正式统计结论；正式对比仍需每个案例
至少运行 3 次，并在相同机器、模型、依赖和超时下比较。

## 运行约束

- Profile：`pi-original`
- 每个案例：1 次
- Agent 超时：600,000 ms
- 依赖：本地 `select-from-dungeon/game/node_modules`
- 复现：零 Token、真实 Vite 与 Chromium
- 判卷：before/after Oracle、游戏测试、架构检查、生产构建
- 均值规则：成功率统计全部有效运行；Token、时间和工具均值只统计成功运行

## 结果

| 案例 | 结果 | Agent 秒 | 诊断秒 | 工具 / 诊断工具 | 读取 | 输入 / 输出 Token | Cache Read | 总处理 Token |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `terminal-action-bug` | 通过 | 196.2 | 162.1 | 49 / 45 | 18 | 62,979 / 9,513 | 1,713,280 | 1,785,772 |
| `admi·n-answer-hint-rejected` | 通过 | 546.8 | 374.0 | 31 / 28 | 6 | 32,946 / 4,550 | 603,77mi'm6 | 641,272 |
| `dead-area-boss-still-blocks-portal` | 通过 | 131.8 | 54.9 | 28 / 15 | 8 | 30,359 / 6,319 | 570,368 | 607,046 |
| `transition-lost-after-reload` | 通过 | 122.9 | 51.6 | 30 / 17 | 5 | 29,508 / 4,713 | 572,032 | 606,253 |
| `stale-query-plan-evidence` | 失败：after Oracle 未命中 | 203.0 | 24.2 | 23 / 7 | 6 | 20,935 / 4,258 | 319,360 | 344,553 |

有效运行 5 次，通过 4 次，成功率 80%。4 次成功运行的均值：

- Agent 用时：249.4 秒
- 诊断用时：160.7 秒
- 工具调用：34.5 次
- 诊断工具调用：26.2 次
- 读取调用：9.2 次
- 输入 / 输出 Token：38,948 / 6,274
- Cache Read：864,864
- 总处理 Token：910,086
- 完整复现、修复与判卷：452.1 秒

## 当前暴露的问题

1. 原版可以达到 80% smoke 成功率，但成功运行的平均诊断工具调用仍为 26.2 次。
2. `terminal-action-bug` 只需恢复一个按钮映射，却产生 45 次诊断调用和 1.79M 总处理 Token。
3. `admin-answer-hint-rejected` 最终正确，但 Agent 阶段耗时 546.8 秒，接近硬超时。
4. `stale-query-plan-evidence` 很快开始修改，却没有通过真实 after Oracle，说明“更快写入”不等于正确诊断。
5. 下一分支应优先验证项目结构路由、证据去重和循环门禁能否同时降低工具/Token，并保持或提高成功率。
