# 内置测试夹具

本目录只保存维护器自身的轻量测试夹具：

```text
test-fixtures/
└─ smoke-tasks/   不调用模型的任务会话与分析器回归用例
```

真实 Eval 场景由当前游戏仓库的 `benchmark/agent-evals/` 和
`scripts/benchmark-adapter.mjs` 持有；维护器不再保存游戏快照。Adapter 每次从当前工作树
生成独立临时测试仓库，隐藏复现和 Oracle 不会复制进去。

所有会话夹具必须经过重新合成或脱敏，不得提交用户原始消息、模型正文、源码工具输出、
SQL、游戏隐藏状态、凭据或本机绝对路径。
