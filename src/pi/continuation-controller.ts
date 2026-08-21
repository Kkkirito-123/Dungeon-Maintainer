/**
 * Pi 自动续跑的任务级准入控制器。
 *
 * 本模块只管理 Extension 自己创建的 repair、budget 和异常刷新 continuation，避免把
 * Pi 的普通消息队列误当成具有任务语义的调度器。它不发送消息、不读取 TaskStore、
 * 不判断游戏证据是否充分，也不持久化模型正文；调用方必须在 `agent_end` 中重新读取
 * 权威任务状态后才可调用 `reserve`，并把返回的有限 revision 元数据写入低敏事件。
 *
 * 控制器以 taskId、用户请求 revision 和客观进展 revision 约束每条自动消息。同一进展
 * 版本只允许投递一次相同动作；新用户输入、终态或取消会让旧 Ticket 失效。进程重启后
 * 不恢复内存 Ticket，因此不会在没有用户新授权的情况下自动重放旧业务消息。
 */

/** Extension 内部允许创建的自动续跑类型。 */
export type ContinuationKind = "repair" | "budget" | "refresh-recovery";

/** 修复流程中用于判定旧指令是否仍适用的有限阶段。 */
export type ContinuationPhase =
  | "reproduce"
  | "diagnose"
  | "propose"
  | "execute"
  | "verify";

/** 一条自动续跑在当前进程内的生命周期状态。 */
export type ContinuationStatus =
  | "queued"
  | "admitted"
  | "completed"
  | "stale"
  | "cancelled";

/**
 * 一条已经由控制器分配身份的自动续跑。
 *
 * Ticket 只含 ID、revision、阶段和有限动作名，不能保存 Prompt、源码、SQL、工具正文
 * 或玩家状态。调用方发送 custom message 时必须原样携带这些字段，便于审计和 Benchmark。
 */
export interface ContinuationTicket {
  id: string;
  taskId: string;
  kind: ContinuationKind;
  requestRevision: number;
  progressRevision: number;
  phase: ContinuationPhase;
  nextAction: string;
  attempt: number;
  status: ContinuationStatus;
  reason: string | null;
}

/** 申请一次自动续跑所需的业务判定结果。 */
export interface ContinuationRequest {
  kind: ContinuationKind;
  phase: ContinuationPhase;
  nextAction: string;
}

/** `reserve` 没有生成 Ticket 时的确定性原因。 */
export type ContinuationSuppressionReason =
  | "outstanding"
  | "duplicate"
  | "attempt-limit";

/** 自动续跑申请的结果。 */
export interface ContinuationReservation {
  ticket: ContinuationTicket | null;
  suppressed: ContinuationSuppressionReason | null;
}

/** 控制器当前不含正文的只读快照。 */
export interface ContinuationControllerSnapshot {
  taskId: string;
  requestRevision: number;
  progressRevision: number;
  attempts: number;
  queuedId: string | null;
  activeId: string | null;
}

function ticketKey(
  requestRevision: number,
  progressRevision: number,
  request: ContinuationRequest,
): string {
  return [
    requestRevision,
    progressRevision,
    request.kind,
    request.phase,
    request.nextAction,
  ].join("\0");
}

function transitionTicket(
  ticket: ContinuationTicket,
  status: ContinuationStatus,
  reason: string | null = null,
): ContinuationTicket {
  ticket.status = status;
  ticket.reason = reason;
  return { ...ticket };
}

/**
 * 管理一个固定 taskId 的进程内自动续跑身份与准入状态。
 *
 * @remarks 调用方必须保证一个 Extension 实例只绑定一个任务；本类不支持切换 taskId。
 * @throws 构造参数非法时立即抛错，不产生文件、消息或网络副作用。
 */
export class ContinuationController {
  private requestRevision = 0;
  private progressRevision = 0;
  private attempts = 0;
  private sequence = 0;
  private queued: ContinuationTicket | null = null;
  private active: ContinuationTicket | null = null;
  private runningRequestRevision: number | null = null;
  private readonly issuedKeys = new Set<string>();

  /**
   * @param taskId 当前 Extension 固定绑定的安全任务 ID。
   * @param maximumAttempts 每个自然语言请求最多允许的自动续跑次数。
   */
  constructor(
    private readonly taskId: string,
    private readonly maximumAttempts = 4,
  ) {
    if (!taskId || !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
      throw new Error("ContinuationController 参数非法");
    }
  }

