/**
 * SQL Dungeon 项目适配器。
 *
 * 适配器是维护器通用运行时与具体游戏仓库之间的唯一连接点：它校验只读的
 * `.maintainer/project.json` 标识，登记固定检查命令，并提供试玩入口。项目文件
 * 不能声明命令、参数或权限，因而被修改的目标仓库无法借配置诱导维护器执行任意
 * Shell。所有命令使用 `execFile` 的参数数组，模型只能选择稳定检查 ID。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  DecisionCachePolicy,
  HarnessAdapter,
  HarnessScenario,
  HarnessSession,
  HarnessSessionOptions,
  HarnessStep,
  HarnessToolContext,
  HarnessVerdict,
} from "../../harness/contract.js";
import type { HarnessEvent } from "../../harness/events.js";
import type { CheckCatalog, CheckId, CheckSpec } from "../../tools/check.js";
import {
  GameBrowser,
  startGame,
  type DashboardBindings,
  type GameServer,
} from "./browser.js";
import { dungeonVerdict, scenarioFloor } from "./evidence.js";
import { createDungeonTools } from "./tools.js";

const SPECS: Readonly<Record<CheckId, CheckSpec>> = {
  "rules-test": { id: "rules-test", file: "python", args: ["scripts/test_validate_rules.py"] },
  "rules-validate": { id: "rules-validate", file: "python", args: ["scripts/validate-rules.py"] },
  "agent-test": { id: "agent-test", file: "python", args: ["-m", "unittest", "discover", "-s", "agent/tests"] },
  "game-test": { id: "game-test", file: "pnpm", args: ["--dir", "game", "test"] },
  "game-architecture": { id: "game-architecture", file: "pnpm", args: ["--dir", "game", "architecture:check"] },
  "game-build": { id: "game-build", file: "pnpm", args: ["--dir", "game", "build"] },
};

/**
 * SQL Dungeon 的静态检查目录。
 *
 * 源码变更需要游戏测试、架构检查和生产构建；仅测试变更只要求游戏测试。文档变更
 * 不强制执行游戏检查，但 Agent 仍可主动选择规则校验。所有命令均在维护器源码中
 * 固定，`.maintainer/project.json` 不能注入新命令。
 */
export const sqlDungeonChecks: CheckCatalog = {
  spec(id) {
    return SPECS[id];
  },
  required(paths) {
    if (paths.some((path) => path.startsWith("game/src/"))) {
      return ["game-test", "game-architecture", "game-build"];
    }
    if (paths.some((path) => path.startsWith("game/tests/"))) return ["game-test"];
    return [];
  },
};

const SCENARIOS: readonly HarnessScenario[] = Array.from({ length: 8 }, (_, index) => {
  const floor = index + 1;
  return {
    id: `floor-${String(floor)}`,
    label: `第 ${String(floor)} 层主流程`,
    goal: `通过真实玩家界面诊断并完成第 ${String(floor)} 层；发现客观异常时定位、受限修复、检查并复测。`,
  };
});

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const DECISION_CACHE: DecisionCachePolicy = {
  tools: ["look", "go", "use", "query"],
  sanitize(tool, value): Record<string, JsonValue> | null {
    const args = record(value);
    if (!args) return null;
    if ((tool === "look" || tool === "query") && exactKeys(args, [])) return {};
    if (tool === "go" && exactKeys(args, ["target", "maxSteps"])) {
      const target = args.target;
      const maxSteps = args.maxSteps;
      if ((target === "objective" || target === "frontier") && Number.isInteger(maxSteps) && Number(maxSteps) >= 1 && Number(maxSteps) <= 64) {
        return { target, maxSteps: Number(maxSteps) };
      }
    }
    if (tool === "use" && exactKeys(args, ["actionId"]) && typeof args.actionId === "string"
      && /^[a-z0-9:_-]{1,48}$/iu.test(args.actionId)) {
      return { actionId: args.actionId };
    }
    return null;
  },
};

/** Dashboard 在通用 Harness 会话之外需要的固定本机控制面。 */
export interface SqlDungeonDashboardSession extends HarnessSession {
  bindDashboard(bindings: DashboardBindings): Promise<void>;
  currentFloor(): Promise<number>;
  waitUntilClosed(signal?: AbortSignal): Promise<void>;
}

class SqlDungeonSession implements SqlDungeonDashboardSession {
  constructor(
    private readonly server: GameServer,
    private readonly browser: GameBrowser,
    private readonly preserveReload = false,
  ) {}

  async openScenario(scenario: HarnessScenario): Promise<void> {
    await this.browser.openFloor(scenarioFloor(scenario));
  }

  tools(context: HarnessToolContext) { return createDungeonTools(this.browser, context); }

  async verdict(scenario: HarnessScenario, steps: readonly HarnessStep[]): Promise<HarnessVerdict> {
    return dungeonVerdict(scenario, await this.browser.judge(scenarioFloor(scenario)), steps);
  }

  async probeVerdict(_scenario: HarnessScenario, steps: readonly HarnessStep[]): Promise<HarnessVerdict> {
    const health = await this.browser.health();
    const action = steps.some((step) => step.ok);
    const passed = health.bridge && health.runtime && health.errors === 0 && action;
    return {
      passed,
      summary: passed
        ? `当前第 ${String(health.floor)} 层仍可观察和执行，页面未记录运行错误。`
        : `当前环境健康检查失败：bridge=${String(health.bridge)} runtime=${String(health.runtime)} errors=${String(health.errors)} action=${String(action)}。`,
      metrics: {
        floor: health.floor,
        bridge: health.bridge,
        runtime: health.runtime,
        errors: health.errors,
        action,
      },
      facts: [passed ? "开发态桥和游戏运行时可用" : "开发态桥、运行时、错误计数或动作证据未通过"],
    };
  }

