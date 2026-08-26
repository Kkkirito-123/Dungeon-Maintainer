/**
 * Pi 工具调用的领域化循环门禁。
 *
 * 职责：为已完成工具调用生成稳定摘要，保留最近八项结果，识别精确重复、A-B-A-B
 * 交替路线和长时间无进展，并在客观进展出现后解除当前冻结。
 * 非职责：不解释模型正文、不调用 Pi、不读取任务或工作区、不决定哪些事实算作领域证据；
 * 证据值和路线值由 Extension 按工具语义提供。
 * 输入输出：调用前接收工具名、参数和可选路线，返回允许、策略重置、阻止或硬停止决策；
 * 调用后接收结果与 EvidenceStore revision，只保存 SHA-256 摘要和数字版本。
 * 相邻模块边界：Extension 负责遵守门禁、构造领域证据并注入策略重置；任务状态和持久化
 * 仍由 TaskStore 负责，本模块只维护单活动任务的进程内状态。
 * 副作用与权限：除进程内计数与冻结集合外无副作用，不访问文件、网络、进程或任何工具权限。
 * 隐私：最近结果仅包含工具名和不可逆摘要；原始参数、结果与证据不会被本模块持久化。
 * 关键失败模式与恢复：循环引用无法形成确定性摘要时会抛出 TypeError；调用方应拒绝该次
 * 工具调用并修正领域投影。任务切换必须用当前证据 revision 调用 resetForNewTask；
 * 后续只有调用方按工具语义明确 madeProgress 才算客观进展；Evidence revision 只作
 * 低敏审计水位，不能把零命中搜索或新增回执误判为问题求解进展。
 */

import { createHash } from "node:crypto";

const MAX_RECENT_OUTCOMES = 8;
const STRATEGY_RESET_THRESHOLD = 5;
const HARD_STOP_THRESHOLD = 8;

/** 调用前参与循环判断的最小工具动作，不包含执行结果。 */
export interface LoopAction {
  /** 固定工具名，用于避免不同工具的同形参数互相碰撞。 */
  toolName: string;
  /** 已按工具领域语义规范化的参数；不得包含无意义的时间戳或随机调用 ID。 */
  input: unknown;
  /** 可选的更粗粒度路线投影；省略时使用完整动作作为路线。 */
  route?: unknown;
}

/** 已完成工具调用的低敏记录，只保存稳定摘要和产生时的进展版本。 */
export interface ActionOutcome {
  /** 执行该动作的固定工具名。 */
  toolName: string;
  /** 工具名和规范化参数的 SHA-256 摘要。 */
  actionDigest: string;
  /** 用于识别 A-B-A-B 的领域路线摘要。 */
  routeDigest: string;
  /** 规范化工具结果的 SHA-256 摘要。 */
  resultDigest: string;
  /** 本次调用完成后的 EvidenceStore revision。 */
  evidenceRevision: number;
  /** 记录该结果时的客观进展版本。 */
  progressRevision: number;
}

/** 执行完成后交给循环门禁记账的结果与领域证据。 */
export interface CompletedAction {
  /** 与调用前判断使用同一领域投影的动作。 */
  action: LoopAction;
  /** 已按工具语义移除随机字段的结果投影。 */
  result: unknown;
  /** 本次调用完成后的 EvidenceStore revision；缓存命中不会增加它。 */
  evidenceRevision: number;
  /** 非 EvidenceStore 事实的显式进展；一般调用方应省略。 */
  madeProgress?: boolean;
}

/**
 * 工具调用前的门禁决策。
 *
 * `strategy_reset`、`block` 和 `hard_stop` 都表示本次工具不得执行，因此也不得调用
 * recordOutcome。策略重置只在同一进展版本首次达到阈值时返回一次。
 */
export type LoopGuardDecision =
  | { kind: "allow"; noProgressCount: number }
  | { kind: "strategy_reset"; reason: "no_progress"; noProgressCount: number }
  | {
    kind: "block";
    reason: "exact_action_result" | "alternating_route" | "route_no_progress";
    noProgressCount: number;
  }
  | { kind: "hard_stop"; reason: "no_progress"; noProgressCount: number };

function stableSerialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "boolean":
      return `boolean:${value ? "true" : "false"}`;
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Number.POSITIVE_INFINITY) return "number:+Infinity";
      if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${String(value)}`;
    case "bigint":
      return `bigint:${value.toString(10)}`;
    case "undefined":
      return "undefined";
    case "symbol":
      return `symbol:${JSON.stringify(value.description ?? "")}`;
    case "function":
      return `function:${JSON.stringify(value.name)}`;
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("无法为包含循环引用的值生成稳定摘要");
      }
      ancestors.add(value);
      try {
        if (value instanceof Date) return `date:${value.toISOString()}`;
        if (Array.isArray(value)) {
          return `array:[${value.map((item) => stableSerialize(item, ancestors)).join(",")}]`;
        }
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .sort((left, right) => left.localeCompare(right))
          .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], ancestors)}`);
        return `object:{${entries.join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
  }
  throw new TypeError("无法为未知类型生成稳定摘要");
}

/**
 * 为任意领域投影生成稳定 SHA-256 摘要。
 *
 * @param value 工具动作、结果或证据的低敏领域投影；对象键顺序不影响结果。
 * @returns 六十四位小写十六进制 SHA-256 摘要，不包含原始输入。
 * @throws {TypeError} 输入包含循环引用时抛出；调用方不得用不稳定随机值重试规避门禁。
 * @remarks 本函数无文件或网络副作用，也不会扩大工具权限。
 */
export function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value, new Set<object>())).digest("hex");
}

function actionDigest(action: LoopAction): string {
  return stableDigest({ input: action.input, toolName: action.toolName });
}

function routeDigest(action: LoopAction): string {
  return stableDigest({
    route: action.route ?? action.input,
    toolName: action.toolName,
  });
}

/**
 * 单活动任务的进程内循环门禁。
 *
 * 调用方必须先调用 evaluateAction；只有返回 `allow` 并完成真实工具调用后，才调用
 * recordOutcome。该顺序保证被阻止调用不会消耗循环次数或无进展预算。
 */
export class LoopGuard {
  private outcomes: ActionOutcome[] = [];
  private frozenActionDigests = new Set<string>();
  private frozenRouteDigests = new Set<string>();
  private noProgressRouteCounts = new Map<string, number>();
  private strategyResetRevision: number | null = null;
  private hardStopRevision: number | null = null;
  private currentProgressRevision = 0;
  private currentNoProgressCount = 0;
  private observedEvidenceRevision = 0;

  /**
   * 返回当前进展版本。
   *
   * @returns 从零开始、仅由证据 revision 或显式进展推进的单调递增版本号。
   * @remarks 只读访问，不修改门禁状态，也不涉及任何工具权限。
   */
  public get progressRevision(): number {
    return this.currentProgressRevision;
  }

  /**
   * 返回当前进展版本内连续没有客观进展的已完成调用数。
   *
   * @returns 零到硬停止阈值之间的计数；被阻止的调用不会增加该值。
   * @remarks 只读访问，无副作用。
   */
  public get noProgressCount(): number {
    return this.currentNoProgressCount;
  }

  /**
   * 返回最近八项已完成结果的防御性副本。
   *
   * @returns 按执行顺序排列的低敏 ActionOutcome；修改返回数组不会影响门禁。
   * @remarks 只读访问，不返回原始动作、结果、源码或 SQL。
   */
  public get recentOutcomes(): readonly ActionOutcome[] {
    return this.outcomes.map((outcome) => ({ ...outcome }));
  }

  /**
   * 在工具执行前判断当前动作能否运行。
   *
   * @param action 已按领域语义规范化的工具动作和可选路线。
   * @returns `allow` 才可执行；其余决策要求阻止本次调用并由 Extension 处理提示或收尾。
   * @throws {TypeError} 动作或路线含循环引用，无法形成稳定摘要时抛出。
   * @remarks 本方法不会记录 Outcome 或增加无进展次数；首次策略重置会在当前版本内被标记，
   * 避免每个后续动作都重复注入同一提示。它不调用工具，也不改变外部权限。
   */
  public evaluateAction(action: LoopAction): LoopGuardDecision {
    const nextActionDigest = actionDigest(action);
    const nextRouteDigest = routeDigest(action);

    if (action.toolName !== "finish"
      && (this.hardStopRevision === this.currentProgressRevision
      || this.currentNoProgressCount >= HARD_STOP_THRESHOLD)) {
      this.hardStopRevision = this.currentProgressRevision;
      return {
        kind: "hard_stop",
        reason: "no_progress",
        noProgressCount: this.currentNoProgressCount,
      };
    }

    if (this.frozenActionDigests.has(nextActionDigest)) {
      return {
        kind: "block",
        reason: "exact_action_result",
        noProgressCount: this.currentNoProgressCount,
      };
    }
    if (this.frozenRouteDigests.has(nextRouteDigest)) {
      return {
        kind: "block",
        reason: "alternating_route",
        noProgressCount: this.currentNoProgressCount,
      };
    }

    const currentOutcomes = this.outcomes.filter(
      (outcome) => outcome.progressRevision === this.currentProgressRevision,
    );
    const matchingActions = currentOutcomes.filter(
      (outcome) => outcome.actionDigest === nextActionDigest,
    );
    const previous = matchingActions.at(-1);
    const beforePrevious = matchingActions.at(-2);
    if (previous && beforePrevious && previous.resultDigest === beforePrevious.resultDigest) {
      this.frozenActionDigests.add(nextActionDigest);
      return {
        kind: "block",
        reason: "exact_action_result",
        noProgressCount: this.currentNoProgressCount,
      };
    }

    // 搜索词属于一次动作的细节，不属于调查路线。调用方可以把同一 worktree、
    // action 和 scope 投影为同一路线；前两次都没有明确源码覆盖进展后，第三个
    // 同义 query 必须在执行 rg 前被挡住，不能靠改写关键词绕过精确动作去重。
    if (action.toolName === "inspect" && (this.noProgressRouteCounts.get(nextRouteDigest) ?? 0) >= 2) {
      this.frozenRouteDigests.add(nextRouteDigest);
      return {
        kind: "block",
        reason: "route_no_progress",
        noProgressCount: this.currentNoProgressCount,
      };
    }

    const thirdLast = currentOutcomes.at(-3);
    const secondLast = currentOutcomes.at(-2);
    const last = currentOutcomes.at(-1);
    if (thirdLast
      && secondLast
      && last
      && thirdLast.routeDigest === last.routeDigest
      && secondLast.routeDigest === nextRouteDigest
      && thirdLast.routeDigest !== secondLast.routeDigest) {
      this.frozenRouteDigests.add(thirdLast.routeDigest);
      this.frozenRouteDigests.add(secondLast.routeDigest);
      return {
        kind: "block",
        reason: "alternating_route",
        noProgressCount: this.currentNoProgressCount,
      };
    }

    if (this.currentNoProgressCount >= STRATEGY_RESET_THRESHOLD
      && this.strategyResetRevision !== this.currentProgressRevision) {
      this.strategyResetRevision = this.currentProgressRevision;
      return {
        kind: "strategy_reset",
        reason: "no_progress",
        noProgressCount: this.currentNoProgressCount,
      };
    }

    return { kind: "allow", noProgressCount: this.currentNoProgressCount };
  }

  /**
   * 记录一次已经真实完成的工具调用，并判断它是否带来了新证据。
   *
   * @param completed 允许执行的动作、稳定结果投影和证据 revision。
   * @returns 调用方显式 madeProgress 时返回 true，否则返回 false。
   * @throws {TypeError} 结果投影含循环引用时抛出；失败时不写入部分状态。
   * @remarks cacheHit 不会增加 EvidenceStore revision，因此只增加无进展计数。本方法不调用
   * 工具、不持久化正文，也不扩大权限。
   */
  public recordOutcome(completed: CompletedAction): boolean {
    const nextActionDigest = actionDigest(completed.action);
    const nextRouteDigest = routeDigest(completed.action);
    const nextResultDigest = stableDigest(completed.result);
    const hasNewEvidence = completed.madeProgress === true;
    this.observedEvidenceRevision = Math.max(
      this.observedEvidenceRevision,
      completed.evidenceRevision,
    );

    if (hasNewEvidence) {
      this.advanceProgress();
    } else {
      this.currentNoProgressCount += 1;
      this.noProgressRouteCounts.set(
        nextRouteDigest,
        (this.noProgressRouteCounts.get(nextRouteDigest) ?? 0) + 1,
      );
    }

    const outcome: ActionOutcome = {
      toolName: completed.action.toolName,
      actionDigest: nextActionDigest,
      routeDigest: nextRouteDigest,
      resultDigest: nextResultDigest,
      evidenceRevision: completed.evidenceRevision,
      progressRevision: this.currentProgressRevision,
    };
    this.outcomes.push(outcome);
    if (this.outcomes.length > MAX_RECENT_OUTCOMES) {
      this.outcomes.splice(0, this.outcomes.length - MAX_RECENT_OUTCOMES);
    }
    return hasNewEvidence;
  }

  /**
   * 处理一次由证据 revision 或调用方显式确认产生的客观进展。
   *
   * @returns 无返回值；调用后 progressRevision 加一，无进展次数归零，当前冻结全部解除。
   * @remarks 只由 recordOutcome 调用，不读取 TaskStore、工作区或用户消息。
   */
  private advanceProgress(): void {
    this.currentProgressRevision += 1;
    this.currentNoProgressCount = 0;
    this.frozenActionDigests.clear();
    this.frozenRouteDigests.clear();
    this.noProgressRouteCounts.clear();
    this.strategyResetRevision = null;
    this.hardStopRevision = null;
  }

  /**
   * 清空上一任务的全部循环、证据和进展状态。
   *
   * @returns 无返回值；最近结果、冻结、计数和版本全部恢复到给定证据 revision。
   * @remarks 单活动任务切换前必须调用；它只修改本实例内存，不删除任务文件、不终止 Pi、
   * 不触发工具，也不持久化任何内容。
   */
  public resetForNewTask(evidenceRevision = 0): void {
    this.outcomes = [];
    this.frozenActionDigests.clear();
    this.frozenRouteDigests.clear();
    this.noProgressRouteCounts.clear();
    this.strategyResetRevision = null;
    this.hardStopRevision = null;
    this.currentProgressRevision = 0;
    this.currentNoProgressCount = 0;
    this.observedEvidenceRevision = evidenceRevision;
  }

  /**
   * 开始同一 Bug Goal 的新 Episode。
   *
   * 清除只属于上一 Episode 的无进展计数和 hard stop，但保留已冻结的精确动作与
   * 路线，确保 recover 必须真正换策略，不能靠创建新 Episode 立刻重放同一动作。
   */
  public beginEpisode(): void {
    this.currentNoProgressCount = 0;
    this.strategyResetRevision = null;
    this.hardStopRevision = null;
  }
}
