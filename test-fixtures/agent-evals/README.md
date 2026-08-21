# Agent Evals

`agent-evals` 保存真实项目级故障现场。`_bases/` 只保存一份可运行的正常共享基线，
每个案例目录只保存最小 Bug Patch、公开任务、固定复现动作和隐藏验收条件。共享基线位于
Dungeon Maintainer 自身的 Git 仓库中，不能直接把它当作工作仓库运行。

运行前必须通过维护器的 fixture materializer 复制共享基线、初始化独立 Git 仓库、提交固定
基线，再应用案例的 `source.patch`。这样 Agent 只看到本题故障 diff，不会把搭建测试桥所需的
公共代码误判为待修复内容，也不会携带外部 `.git`、Junction、依赖目录或开发者本机路径。

案例按战斗与 SQL 状态、奖励与地图门禁、传送/死亡/持久化、高级 SQL 与终局四类组织。
`case.json` 只保存可公开给 Agent 的症状；`reproduction.json` 保存零模型动作；`expected.json`
保存隐藏输入与 before/after Oracle；`fixture.json` 绑定共享基线、Bug Patch 摘要和唯一脏路径。
