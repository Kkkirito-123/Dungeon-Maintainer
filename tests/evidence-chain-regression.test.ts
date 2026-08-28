/** Evidence Chain 审计回归：身份、失效、图关系与缓存回执。 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  changeEvidence,
  claimEvidence,
  gameEvidence,
} from "../src/evidence/projector.js";
import { EvidenceStore } from "../src/evidence/store.js";
import { registerEvidenceTool } from "../src/pi/tools/evidence.js";
import { inspectTask } from "../src/pi/tools/inspect.js";
import { TaskStore } from "../src/task/store.js";
import { hashWorktree } from "../src/workspace/git.js";
import { syncWorktreeChanges } from "../src/workspace/changes.js";
import { createTemporaryGitRepository } from "./testSupport.js";

describe("Evidence Chain 审计回归", () => {
  it("相同内容的不同路径产生独立 read 证据", async () => {
    const body = "export const same = 'content';\n";
    const repository = await createTemporaryGitRepository({
      "src/first.ts": body,
      "src/second.ts": body,
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "read-path-identity",
        objective: "验证源码证据路径身份",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "read-path-identity", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const first = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: "src/first.ts",
        startLine: 1,
        lineCount: 10,
      });
      const second = await inspectTask({ task, store, evidence }, {
        action: "read",
        path: "src/second.ts",
        startLine: 1,
        lineCount: 10,
      });

      assert.notEqual(second.details.evidenceId, first.details.evidenceId);
      assert.deepEqual(
        (await evidence.active("source")).map((record) => record.path).sort(),
        ["src/first.ts", "src/second.ts"],
      );
    } finally {
      await repository.dispose();
    }
  });

  it("新 worktree 版本让旧 change 与终态 claim 失效，但保留 proposed", async () => {
    const path = "src/state.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const state = 'base';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "change-invalidates-terminal-claim",
        objective: "验证结论随代码版本失效",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "change-invalidates-terminal-claim", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const proposal = await evidence.capture(claimEvidence({
        status: "proposed",
        summary: "修改状态推进",
        risk: "无",
        links: [],
      }));
      await writeFile(join(repository.repoRoot, path), "export const state = 'first';\n", "utf8");
      const firstHash = await hashWorktree(repository.repoRoot);
      const firstChange = await evidence.capture(changeEvidence(
        [path],
        firstHash,
        [proposal.record.id],
      ));
      const result = await evidence.capture(claimEvidence({
        status: "result",
        summary: "状态推进已修复",
        risk: "无",
        links: [firstChange.record.id],
      }));

      await writeFile(join(repository.repoRoot, path), "export const state = 'second';\n", "utf8");
      const secondHash = await hashWorktree(repository.repoRoot);
      await evidence.invalidatePaths([path], secondHash);
      const secondChange = await evidence.capture(changeEvidence(
        [path],
        secondHash,
        [proposal.record.id],
      ));

      assert.equal((await evidence.get(firstChange.record.id))?.status, "stale");
      assert.equal((await evidence.get(result.record.id))?.status, "stale");
      assert.equal((await evidence.get(proposal.record.id))?.status, "active");
      assert.equal((await evidence.get(secondChange.record.id))?.status, "active");
    } finally {
      await repository.dispose();
    }
  });

  it("direct write 的 change 链接修改前源码证据", async () => {
    const path = "src/direct.ts";
    const repository = await createTemporaryGitRepository({
      [path]: "export const state = 'before';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "direct-change-upstream",
        objective: "直接修改已读取源码",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "direct-change-upstream", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const read = await inspectTask({ task, store, evidence }, {
        action: "read",
        path,
        startLine: 1,
        lineCount: 20,
      });

      await writeFile(join(repository.repoRoot, path), "export const state = 'after';\n", "utf8");
      await syncWorktreeChanges(store, task, "direct-write", evidence);

      const change = await evidence.latest("change");
      assert.ok(change);
      assert.ok(change.links.includes(read.details.evidenceId));
      assert.equal((await evidence.get(read.details.evidenceId))?.status, "stale");
    } finally {
      await repository.dispose();
    }
  });

  it("bundle 主节点链接展示窗口，exact 回执保留显式搜索范围", async () => {
    const repository = await createTemporaryGitRepository({
      "game/src/domain/combat/resolve.ts": "export const routeNeedle = 'boss';\n",
      "game/src/domain/session/state.ts": "export const sessionState = 'ready';\n",
    });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "bundle-evidence-links",
        objective: "修复 boss 战斗结算",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "bundle-evidence-links", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const context = { task, store, evidence };
      const first = await inspectTask(context, {
        action: "bundle",
        query: "routeNeedle",
        path: "game/src/domain/combat",
      });
      const main = await evidence.get(first.details.evidenceId);
      const windowIds = [...new Set(first.details.items?.map((item) => item.evidenceId) ?? [])];
      assert.ok(main);
      assert.ok(windowIds.length > 0);
      assert.deepEqual(main.links, windowIds);
      assert.deepEqual(first.details.scope, ["game/src/domain/combat"]);
      assert.match(main.summary, /matches=1/u);
      assert.match(main.summary, /windows=1/u);

      const exact = await inspectTask(context, {
        action: "bundle",
        query: "  ROUTENEEDLE  ",
        path: "game/src/domain/combat",
      });
      assert.equal(exact.details.cacheKind, "exact");
      assert.deepEqual(exact.details.scope, ["game/src/domain/combat"]);
      assert.match(exact.text, /scope=game\/src\/domain\/combat/u);
      assert.match(exact.text, /matches=1/u);
      assert.match(exact.text, /windows=1/u);
    } finally {
      await repository.dispose();
    }
  });

  it("证据链接上限保留最近 32 条，而不是最旧 32 条", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "recent-claim-links",
        objective: "验证长调查链接选择",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "recent-claim-links", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const ids: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        ids.push((await evidence.capture(gameEvidence({
          toolName: "go",
          target: "step-" + String(index),
          ok: true,
        }))).record.id);
      }
      const claim = await evidence.capture(claimEvidence({
        status: "diagnosed",
        summary: "最新证据支持病因",
        risk: "无",
        links: ids,
      }));

      assert.deepEqual(claim.record.links, ids.slice(-32));
    } finally {
      await repository.dispose();
    }
  });

  it("evidence 工具不再要求每轮先 list", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-tool-guidance",
        objective: "验证证据工具提示",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-tool-guidance", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      let guidelines: readonly string[] = [];
      const pi = {
        registerTool(tool: { promptGuidelines?: readonly string[] }): void {
          guidelines = tool.promptGuidelines ?? [];
        },
      } as unknown as ExtensionAPI;
      registerEvidenceTool(pi, { task, store, evidence });

      assert.doesNotMatch(guidelines.join("\n"), /先用 evidence\(list\)/u);
      assert.match(guidelines.join("\n"), /已有 evidence ID.*直接.*get/u);
    } finally {
      await repository.dispose();
    }
  });
});
