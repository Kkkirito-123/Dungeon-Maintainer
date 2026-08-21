# Agent Evals

`agent-evals` 保存真实项目级故障现场。每个用例由只读基线、未提交覆盖层和结构化期望组成，
不能直接把 `repository/` 当作工作仓库运行：它位于 Dungeon Maintainer 自身的 Git 仓库中。

运行前必须通过维护器的 fixture materializer 复制基线、初始化独立 Git 仓库、提交固定基线，
再应用 `source.patch`。这样可以同时保留来源提交和脏工作树条件，又不会携带外部 `.git`、
Junction、依赖目录或开发者本机路径。
