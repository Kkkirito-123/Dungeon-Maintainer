/** Inspection 领域边界与对外动作命名回归。 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { EvidenceStore } from "../src/evidence/store.js";
import { InspectParameters, inspectTask } from "../src/pi/tools/inspect.js";
import { TreeParameters } from "../src/pi/tools/tree.js";
import { TaskStore } from "../src/task/store.js";
import { createTemporaryGitRepository } from "./testSupport.js";

describe("Inspection 领域", () => {
  it("用 files 查看源码目录，并保留独立 tree 工具的工作树语义", async () => {
    assert.equal(Value.Check(InspectParameters, { action: "files" }), true);
    assert.equal(Value.Check(InspectParameters, { action: "tree" }), false);
    assert.equal(Value.Check(TreeParameters, { action: "list" }), true);

    const repository = await createTemporaryGitRepository({
      "src/game.ts": "export const state = 'ready';\n",
      "README.md": "test\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "inspect-files-action",
        objective: "验证源码目录动作命名",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "inspect-files-action", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);

      const output = await inspectTask({ task, store, evidence }, {
        action: "files",
        path: "src",
      });

      assert.equal(output.details.action, "files");
      assert.match(output.text, /game\.ts/u);
      assert.doesNotMatch(output.text, /README\.md/u);
    } finally {
      await repository.dispose();
    }
  });
});
