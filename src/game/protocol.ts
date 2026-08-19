/**
 * 维护器与 SQL Dungeon 开发态桥的共享协议投影。
 *
 * 这些类型只包含可以进入 Pi 模型上下文的玩家可见状态和有限动作结果。完整地图、
 * SQL、管理员答案、正式存档、背包和身份不在协议中。隐藏 judge 只供验证代码使用，
 * 不由 look/go/use/query 工具返回给模型。
 */

/** 玩家可见的稳定动作入口。 */
export interface PlayAction {
  id: string;
  label: string;
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
}

/** 游戏桥增量提供的低敏内部语义事件。 */
export interface PlaytestEvent {
  sequence: number;
  type: string;
  summary: string;
}

/** 页面中 window.__DUNGEON_PLAYTEST__ 实现的协议 v2。 */
export interface DungeonPlaytestBridge {
  version: 2;
  readonly checkpointRestored: boolean;
  checkpoint(): boolean;
  look(): PlayView;
  go(
    target: "objective" | "frontier",
    maxSteps: number,
  ): Promise<PlayResult>;
  use(actionId: string): Promise<PlayResult>;
  query(): Promise<PlayResult>;
  judge(floor: number): PlayJudge;
  events?(afterSequence: number): readonly PlaytestEvent[];
}
