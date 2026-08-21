# result 后旧 follow-up 回归

该场景重现以下生命周期错误：任务已经通过 `finish(result)` 进入 `ready_to_apply`，随后旧的
`dungeon-repair-follow-up` 仍启动新模型回合，并再次提交 `finish(proposed)`。

场景预期被 Benchmark 判为失败，用于证明分析器能够识别终态后的模型、工具和 Token 消耗；
Extension 的对应集成测试负责证明修复后的 Controller 不再产生这条旧 continuation。
