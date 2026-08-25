/** 游戏区域职责地图、软路由和 inspect 覆盖回执的确定性测试。 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EvidenceStore } from "../src/evidence/store.js";
import {
  architectureRouteCard,
  loadArchitectureMap,
  routeArchitecture,
} from "../src/inspection/architecture-map.js";
import { inspectTask } from "../src/pi/tools/inspect.js";
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

describe("游戏区域职责路由", () => {
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