  /**
   * 开始一条新的自然语言用户请求，并使此前尚未完成的自动消息失效。
   *
   * @param preserveProgress 是否属于同一任务的“继续”请求；为 false 时清空进展版本。
   * @returns 被标记为 stale 的旧 Ticket，供调用方记录低敏事件。
   */
  beginRequest(preserveProgress: boolean): ContinuationTicket[] {
    const stale = this.invalidate("stale", "new-user-request");
    this.requestRevision += 1;
    this.attempts = 0;
    this.issuedKeys.clear();
    if (!preserveProgress) this.progressRevision = 0;
    return stale;
  }

  /**
   * 记录一次客观进展，使旧的未投递 Ticket 不能在新证据基础上继续执行旧指令。
   *
   * @param reason 不含正文的稳定原因码。
   * @returns 因进展而变 stale 的排队 Ticket；正在执行的 Ticket 可完成当前回合。
   */
  advanceProgress(reason: string): ContinuationTicket[] {
    this.progressRevision += 1;
    if (!this.queued) return [];
    const stale = transitionTicket(this.queued, "stale", reason);
    this.queued = null;
    return [stale];
  }

  /**
   * 为当前 revision 预留一条自动续跑。
   *
   * @param request 已由 Extension 根据权威 TaskStore 和证据状态生成的有限动作。
   * @returns 新 Ticket，或 outstanding、duplicate、attempt-limit 之一；不发送 Pi 消息。
   */
  reserve(request: ContinuationRequest): ContinuationReservation {
    if (this.queued || this.active) {
      return { ticket: null, suppressed: "outstanding" };
    }
    if (this.attempts >= this.maximumAttempts) {
      return { ticket: null, suppressed: "attempt-limit" };
    }
    const key = ticketKey(this.requestRevision, this.progressRevision, request);
    if (this.issuedKeys.has(key)) {
      return { ticket: null, suppressed: "duplicate" };
    }
    this.sequence += 1;
    this.attempts += 1;
    this.issuedKeys.add(key);
    this.queued = {
      id: this.taskId + "-continuation-" + String(this.sequence),
      taskId: this.taskId,
      kind: request.kind,
      requestRevision: this.requestRevision,
      progressRevision: this.progressRevision,
      phase: request.phase,
      nextAction: request.nextAction,
      attempt: this.attempts,
      status: "queued",
      reason: null,
    };
    return { ticket: { ...this.queued }, suppressed: null };
  }

  /**
   * 绑定即将开始的 Pi 回合，并在存在排队消息时标记其已经被消费。
   *
   * @returns admitted Ticket；没有本控制器排队消息时返回 null，表示普通用户回合。
   * @remarks 即使是普通用户回合也会记录当前 requestRevision，使流式期间到达的新输入能
   * 让旧回合失效；本方法不发送消息、不调用模型，也不扩大工具权限。
   */
  admitQueued(): ContinuationTicket | null {
    this.runningRequestRevision = this.requestRevision;
    if (!this.queued) return null;
    this.active = this.queued;
    this.queued = null;
    return transitionTicket(this.active, "admitted");
  }

  /**
   * 标记当前 Pi 回合已经到达 `agent_end`，并解除运行 revision 绑定。
   *
   * @returns completed Ticket；普通用户回合返回 null。
   * @remarks 必须在权威任务重读和下一条 continuation 准入之前调用。
   */
  completeActive(): ContinuationTicket | null {
    this.runningRequestRevision = null;
    if (!this.active) return null;
    const completed = transitionTicket(this.active, "completed");
    this.active = null;
    return completed;
  }

  /**
   * 取消或废弃当前尚未结束的 Ticket。
   *
   * @param status 新用户输入使用 stale，任务完成、取消或关闭使用 cancelled。
   * @param reason 不含正文的稳定原因码。
   * @returns 状态发生变化的 Ticket 列表。
   */
  invalidate(
    status: Extract<ContinuationStatus, "stale" | "cancelled">,
    reason: string,
  ): ContinuationTicket[] {
    const changed: ContinuationTicket[] = [];
    if (this.queued) {
      changed.push(transitionTicket(this.queued, status, reason));
      this.queued = null;
    }
    if (this.active) {
      changed.push(transitionTicket(this.active, status, reason));
      this.active = null;
    }
    return changed;
  }

  /**
   * 判断当前工具调用是否属于仍有效的自动回合。
   *
   * @returns 没有自动回合或 active Ticket 仍绑定当前用户请求时返回 true。
   */
  activeRunIsCurrent(): boolean {
    return this.runningRequestRevision === null
      || this.runningRequestRevision === this.requestRevision;
  }

  /** 返回不含消息正文和业务证据的当前状态快照。 */
  snapshot(): ContinuationControllerSnapshot {
    return {
      taskId: this.taskId,
      requestRevision: this.requestRevision,
      progressRevision: this.progressRevision,
      attempts: this.attempts,
      queuedId: this.queued?.id ?? null,
      activeId: this.active?.id ?? null,
    };
  }
}
