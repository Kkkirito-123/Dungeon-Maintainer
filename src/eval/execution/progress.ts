/**
 * Eval 进度事件契约。
 *
 * 执行层只发布低敏状态；UI 可以订阅，但执行层不依赖任何 HTTP 或页面实现。
 */

/** 单个 Suite 的低敏实时进度。 */
export interface EvalProgressEvent {
  readonly phase: "starting" | "preflight" | "run" | "complete";
  readonly scenarioId: string | null;
  readonly profile: string | null;
  readonly repetition: number | null;
  readonly completed: number;
  readonly total: number;
  readonly status: "running" | "passed" | "failed";
  readonly cumulativeTokens: number;
  readonly cumulativeToolCalls: number;
  readonly startedAt: string;
  /** 正式运行使用 1..workerCount；预检和总状态为 null。 */
  readonly workerId: number | null;
  readonly workerCount: number;
  readonly liveKind?: "start" | "tool" | "assistant" | "finish";
  readonly toolName?: string | null;
  readonly assistantText?: string;
}
