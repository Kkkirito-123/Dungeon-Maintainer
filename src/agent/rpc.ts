/**
 * Agent 传输层的最小命令契约。
 *
 * 应用与 Shell 只依赖这个中立结构；具体由 Pi RPC、进程内 Agent Core 或测试适配器
 * 解释命令。领域层不需要导入任何 Pi 类型。
 */
export interface AgentRpcCommand extends Record<string, unknown> {
  type: string;
  id?: string;
}
