/*
 * Agent 传输层的最小命令契约。
 *
 * 应用与 Shell 只依赖这个中立结构；具体由 Pi RPC 或测试适配器解释命令，领域层
 * 不需要导入任何 Pi 类型。命令经 Shell 进入 `AppController` 后，普通请求等待带相同
 * id 的 RPC response；`extension_ui_response` 则直接回复 Pi 正在等待的确认框。
 */
/**
 * Shell 可发送给 Agent 传输层的最小命令。
 *
 * @remarks `type` 决定 Pi RPC 操作；`id` 用于关联请求和响应，缺省时由传输层生成。
 * 接口有意保留扩展字段，以承载 Pi 已定义的 prompt、steer、abort 和状态查询参数，
 * 但不授予任意命令执行能力。
 */
export interface AgentRpcCommand extends Record<string, unknown> {
  /** Pi 已定义的操作名称，例如 prompt、steer、abort 或状态查询。 */
  type: string;
  /** 可选请求标识；缺省时由 `PiRpcProcess.send()` 生成。 */
  id?: string;
}
