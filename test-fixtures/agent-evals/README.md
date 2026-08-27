# Agent Evals

`agent-evals` 保存真实项目级故障现场。`_bases/` 只保存一份可运行的正常共享基线，
每个案例目录只保存最小 Bug Patch、公开任务、固定复现动作和隐藏验收条件。共享基线位于
Dungeon Maintainer 自身的 Git 仓库中，不能直接把它当作工作仓库运行。

运行前必须通过维护器的 fixture materializer 复制共享基线、初始化独立 Git 仓库、提交固定
基线，再应用案例的 `source.patch`。这样 Agent 只看到本题故障 diff，不会把搭建测试桥所需的
公共代码误判为待修复内容，也不会携带外部 `.git`、Junction、依赖目录或开发者本机路径。

当前 1.0 只保留 7 个案例：`terminal-action-bug`、`accepted-query-without-progress`、
`final-stage-boss-stuck-at-one-hp`、`admin-floor-transition-deadlock`、
`transition-lost-after-reload`、`stale-query-plan-evidence` 和
`duplicate-final-victory-commit`。
`case.json` 只保存可公开给 Agent 的症状；`reproduction.json` 保存零模型动作；`expected.json`
保存隐藏输入与 before/after Oracle；`fixture.json` 绑定共享基线、Bug Patch 摘要和唯一脏路径。
物化器只接受当前 Fixture、基线和 Expected 数据格式，不迁移旧格式。
