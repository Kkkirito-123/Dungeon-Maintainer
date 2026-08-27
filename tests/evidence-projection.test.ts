import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildEvidenceCard } from "../src/evidence/card.js";
import { EvidenceStore } from "../src/evidence/store.js";
import type { EvidenceKind, EvidenceRecord } from "../src/evidence/types.js";
import { checkEvidence, sourceEvidence } from "../src/evidence/projector.js";
import {
  buildEvidenceSnapshot,
  getEvidenceDetail,
  listEvidenceNodes,
} from "../src/evidence/view.js";
import { createTemporaryGitRepository } from "./testSupport.js";
import { TaskStore } from "../src/task/store.js";
import { startShellServer } from "../src/shell/server.js";
import { EvidenceParameters } from "../src/pi/tools/evidence.js";

describe("Evidence Graph 低敏投影", () => {
  it("函数参数 Schema 使用 object 根节点，兼容 OpenAI-compatible 模型", () => {
    assert.equal(EvidenceParameters.type, "object");
    assert.equal("anyOf" in EvidenceParameters, false);
    assert.equal("oneOf" in EvidenceParameters, false);
  });

  it("模型证据卡按闭环类型保留最新事实，再用最新源码补足八条和 2 KiB", () => {
    let sequence = 0;
    const record = (kind: EvidenceKind, id: string, summary = id): EvidenceRecord => ({
      schemaVersion: 1,
      id,
      taskId: "card-budget",
      kind,
      actionKey: null,
      fingerprint: id,
      actionAliases: [],
      status: "active",
      summary,
      artifactRef: null,
      path: kind === "source" ? "src/" + id + ".ts" : null,
      startLine: kind === "source" ? 1 : null,
      lineCount: kind === "source" ? 24 : null,
      baseHash: kind === "source" ? "base-" + id : null,
      worktreeHash: null,
      validityKey: id,
      links: [],
      metadata: {},
      createdAt: new Date(sequence++ * 1_000).toISOString(),
    });
    const records = [
      record("claim", "old-claim"),
      record("reproduction", "latest-reproduction"),
      record("claim", "latest-claim"),
      record("change", "latest-change"),
      record("check", "latest-check"),
      record("verification", "latest-verification"),
      record("game", "noisy-game-snapshot"),
      ...Array.from({ length: 10 }, (_value, index) => record("source", "source-" + String(index))),
    ];

    const card = buildEvidenceCard(records);
    assert.ok(Buffer.byteLength(card, "utf8") <= 2 * 1024);
    assert.ok(card.split("\n").length <= 8);
    assert.match(card, /latest-reproduction/u);
    assert.match(card, /latest-claim/u);
    assert.match(card, /latest-change/u);
    assert.match(card, /latest-check/u);
    assert.match(card, /latest-verification/u);
    assert.match(card, /source-9/u);
    assert.doesNotMatch(card, /old-claim|noisy-game-snapshot|source-0/u);
  });

  it("按节点关系返回 list/get，并限制工件尾部和敏感正文", async () => {
    const repository = await createTemporaryGitRepository({ "src/game.ts": "export const state = 'ready';\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-view",
        objective: "测试证据链",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-view", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const source = await evidence.captureText(sourceEvidence({
        action: "read",
        path: "src/game.ts",
        startLine: 1,
        lineCount: 1,
      }, {
        action: "read",
        evidenceId: "",
        contentHash: "source-hash",
        baseHash: "base-hash",
        lines: 1,
        truncated: false,
        actionKey: "source-action",
        cacheKind: "none",
      }, "worktree-hash", ["src"]), "line 1\nSELECT hidden_answer;\n" );
      const checkLogPath = join(store.taskDir(task.id), "checks", "game-test.log");
      await mkdir(join(store.taskDir(task.id), "checks"), { recursive: true });
      await writeFile(checkLogPath, "check passed\napiKey=secret\n", "utf8");
      const check = await evidence.capture(checkEvidence({
        id: "game-test",
        worktreeHash: "worktree-hash",
        status: "passed",
        durationMs: 10,
        logPath: checkLogPath,
        savedAt: new Date().toISOString(),
      }));
      const claim = await evidence.capture({
        kind: "claim",
        actionKey: null,
        fingerprint: "claim-fingerprint",
        status: "active",
        summary: "方案已提交",
        artifactRef: null,
        path: null,
        startLine: null,
        lineCount: null,
        baseHash: null,
        worktreeHash: null,
        validityKey: "proposed",
        links: [source.record.id, check.record.id],
        metadata: {},
      });

      const listed = await listEvidenceNodes(evidence, { status: "active", limit: 10 });
      assert.equal(listed.records.length, 3);
      const sourceNode = listed.records.find((record) => record.id === source.record.id);
      assert.ok(sourceNode?.downstreamIds.includes(claim.record.id));
      const detail = await getEvidenceDetail(evidence, source.record.id);
      assert.ok(detail);
      assert.equal(detail.artifact.available, true);
      assert.doesNotMatch(detail.artifact.text, /SELECT hidden_answer/iu);
      const checkDetail = await getEvidenceDetail(evidence, check.record.id);
      assert.ok(checkDetail);
      assert.doesNotMatch(checkDetail.artifact.text, /apiKey=secret/iu);
      const snapshot = await buildEvidenceSnapshot(evidence);
      assert.equal(snapshot.taskId, task.id);
      assert.equal(snapshot.revision, evidence.revision);
      const card = buildEvidenceCard(await evidence.active());
      assert.match(card, /claim\/active/u);
      assert.match(card, /downstream=/u);
      assert.ok(Buffer.byteLength(card, "utf8") <= 2 * 1024);
      assert.doesNotMatch(card, /SELECT hidden_answer/iu);
      assert.equal(await readFile(join(dataDir, "tasks", task.id, "evidence.jsonl"), "utf8").then((text) => text.includes("SELECT hidden_answer")), false);
    } finally {
      await repository.dispose();
    }
  });

  it("stale/superseded 证据可过滤，未知 ID 不产生详情", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-status",
        objective: "测试状态过滤",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-status", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      await evidence.capture({
        kind: "game",
        actionKey: null,
        fingerprint: "active-game",
        status: "active",
        summary: "active",
        artifactRef: null,
        path: null,
        startLine: null,
        lineCount: null,
        baseHash: null,
        worktreeHash: null,
        validityKey: "runtime",
        links: [],
        metadata: {},
      });
      await evidence.capture({
        kind: "check",
        actionKey: null,
        fingerprint: "stale-check",
        status: "stale",
        summary: "stale",
        artifactRef: null,
        path: null,
        startLine: null,
        lineCount: null,
        baseHash: null,
        worktreeHash: null,
        validityKey: "old",
        links: [],
        metadata: {},
      });
      assert.equal((await listEvidenceNodes(evidence, { status: "active" })).records.length, 1);
      assert.equal((await listEvidenceNodes(evidence, { status: "stale" })).records.length, 1);
      assert.equal(await getEvidenceDetail(evidence, "0000000000000000"), null);
    } finally {
      await repository.dispose();
    }
  });

  it("Shell 只保留最新 evidence.snapshot，并按 revision 去重", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "evidence-shell",
        objective: "测试 Shell 证据面板",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(dataDir, "tasks", "evidence-shell", "pi"),
      });
      const evidence = new EvidenceStore(dataDir, task);
      const shell = await startShellServer({
        task,
        model: "test-model",
        contextWindow: 64_000,
        store,
        // 模拟真实父子进程：写入者和 Shell 读取者不是同一个内存 Store。
        readEvidenceSnapshot: async () => await buildEvidenceSnapshot(
          new EvidenceStore(dataDir, task),
        ),
        sendPiCommand: async () => ({ ok: true }),
        onClose: async () => undefined,
      });
      const controller = new AbortController();
      try {
        const response = await fetch(shell.url.replace("/?", "/events?"), { signal: controller.signal });
        const reader = response.body?.getReader();
        assert.ok(reader);
        await evidence.capture({
          kind: "game",
          actionKey: null,
          fingerprint: "shell-game-1",
          status: "active",
          summary: "游戏状态已读取",
          artifactRef: null,
          path: null,
          startLine: null,
          lineCount: null,
          baseHash: null,
          worktreeHash: null,
          validityKey: "runtime",
          links: [],
          metadata: {},
        });
        await shell.syncEvidence();
        const decoder = new TextDecoder();
        let raw = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          raw += decoder.decode(chunk.value, { stream: true });
          if (raw.includes('"type":"evidence.snapshot"')) break;
        }
        assert.match(raw, /"type":"evidence\.snapshot"/u);
        const snapshotCount = (raw.match(/"type":"evidence\.snapshot"/gu) ?? []).length;
        assert.equal(snapshotCount, 1);
        await shell.syncEvidence();
        assert.equal((raw.match(/"type":"evidence\.snapshot"/gu) ?? []).length, 1);
        await reader.cancel();
      } finally {
        controller.abort();
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });
});
