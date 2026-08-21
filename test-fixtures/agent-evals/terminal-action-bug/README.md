# terminal-action-bug

## 目的

这个用例冻结了 SQL Dungeon 中“玩家可见 `terminal` 动作存在，但执行后返回
`action-not-available`”的真实维修现场，用于比较 Coding Agent 的复现、源码定位、
一次性方案审批、最小修改和刷新重放能力。

## 组成

- `repository/`：来源提交 `3c311443b96243080c2668ed359f1a2a23a09a14` 的完整 tracked 快照。
- `source.patch`：来源工作树中 14 个未提交修改，物化后必须保持为 dirty 状态。
- `fixture.json`：物化所需的版本、Hash 和精确 dirty 路径。
- `expected.json`：Harness 可读取的低敏验收事实；不应注入模型上下文。

## 边界

导入时已排除指向原仓库的 `.git` 文件和外部 `game/node_modules` Junction。原始许可证、
署名、第三方素材说明和英文文档均完整保留。不得把本 README 或 `expected.json` 复制到
物化后的仓库根目录，避免向被测 Agent 泄露故障答案。
