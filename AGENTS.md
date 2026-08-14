# Dungeon Maintainer 仓库指南

本文件是本仓库的开发权威。默认使用中文沟通，源码和文档使用 UTF-8；标识符保持简短英文。

## 目标与边界

本仓库只实现一个轻量、受限、面向 SQL Dungeon 的本地代码维护 Agent：

```text
CLI -> Pi Runtime -> inspect / patch / check / play / finish
                         |                 |
                  safety + worktree   sql-dungeon adapter
```

- `src/runtime/` 只负责 Pi 模型循环、任务事实、用量和上下文压缩。
- `src/safety/` 是路径权限、符号链接、Hash、Git worktree、应用和回滚的唯一权威。
- `src/tools/` 只暴露五个固定工具，不得新增 Shell、任意命令或通用写文件能力。
- `src/adapters/sql-dungeon/` 是通用维护器与游戏桥、固定检查之间的唯一连接点。
- `tests/` 使用 Node 原生测试，安全规则优先使用真实临时 Git 仓库验证。

不要把 SQL Dungeon 的在线 Campfire、Scribe 或 Main Agent 迁入本仓库，也不要让本仓库成为
HTTP 服务。不要引入完整 `pi-coding-agent`、TUI、XState、PydanticAI、数据库或插件系统。

## 开发规则

- 修改前读取 Git 状态、拥有该行为的模块、对应测试和设计文档；保留无关用户工作。
- 用 Pi Core 的稳定公开接口承载模型循环，但权限判断不能只写在 prompt 中。
- 所有文件访问都必须经过项目相对路径规范化和真实路径边界检查。
- 模型不能提供 Shell 字符串、任意参数、JavaScript、选择器、SQL、删除或移动指令。
- 核心修改必须绑定任务、`baseHead` 和精确路径获得一次性批准；不得默许扩大范围。
- 所有写入先进入 detached worktree。显式 `apply` 前不得改变目标分支；冲突时必须拒绝。
- `.env`、凭据、法律文件、`.git`、生成目录、仓库外路径和二进制文件不得修改。
- API Key、prompt、completion、SQL、答案、地图、完整快照、背包和身份不得进入日志、截图或报告。
- 不自动提交、推送、创建 PR 或安装到目标仓库。

## 注释与命名

每个生产模块必须有中文文件头，说明职责、非职责、输入输出边界、安全约束和重要失败模式。
所有导出的类型、类和函数使用中文 JSDoc，说明参数、返回值、副作用、错误和权限要求。

详细注释优先放在以下非直观位置：Pi 与自有安全层边界、审批状态机、符号链接防逃逸、Git
检查点、`baseHash`、上下文压缩、BFS/frontier、隐藏裁判隔离、脱敏和缓存失效。不要逐行翻译
显而易见的赋值或分支。禁止使用含糊的 `Manager`、`Helper`、`Utils` 命名。

## 固定约束

- 依赖版本：`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 为 `0.84.1`，
  `playwright` 为 `1.62.1`。
- 单任务最多 20 个模型回合、40 次工具调用、64000 Token、3 个修改文件和 120 行补丁成本。
- `inspect` 每次最多 400 行或 48 KiB；`go` 每批最多 64 个真实移动步。
- 检查和试玩缓存绑定完整 worktree Hash，代码变化后必须失效。
- SQL Dungeon 项目文件 `.maintainer/project.json` 只能声明版本和适配器，不能声明命令或权限。

## 验证

从本仓库根目录运行：

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及浏览器适配时，还要在目标 SQL Dungeon 仓库验证其规则测试、Python 在线 Agent 测试、
游戏测试、架构检查和生产构建。只报告实际运行的结果；mock 不能替代真实 Git 或浏览器证据。
