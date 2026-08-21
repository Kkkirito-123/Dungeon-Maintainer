# 内置测试夹具

本目录保存 Dungeon Maintainer 的冻结评测输入，使 Benchmark 不再依赖开发者桌面上的
外部 `benchmark-fixtures` 目录。目录结构参考通用 Coding Agent 项目的做法，将可运行的
真实仓库用例与轻量生命周期记录分开管理：

```text
test-fixtures/
├─ agent-evals/   需要物化为独立 Git 仓库的真实 Coding Agent 用例
└─ smoke-tasks/   不调用模型的任务会话与分析器回归用例
```

夹具属于测试输入，不属于维护器生产源码。导入的仓库快照保持原始内容、许可证和注释，
不得为了格式统一而重写，否则会改变 Agent 的搜索空间、文件 Hash 和 Benchmark 基线。

所有真实会话夹具必须经过重新合成或脱敏，不得提交用户原始消息、模型正文、源码工具输出、
SQL、游戏隐藏状态、凭据或本机绝对路径。
