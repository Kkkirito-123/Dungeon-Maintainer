/**
 * 维护器与 SQL Dungeon 开发态桥的共享协议投影。
 *
 * 这些类型只包含可以进入 Pi 模型上下文的玩家可见状态和有限动作结果。当前已打开
 * textarea 中玩家可见的 SQL 可以进入 terminal；受控 inputSql 只写固定输入框，完整地图、隐藏答案、管理员答案字段、
 * 正式存档、背包和身份不在协议中。隐藏 judge 只供验证代码使用。
 */

/** 玩家可见的稳定动作入口。 */
export interface PlayAction {
  id: string;
  label: string;
}

export type PlayQueryStatusKind = "neutral" | "success" | "warning" | "error";

export interface PlayTaskView {
  tier: string;
  situation: string;
  goal: string;
  outputs: readonly string[];
  fields: readonly {
    expression: string;
    meaning: string;
  }[];
  relations: readonly string[];
  constraints: readonly string[];
  success: string;
}

export interface PlayTerminalView {
  kind: "combat" | "challenge";
  title: string;
  objective: string;
  lessonId: string | null;
  stageId: string | null;
  stageIndex: number | null;
  task: PlayTaskView | null;
  schema: readonly string[];
  locks: readonly string[];
  hints: readonly string[];
  inputSql: string;
  status: {
    kind: PlayQueryStatusKind;
    text: string;
  };
  result: string;
  plan: readonly string[];
}

/** 经过游戏桥裁剪的玩家视图。 */
export interface PlayView {
  floor: number;
  mode: string;
  hp: {
    current: number;
    max: number;
    armor: number;
  };
  progress: {
    lessons: number;
    rooms: number;
    moves: number;
    queries: number;
    hintLevel: number;
  };
  actions: PlayAction[];
  room: string;
  mission: {
    title: string;
    body: string;
    lesson: string;
  };
  record: {
    kicker: string;
    title: string;
    body: string;
  } | null;
  terminal: PlayTerminalView | null;
  prompt: string;
  banner: string;
}

/** 一个真实游戏语义动作的有限结果。 */
export interface PlayResult {
  ok: boolean;
  event: string;
  steps: number;
  view: PlayView;
}

/** 仅供确定性验证使用的隐藏裁判摘要。 */
export interface PlayJudge {
  floor: number;
  mode: string;
  lessons: number;
  requiredLessons: number;
  bossDefeated: boolean;
  migrationSteps: number;
  migrationComplete: boolean;
  advanced: boolean;
  stageIndex?: number;
  claimableReward?: string | null;
  bossHp?: number | null;
  victories?: number;
  guidanceDistance?: number | null;
}

/** 游戏桥增量提供的低敏内部语义事件。 */
export interface PlaytestEvent {
  sequence: number;
  type: string;
  summary: string;
}

/** 页面中 window.__DUNGEON_PLAYTEST__ 实现的当前协议 v3 投影。 */
export interface DungeonPlaytestBridge {
  version: 3;
  readonly checkpointRestored: boolean;
  prepare(presetId: string): boolean;
  checkpoint(): boolean;
  look(): PlayView;
  go(
    target: "objective" | "frontier",
    maxSteps: number,
  ): Promise<PlayResult>;
  use(actionId: string): Promise<PlayResult>;
  inputSql(sql: string): Promise<PlayResult>;
  query(): Promise<PlayResult>;
  judge(floor: number): PlayJudge;
  events(afterSequence: number): readonly PlaytestEvent[];
}
