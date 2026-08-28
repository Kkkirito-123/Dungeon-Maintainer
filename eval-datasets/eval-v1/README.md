# Eval Dataset v1

`eval-v1` 是维护器内置的冻结游戏故障数据集。`base/` 保存一份可运行的正常共享基线，
每个 `scenarios/<id>/` 目录只保存最小故障补丁、公开任务、固定复现动作和隐藏验收条件。

运行时由 Eval Workspace 复制共享基线、初始化独立 Git 仓库、提交固定基线，再应用 Scenario 的
`source.patch`。Agent 只看到当前故障 Diff，不会携带外部 `.git`、Junction、依赖目录或开发者
本机路径。

`dataset.json` 固定 Scenario 顺序；`case.json` 是公开任务；`reproduction.json` 是零模型动作；
`expected.json` 是隐藏输入和 before/after Oracle；`fixture.json` 绑定共享基线、补丁摘要和预期
脏路径。

生产代码和 CLI 统一使用 `scenarioId`。JSON 中的 `fixtureId` 是 v1 冻结格式的一部分，只读保留；
不要原地迁移或重写。需要更新游戏基线或数据格式时创建新的 Dataset 版本。