  async checkpoint(): Promise<void> {
    if (!this.preserveReload) throw new Error("普通试玩会话不建立源码刷新检查点");
    await this.browser.checkpoint();
  }
  async reload(): Promise<void> { await this.browser.reload(this.preserveReload); }
  async emit(event: HarnessEvent): Promise<void> { await this.browser.emitAgent(event); }
  async screenshot(path: string): Promise<void> { await this.browser.screenshot(path); }
  async close(): Promise<void> {
    try { await this.browser.close(); }
    finally { await this.server.close(); }
  }
  async bindDashboard(bindings: DashboardBindings): Promise<void> { await this.browser.bindDashboard(bindings); }
  async currentFloor(): Promise<number> { return await this.browser.currentFloor(); }
  async waitUntilClosed(signal?: AbortSignal): Promise<void> { await this.browser.waitUntilClosed(signal); }
}

async function openSession(
  options: HarnessSessionOptions,
  preserveReload: boolean,
): Promise<SqlDungeonSession> {
  const server = await startGame(options.repoRoot, options.url, options.signal);
  const browser = new GameBrowser(server.url, options.headed, options.output);
  try {
    await browser.open();
    return new SqlDungeonSession(server, browser, preserveReload);
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 创建由 Dashboard 持有的可视会话。
 * @param options 任务 worktree、输出目录和取消信号；不接受外部 URL。
 * @returns 刷新前建立一次性状态检查点的 SQL Dungeon 会话。
 */
export async function openSqlDungeonDashboard(
  options: Omit<HarnessSessionOptions, "headed" | "url">,
): Promise<SqlDungeonDashboardSession> {
  return await openSession({ ...options, headed: true }, true);
}

/** 把楼层号转换成静态场景 ID。 */
export function floorScenarioId(floor: number): string {
  if (!Number.isInteger(floor) || floor < 1 || floor > 8) throw new Error("楼层必须是 1..8");
  return `floor-${String(floor)}`;
}

/** 把静态场景 ID 还原为楼层，用于批准后恢复同一试玩范围。 */
export function floorFromScenarioId(id: string): number {
  return scenarioFloor({ id, label: id, goal: id });
}

/** SQL Dungeon 的唯一内置 Harness 适配器。 */
export const sqlDungeonAdapter: HarnessAdapter = {
  id: "sql-dungeon",
  version: 1,
  title: "SQL Dungeon",
  checks: sqlDungeonChecks,
  decisionCache: DECISION_CACHE,
  scenarios(ids) {
    const seen = new Set<string>();
    return ids.map((id) => {
      if (seen.has(id)) throw new Error(`重复场景：${id}`);
      seen.add(id);
      const scenario = SCENARIOS.find((item) => item.id === id);
      if (!scenario) throw new Error(`未知 SQL Dungeon 场景：${id}`);
      return scenario;
    });
  },
  systemPrompt(scenario) {
    return `你是 SQL Dungeon 的单一黑盒诊断与维护 Agent。
场景目标：${scenario.goal}
你必须通过真实环境工具观察、规划、行动、验证和纠错；第一步调用 look，每个回合只调用一个工具。
go 只选择 objective 或 frontier，路径由桥内 BFS 执行；遇到战斗、交互、剧情、死亡、楼层变化或阻塞后重新观察。
只有出现可复现的客观代码问题才 inspect；证据充分才 patch；patch 后必须 check，并通过重新加载的环境复测。
不能读取或猜测 SQL、管理员答案、完整地图、完整快照、存档、身份或密钥，也不要输出隐藏思维。
完成场景或确认客观阻断后调用 finish；游戏未通过但工具可用时使用 diagnosed，而不是伪造 PASS。`;
  },
  async open(options: HarnessSessionOptions): Promise<HarnessSession> {
    return await openSession(options, false);
  },
};

/**
 * 校验目标仓库选择了 SQL Dungeon 适配器。
 * @param root 目标仓库根目录。
 * @throws 文件缺失、额外字段、版本或适配器不匹配时拒绝。
 */
export async function verifyProject(root: string): Promise<void> {
  const value: unknown = JSON.parse(await readFile(join(root, ".maintainer", "project.json"), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目适配器配置非法");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "adapter,schemaVersion" || record.schemaVersion !== 1 || record.adapter !== "sql-dungeon") {
    throw new Error("目标仓库不是受支持的 SQL Dungeon 项目");
  }
}

/**
 * 返回固定检查定义。
 * @param id 模型只能从公开枚举选择的检查 ID。
 * @returns 不含 Shell 字符串和用户参数的命令定义。
 * @throws 未知 ID。
 */
export function checkSpec(id: string): CheckSpec {
  if (!Object.hasOwn(SPECS, id)) throw new Error(`未知检查 ID：${id}`);
  return sqlDungeonChecks.spec(id as CheckId);
}

/** 返回完整固定检查 ID，用于 CLI 帮助和测试。 */
export function checkIds(): CheckId[] { return Object.keys(SPECS) as CheckId[]; }
