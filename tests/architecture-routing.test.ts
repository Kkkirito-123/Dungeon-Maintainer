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
