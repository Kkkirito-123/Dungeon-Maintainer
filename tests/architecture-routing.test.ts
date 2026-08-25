/** 游戏区域职责地图、软路由和 inspect 覆盖回执的确定性测试。 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EvidenceStore } from "../src/evidence/store.js";
import { inspectActionKey } from "../src/evidence/projector.js";
import {
  architectureRouteCard,
  loadArchitectureMap,
  routeArchitecture,
} from "../src/inspection/architecture-map.js";
import { inspectTask } from "../src/pi/tools/inspect.js";
import { registerInspectTool } from "../src/pi/tools/inspect.js";
import { TaskStore } from "../src/task/store.js";
import { createTemporaryGitRepository } from "./testSupport.js";

const architectureMap = JSON.stringify({
  schemaVersion: 1,
  projectRoot: "game",
  layers: [
    { id: "domain", root: "game/src/domain", responsibility: "游戏领域规则" },
  ],
  areas: [
    {
      id: "domain.combat",
      parentId: "domain",
      root: "game/src/domain/combat",
      responsibility: "战斗生命与胜负",
      notResponsibleFor: ["界面"],
      signals: ["boss", "生命"],
      neighbors: ["domain.session"],
    },
    {
      id: "domain.session",
      parentId: "domain",
      root: "game/src/domain/session",
      responsibility: "状态协调",
      notResponsibleFor: ["界面"],
      signals: ["状态"],
      neighbors: ["domain.combat"],
    },
  ],
}, null, 2);

const architectureMapV2 = JSON.stringify({
  schemaVersion: 2,
  projectRoot: "game",
  layers: [
    { id: "presentation", root: "game/src/presentation", responsibility: "游戏展示" },
  ],
  areas: [
    {
      id: "presentation.phaser",
      parentId: "presentation",
      root: "game/src/presentation/phaser",
      responsibility: "Phaser 展示",
      notResponsibleFor: ["领域规则"],
      signals: ["phaser"],
      neighbors: [],
    },
  ],
  partitions: [
    {
      id: "presentation.phaser.actors",
      parentId: "presentation.phaser",
      root: "game/src/presentation/phaser/actors",
      responsibility: "角色展示",
      notResponsibleFor: ["角色规则"],
      signals: ["角色显示", "actor"],
      neighbors: [],
    },
  ],
}, null, 2);

const architectureMapV3 = JSON.stringify({
  schemaVersion: 3,
  projectRoot: "game",
  layers: [
    { id: "content", root: "game/src/content", responsibility: "游戏内容" },
    { id: "devtools", root: "game/src/devtools", responsibility: "开发维护桥" },
  ],
  areas: [
    {
      id: "content.world",
      parentId: "content",
      root: "game/src/content/world",
      responsibility: "世界内容",
      notResponsibleFor: ["领域状态"],
      signals: ["世界"],
      neighbors: [],
    },
    {
      id: "devtools.dungeon-agent",
      parentId: "devtools",
      root: "game/src/devtools/dungeon-agent",
      responsibility: "维护器语义动作桥",
      notResponsibleFor: ["生产规则"],
      signals: ["终端动作", "action-not-available", "点击后不可用"],
      neighbors: [],
    },
  ],
  partitions: [
    {
      id: "content.world.shared",
      parentId: "content.world",
      root: "game/src/content/world/shared",
      responsibility: "楼层共享只读契约",
      notResponsibleFor: ["单层内容"],
      signals: ["共享地图"],
      neighbors: [],
    },
  ],
  floorScopes: [
    {
      id: "floor.02",
      floor: 2,
      roots: ["game/src/content/world/floors/floor02"],
      responsibility: "第二层内容",
      signals: ["第二层", "2层"],
      neighbors: ["floor.03"],
      sharedPartitions: ["content.world.shared"],
    },
    {
      id: "floor.03",
      floor: 3,
      roots: ["game/src/content/world/floors/floor03"],
      responsibility: "第三层内容",
      signals: ["第三层", "3层"],
      neighbors: ["floor.02", "floor.04"],
      sharedPartitions: ["content.world.shared"],
    },
    {
      id: "floor.04",
      floor: 4,
      roots: ["game/src/content/world/floors/floor04"],
      responsibility: "第四层内容",
      signals: ["第四层", "4层"],
      neighbors: ["floor.03"],
      sharedPartitions: ["content.world.shared"],
    },
  ],
}, null, 2);

describe("游戏区域职责路由", () => {
  it("共享 benchmark 地图把终端动作路由到 devtools，而不是实时楼层", async () => {
    const fixtureRoot = join(
      process.cwd(),
      "test-fixtures",
      "agent-evals",
      "_bases",
      "game-repair-v1",
      "repository",
    );
    const loaded = await loadArchitectureMap(fixtureRoot);
    assert.equal(loaded.warning, null);
    const route = routeArchitecture(
      loaded.map,
      "游戏中玩家看到终端动作，但点击后不可用",
      1,
    );
    assert.ok(route);
    assert.equal(route.currentFloorScope, null);
    assert.equal(route.primaryAreas[0]?.id, "devtools.dungeon-agent");
    assert.equal(route.matchedSignals.includes("终端动作"), true);
  });

  it("只按稳定区域选择搜索根，不把地图当成文件索引", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMap,
      "game/src/domain/combat/damage.ts": "export const bossFloor = 1;\nexport const target = 'needle';\n",
      "game/src/domain/session/state.ts": "export const state = 'ready';\n",
      "game/src/domain/other.ts": "export const unrelated = 'needle';\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      assert.equal(loaded.warning, null);
      assert.ok(loaded.map);
      assert.deepEqual(loaded.map.partitions, []);
      assert.deepEqual(loaded.map.floorScopes, []);
      const route = routeArchitecture(loaded.map, "Boss 最终生命一直剩余 1");
      assert.equal(route?.primaryAreas[0]?.id, "domain.combat");
      assert.match(architectureRouteCard(route) ?? "", /domain\.combat/u);

      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-routing",
        objective: "修复 Boss 生命错误",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-routing", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => route,
      };
      const firstSearch = await inspectTask(context, { action: "search", query: "needle" });
      assert.match(firstSearch.text, /domain\/combat\/damage\.ts/u);
      assert.doesNotMatch(firstSearch.text, /domain\/other\.ts/u);
      assert.equal(firstSearch.details.expanded, false);

      const repeatedSearch = await inspectTask(context, { action: "search", query: "needle" });
      assert.equal(repeatedSearch.details.receiptOnly, true);
      assert.match(repeatedSearch.text, /ALREADY_SEEN/u);

      const firstRead = await inspectTask(context, {
        action: "read",
        path: "game/src/domain/combat/damage.ts",
        startLine: 1,
        lineCount: 2,
      });
      assert.equal(firstRead.details.receiptOnly, false);
      const overlappingRead = await inspectTask(context, {
        action: "read",
        path: "game/src/domain/combat/damage.ts",
        startLine: 2,
        lineCount: 2,
      });
      assert.equal(overlappingRead.details.lines, 1);
      assert.match(overlappingRead.text, /^\[EVIDENCE/mu);

      const batch = await inspectTask(context, {
        action: "read_many",
        ranges: [
          { path: "game/src/domain/combat/damage.ts", startLine: 1, lineCount: 2 },
          { path: "game/src/domain/session/state.ts", startLine: 1, lineCount: 1 },
        ],
      });
      assert.equal(batch.details.items?.length, 2);
      assert.match(batch.text, /READ_MANY_RECEIPT/u);
      assert.match(batch.text, /baseHash=/u);
    } finally {
      await repository.dispose();
    }
  });

  it("schema v3 按当前楼层、相邻楼层、共享父级服务三级扩展", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMapV3,
      "game/src/content/world/floors/floor02/content.ts": "export const floor02 = 'other';\n",
      "game/src/content/world/floors/floor03/content.ts": "export const currentNeedle = 'current-needle';\n",
      "game/src/content/world/floors/floor03/imports.ts": "import { sharedProviderNeedle } from '../../shared/service.js';\nexport const provider = 1;\n",
      "game/src/content/world/floors/floor04/content.ts": "export const adjacentNeedle = 'adjacent-needle';\n",
      "game/src/content/world/shared/service.ts": "export const sharedNeedle = 'shared-needle';\n",
      "game/src/content/world/shared/provider.ts": "export const sharedProviderNeedle = true;\n",
      "game/src/content/world/fallback.ts": "export const fallbackNeedle = 'fallback-needle';\n",
      "game/src/devtools/dungeon-agent/actions.ts": "export const terminalNeedle = 'terminal-needle';\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      assert.equal(loaded.warning, null);
      assert.equal(loaded.map?.schemaVersion, 3);
      const route = routeArchitecture(loaded.map, "没有显式楼层的故障", 3);
      assert.equal(route?.currentFloorScope?.id, "floor.03");
      assert.deepEqual(
        route.neighborFloorScopes.map((scope) => scope.id),
        ["floor.02", "floor.04"],
      );
      assert.deepEqual(route.sharedPartitions.map((partition) => partition.id), [
        "content.world.shared",
      ]);
      assert.match(architectureRouteCard(route) ?? "", /floor\.03/u);

      const terminalRoute = routeArchitecture(
        loaded.map,
        "游戏中玩家看到终端动作，但点击后不可用",
        3,
      );
      assert.ok(terminalRoute);
      assert.equal(terminalRoute.currentFloorScope, null);
      assert.equal(terminalRoute.primaryAreas[0]?.id, "devtools.dungeon-agent");

      const dataDir = join(repository.temporaryRoot, "data-v3");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-routing-v3",
        objective: "修复第三层",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-routing-v3", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => route,
      };

      const current = await inspectTask(context, { action: "bundle", query: "current-needle" });
      assert.equal(current.details.expansionLevel, "floor-current");
      assert.equal(current.details.floorRouteLevel, "current");
      assert.equal(current.details.floorScopeCount, 1);

      const adjacent = await inspectTask(context, { action: "bundle", query: "adjacent-needle" });
      assert.equal(adjacent.details.expansionLevel, "floor-adjacent");
      assert.equal(adjacent.details.floorRouteLevel, "adjacent");
      assert.equal(adjacent.details.floorScopeCount, 3);

      const shared = await inspectTask(context, { action: "bundle", query: "shared-needle" });
      assert.equal(shared.details.expansionLevel, "floor-shared");
      assert.equal(shared.details.floorRouteLevel, "shared");
      assert.equal(shared.details.floorScopeCount, 3);

      const provider = await inspectTask(context, {
        action: "bundle",
        query: "sharedProviderNeedle",
      });
      assert.equal(provider.details.expansionLevel, "floor-shared");
      assert.equal(provider.details.floorRouteLevel, "shared");
      assert.equal(provider.details.bundleWindows, 2);
      assert.match(provider.text, /import \{ sharedProviderNeedle \}/u);
      assert.match(provider.text, /export const sharedProviderNeedle/u);

      const fallback = await inspectTask(context, { action: "search", query: "fallback-needle" });
      assert.equal(fallback.details.expansionLevel, "owning-area");
      assert.equal(fallback.details.floorRouteLevel, "fallback");
      assert.equal(fallback.details.floorScopeCount, 3);

      const explicitFloor = await inspectTask(context, {
        action: "bundle",
        query: "adjacent-needle",
        floorId: "floor.04",
      });
      assert.equal(explicitFloor.details.floorRouteLevel, "current");
      assert.equal(explicitFloor.details.receiptOnly, false);
      const repeated = await inspectTask(context, {
        action: "bundle",
        query: "  ADJACENT-NEEDLE  ",
        floorId: "floor.04",
      });
      assert.equal(repeated.details.receiptOnly, true);
      assert.match(repeated.text, /floorRouteLevel=current/u);

      assert.notEqual(
        inspectActionKey({ action: "bundle", query: "needle", floorId: "floor.03" }),
        inspectActionKey({ action: "bundle", query: "needle", floorId: "floor.04" }),
      );
      assert.notEqual(
        inspectActionKey({ action: "read_many", ranges: [{ path: "a.ts", startLine: 1, lineCount: 8 }] }),
        inspectActionKey({ action: "read_many", ranges: [{ path: "a.ts", startLine: 9, lineCount: 8 }] }),
      );
      assert.equal(
        inspectActionKey({ action: "read", path: "A\\B.ts" }),
        inspectActionKey({ action: "read", path: "a/b.ts", startLine: 1, lineCount: 80 }),
      );
      assert.equal(
        inspectActionKey({ action: "read_many", ranges: [{ path: "A\\B.ts" }] }),
        inspectActionKey({
          action: "read_many",
          ranges: [{ path: "a/b.ts", startLine: 1, lineCount: 80 }],
        }),
      );
    } finally {
      await repository.dispose();
    }
  });

  it("schema v3 拒绝跨层邻接", async () => {
    const invalid = JSON.parse(architectureMapV3) as {
      floorScopes: Array<{ neighbors: string[]; sharedPartitions: string[] }>;
    };
    const first = invalid.floorScopes[0];
    assert.ok(first);
    first.neighbors = ["floor.04"];
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": JSON.stringify(invalid),
      "game/src/content/world/floors/floor02/content.ts": "export const floor02 = 2;\n",
      "game/src/content/world/floors/floor03/content.ts": "export const floor03 = 3;\n",
      "game/src/content/world/floors/floor04/content.ts": "export const floor04 = 4;\n",
      "game/src/content/world/shared/service.ts": "export const shared = true;\n",
      "game/src/devtools/dungeon-agent/actions.ts": "export const action = true;\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      assert.equal(loaded.map, null);
      assert.match(loaded.warning ?? "", /只能引用相邻楼层/u);
    } finally {
      await repository.dispose();
    }
  });

  it("schema v3 拒绝未知共享 partition", async () => {
    const invalid = JSON.parse(architectureMapV3) as {
      floorScopes: Array<{ sharedPartitions: string[] }>;
    };
    const first = invalid.floorScopes[0];
    assert.ok(first);
    first.sharedPartitions = ["content.world.missing"];
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": JSON.stringify(invalid),
      "game/src/content/world/floors/floor02/content.ts": "export const floor02 = 2;\n",
      "game/src/content/world/floors/floor03/content.ts": "export const floor03 = 3;\n",
      "game/src/content/world/floors/floor04/content.ts": "export const floor04 = 4;\n",
      "game/src/content/world/shared/service.ts": "export const shared = true;\n",
      "game/src/devtools/dungeon-agent/actions.ts": "export const action = true;\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      assert.equal(loaded.map, null);
      assert.match(loaded.warning ?? "", /未知 partition/u);
    } finally {
      await repository.dispose();
    }
  });

  it("schema v2 优先路由稳定 partition，并一次返回多个不重叠源码窗口", async () => {
    const actorSource = Array.from({ length: 150 }, (_, index) => (
      index === 20 || index === 110
        ? "export const actorNeedle" + String(index) + " = 'needle';"
        : "// actor line " + String(index)
    )).join("\n") + "\n";
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMapV2,
      "game/src/presentation/phaser/actors/ActorView.ts": actorSource,
      "game/src/presentation/phaser/other.ts": "export const unrelated = 'needle';\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      assert.equal(loaded.warning, null);
      assert.equal(loaded.map?.schemaVersion, 2);
      const route = routeArchitecture(loaded.map, "角色显示 actor 错误");
      assert.equal(route?.primaryPartitions[0]?.id, "presentation.phaser.actors");

      const dataDir = join(repository.temporaryRoot, "data-v2");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-routing-v2",
        objective: "修复角色显示",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-routing-v2", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => route,
      };
      const bundle = await inspectTask(context, { action: "bundle", query: "needle" });
      assert.equal(bundle.details.expansionLevel, "primary-partition");
      assert.equal(bundle.details.expanded, false);
      assert.equal(bundle.details.bundleWindows, 2);
      assert.equal(bundle.details.items?.length, 2);
      assert.doesNotMatch(bundle.text, /phaser\/other\.ts/u);
      assert.match(bundle.text, /baseHash=/u);
      assert.ok(Buffer.byteLength(bundle.text, "utf8") <= 4 * 1024);

      const repeated = await inspectTask(context, {
        action: "bundle",
        query: "  NEEDLE  ",
      });
      assert.equal(repeated.details.receiptOnly, true);
    } finally {
      await repository.dispose();
    }
  });

  it("bundle 只登记最终展示窗口，被 4 KiB 预算丢弃的窗口仍可精确读取", async () => {
    const padded = (label: string, markerLine: number): string => Array.from(
      { length: 96 },
      (_value, index) => index + 1 === markerLine
        ? `export const ${label} = 'budget-needle';`
        : "// " + label + " padded source " + "x".repeat(20) + " " + String(index + 1),
    ).join("\n") + "\n";
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMapV2,
      "game/src/presentation/phaser/actors/Alpha.ts": padded("alpha", 20),
      "game/src/presentation/phaser/actors/Beta.ts": padded("beta", 20),
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      const route = routeArchitecture(loaded.map, "角色显示 actor 错误");
      const dataDir = join(repository.temporaryRoot, "data-bundle-budget");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-bundle-budget",
        objective: "验证 bundle 覆盖账本",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-bundle-budget", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => route,
      };
      const bundle = await inspectTask(context, { action: "bundle", query: "budget-needle" });
      assert.equal(bundle.details.bundleWindows, 1);
      assert.ok(Buffer.byteLength(bundle.text, "utf8") <= 4 * 1024);
      const shownPath = bundle.details.items?.[0]?.path;
      const droppedPath = shownPath?.endsWith("Alpha.ts")
        ? "game/src/presentation/phaser/actors/Beta.ts"
        : "game/src/presentation/phaser/actors/Alpha.ts";
      const preciseRead = await inspectTask(context, {
        action: "read",
        path: droppedPath,
        startLine: 20,
        lineCount: 1,
      });
      assert.equal(preciseRead.details.receiptOnly, false);
      assert.match(preciseRead.text, /budget-needle/u);
    } finally {
      await repository.dispose();
    }
  });

  it("bundle 遇到长行源码仍保留一个可展示窗口", async () => {
    const longLine = "x".repeat(6_000);
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMapV2,
      "game/src/presentation/phaser/actors/LongLine.ts": [
        `export const longNeedle = '${longLine}';`,
        "export const stable = true;",
      ].join("\n"),
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      const route = routeArchitecture(loaded.map, "角色显示 actor 错误");
      const dataDir = join(repository.temporaryRoot, "data-bundle-long-line");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-bundle-long-line",
        objective: "验证长行 bundle 预算",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-bundle-long-line", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => route,
      };
      const bundle = await inspectTask(context, { action: "bundle", query: "longNeedle" });
      assert.equal(bundle.details.bundleWindows, 1);
      assert.ok(Buffer.byteLength(bundle.text, "utf8") <= 4 * 1024);
      assert.match(bundle.text, /LongLine\.ts/u);
    } finally {
      await repository.dispose();
    }
  });

  it("read_many 只登记最终 4 KiB 内实际展示的源码", async () => {
    const padded = (label: string): string => Array.from(
      { length: 80 },
      (_value, index) => "// " + label + " source " + "x".repeat(28) + " " + String(index + 1),
    ).join("\n") + "\n";
    const repository = await createTemporaryGitRepository({
      "game/src/domain/combat/Alpha.ts": padded("alpha"),
      "game/src/domain/combat/Beta.ts": padded("beta"),
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data-read-many-budget");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-read-many-budget",
        objective: "验证 read_many 覆盖账本",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-read-many-budget", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = { task, store, evidence };
      const batch = await inspectTask(context, {
        action: "read_many",
        ranges: [
          { path: "game/src/domain/combat/Alpha.ts", startLine: 1, lineCount: 80 },
          { path: "game/src/domain/combat/Beta.ts", startLine: 1, lineCount: 80 },
        ],
      });
      assert.equal(batch.details.truncated, true);
      assert.ok(Buffer.byteLength(batch.text, "utf8") <= 4 * 1024);
      const shownPaths = new Set(batch.details.items?.map((item) => item.path));
      assert.equal(shownPaths.size, 1);
      const droppedPath = shownPaths.has("game/src/domain/combat/Alpha.ts")
        ? "game/src/domain/combat/Beta.ts"
        : "game/src/domain/combat/Alpha.ts";
      const preciseRead = await inspectTask(context, {
        action: "read",
        path: droppedPath,
        startLine: 1,
        lineCount: 1,
      });
      assert.equal(preciseRead.details.receiptOnly, false);
      assert.match(preciseRead.text, /source/u);
    } finally {
      await repository.dispose();
    }
  });

  it("bundle 按实际源码片段统计窗口，回执不计入窗口", async () => {
    const source = (needle: string): string => Array.from(
      { length: 80 },
      (_value, index) => index + 1 === 20
        ? `export const marker = '${needle}';`
        : "// source line " + String(index + 1),
    ).join("\n") + "\n";
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMapV2,
      "game/src/presentation/phaser/actors/Split.ts": source("split-needle"),
      "game/src/presentation/phaser/actors/Covered.ts": source("covered-needle"),
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      const route = routeArchitecture(loaded.map, "角色显示 actor 错误");
      const dataDir = join(repository.temporaryRoot, "data-bundle-window-count");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-bundle-window-count",
        objective: "验证 bundle 窗口统计",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-bundle-window-count", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => route,
      };

      await inspectTask(context, {
        action: "read",
        path: "game/src/presentation/phaser/actors/Split.ts",
        startLine: 20,
        lineCount: 10,
      });
      const split = await inspectTask(context, { action: "bundle", query: "split-needle" });
      assert.equal(split.details.bundleWindows, 2);
      assert.match(split.text, /windows=2/u);
      assert.equal(split.details.items?.length, 2);
      assert.equal(split.details.items.every((item) => !item.receiptOnly), true);

      await inspectTask(context, {
        action: "read",
        path: "game/src/presentation/phaser/actors/Covered.ts",
        startLine: 4,
        lineCount: 48,
      });
      const covered = await inspectTask(context, { action: "bundle", query: "covered-needle" });
      assert.equal(covered.details.bundleWindows, 0);
      assert.match(covered.text, /windows=0/u);
      assert.equal(covered.details.items?.length, 1);
      assert.equal(covered.details.items[0]?.receiptOnly, true);
    } finally {
      await repository.dispose();
    }
  });

  it("读取覆盖缓存统一点段、分隔符和 Windows 大小写", async () => {
    const canonicalPath = "game/src/domain/session/State.ts";
    const repository = await createTemporaryGitRepository({
      [canonicalPath]: "export const state = 'ready';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data-read-path-cache");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-read-path-cache",
        objective: "验证读取路径缓存",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-read-path-cache", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      const context = { task, store, evidence };
      const first = await inspectTask(context, {
        action: "read",
        path: ".\\game\\src\\domain\\session\\State.ts",
        startLine: 1,
        lineCount: 1,
      });
      assert.equal(first.details.receiptOnly, false);
      const repeatedPath = process.platform === "win32"
        ? "GAME/SRC/DOMAIN/SESSION/state.ts"
        : canonicalPath;
      const repeated = await inspectTask(context, {
        action: "read",
        path: repeatedPath,
        startLine: 1,
        lineCount: 1,
      });
      assert.equal(repeated.details.receiptOnly, true);
      assert.equal(
        inspectActionKey({ action: "read", path: ".\\A\\B.ts" }),
        inspectActionKey({ action: "read", path: "a/b.ts", startLine: 1, lineCount: 80 }),
      );
    } finally {
      await repository.dispose();
    }
  });

  it("Extension 提供的预计算 worktree Hash 在一次 Inspect 中只消费一次", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": architectureMapV2,
      "game/src/presentation/phaser/actors/ActorView.ts": "export const needle = true;\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      const dataDir = join(repository.temporaryRoot, "data-hash-reuse");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "architecture-hash-reuse",
        objective: "验证 inspect hash 复用",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "architecture-hash-reuse", "pi"),
      });
      await store.transition(task, "active");
      const evidence = new EvidenceStore(dataDir, task);
      let hashProviderCalls = 0;
      let registeredExecute: ((...args: unknown[]) => unknown) | undefined;
      const fakePi = {
        registerTool(tool: { execute?: (...args: unknown[]) => unknown }): void {
          registeredExecute = tool.execute;
        },
      };
      registerInspectTool(fakePi as never, {
        task,
        store,
        evidence,
        architectureMap: () => loaded.map,
        architectureRoute: () => routeArchitecture(loaded.map, "actor", null),
        inspectWorktreeHash: () => {
          hashProviderCalls += 1;
          return "precomputed-worktree-hash";
        },
      });
      assert.ok(registeredExecute);
      await registeredExecute("hash-reuse-call", { action: "search", query: "needle" });
      assert.equal(hashProviderCalls, 1);
    } finally {
      await repository.dispose();
    }
  });

  it("地图非法时警告并回退，不阻止旧仓库", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/architecture-map.json": "{}",
      "game/src/domain/combat/damage.ts": "export const value = 1;\n",
    });
    try {
      const loaded = await loadArchitectureMap(repository.repoRoot);
      assert.equal(loaded.map, null);
      assert.match(loaded.warning ?? "", /回退普通搜索/u);
    } finally {
      await repository.dispose();
    }
  });
});
