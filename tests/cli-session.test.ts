import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPiArguments,
  inspectDungeonRepository,
  resolvePiCliPath,
  verifyPiSession,
} from "../src/app.js";
import {
  loadConfig,
  normalizeBaseUrl,
  parseMaintainerEnv,
} from "../src/config.js";
import { parseMaintainerCli } from "../src/main.js";
import { FULL_CODING_TOOLS } from "../src/pi/tool-policy.js";
import { createTaskRecordFixture, createTemporaryGitRepository } from "./testSupport.js";

describe("外部 CLI 与固定 Pi 启动参数", () => {
  it("只接受 start、resume 和 help 三种入口", () => {
    assert.deepEqual(parseMaintainerCli([]), { action: "help" });
    assert.deepEqual(
      parseMaintainerCli(["start", "--repo", "C:/game"]),
      { action: "start", repo: "C:/game" },
    );
    assert.deepEqual(
      parseMaintainerCli(["resume", "task-1"]),
      { action: "resume", taskId: "task-1" },
    );
    assert.throws(
      () => parseMaintainerCli(["start", "C:/game"]),
      /start 用法/u,
    );
    assert.throws(
      () => parseMaintainerCli(["shell"]),
      /未知命令/u,
    );
  });

  it("Pi 参数加载完整 Coding 工具并固定 Extension、模型和任务会话", () => {
    const task = createTaskRecordFixture({ id: "task-123" });
    const config = loadConfig({
      LOCALAPPDATA: "C:/maintainer-data",
      MAINTAINER_API_KEY: "secret-not-in-arguments",
      MAINTAINER_BASE_URL: "https://api.example/v1/chat/completions",
      MAINTAINER_MODEL: "fixed-model",
    });
    const args = buildPiArguments(task, config, "C:/maintainer/extension.js");
    const joined = args.join(" ");

    assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
    for (const flag of [
      "--approve",
      "--no-extensions",
      "--no-prompt-templates",
    ]) assert.ok(args.includes(flag));
    // 项目级 AGENTS.md 与 .agents/skills 必须由 Pi 正常加载，才能让原版和维护器
    // 使用相同项目上下文；全局 Extension 仍由启动参数明确关闭。
    assert.ok(!args.includes("--no-skills"));
    assert.ok(!args.includes("--no-context-files"));
    const toolsIndex = args.indexOf("--tools");
    assert.ok(toolsIndex >= 0);
    assert.equal(args[toolsIndex + 1], FULL_CODING_TOOLS.join(","));
    const thinkingIndex = args.indexOf("--thinking");
    assert.ok(thinkingIndex >= 0);
    assert.equal(args[thinkingIndex + 1], task.thinkingLevel);
    assert.ok(!args.includes("--no-builtin-tools"));
    assert.deepEqual(args.slice(-4), [
      "--session-id",
      "task-123",
      "--session-dir",
      task.piSessionDir,
    ]);
    assert.ok(joined.includes("dungeon-maintainer"));
    assert.ok(joined.includes("fixed-model"));
    assert.ok(!joined.includes("secret-not-in-arguments"));
  });

  it("Pi CLI 入口解析到项目内固定依赖而不是全局命令", async () => {
    const path = resolvePiCliPath();

    assert.match(
      path.replaceAll("\\", "/"),
      /node_modules\/@earendil-works\/pi-coding-agent\/dist\/cli\.js$/u,
    );
    await access(path);
  });

  it("配置只读取 MAINTAINER_* 并规范化兼容接口地址", () => {
    assert.deepEqual(parseMaintainerEnv([
      "MAINTAINER_MODEL=deepseek-chat",
      "IGNORED_SECRET=do-not-read",
      "export MAINTAINER_MAX_TOKENS='2048'",
    ].join("\n")), {
      MAINTAINER_MODEL: "deepseek-chat",
      MAINTAINER_MAX_TOKENS: "2048",
    });
    assert.equal(
      normalizeBaseUrl("https://api.example/v1/chat/completions"),
      "https://api.example/v1",
    );
    assert.throws(() => normalizeBaseUrl("file:///tmp/key"), /HTTP\(S\)/u);
  });

  it("目标仓库允许本地修改，但项目标识只能声明固定版本和适配器", async () => {
    const repository = await createTemporaryGitRepository({
      ".maintainer/project.json": JSON.stringify({
        schemaVersion: 1,
        adapter: "sql-dungeon",
      }) + "\n",
      "game/package.json": "{}\n",
    });
    try {
      const state = await inspectDungeonRepository(repository.repoRoot);
      assert.equal(state.root, repository.repoRoot);
      await writeFile(join(repository.repoRoot, "game", "package.json"), "{\"dirty\":true}\n", "utf8");
      const dirtyState = await inspectDungeonRepository(repository.repoRoot);
      assert.equal(dirtyState.clean, false);
      await writeFile(join(repository.repoRoot, ".maintainer", "project.json"), JSON.stringify({
        schemaVersion: 1,
        adapter: "sql-dungeon",
        command: "untrusted",
      }), "utf8");
      await assert.rejects(
        inspectDungeonRepository(repository.repoRoot),
        /只允许 schemaVersion=1/u,
      );
    } finally {
      await repository.dispose();
    }
  });
});

describe("Pi 会话恢复绑定", () => {
  it("只接受唯一且首行 ID/cwd 与任务一致的会话文件", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const worktreeRoot = join(repository.temporaryRoot, "worktree");
      const piSessionDir = join(repository.temporaryRoot, "tasks", "task-1", "pi");
      await mkdir(worktreeRoot, { recursive: true });
      await mkdir(piSessionDir, { recursive: true });
      const task = createTaskRecordFixture({
        id: "task-1",
        worktreeRoot,
        piSessionDir,
      });
      const sessionPath = join(piSessionDir, "2026-01-01_task-1.jsonl");
      await writeFile(sessionPath, JSON.stringify({
        type: "session",
        id: task.id,
        cwd: task.worktreeRoot,
      }) + "\n", "utf8");

      assert.equal(await verifyPiSession(task), sessionPath);
      await writeFile(join(piSessionDir, "duplicate_task-1.jsonl"), JSON.stringify({
        type: "session",
        id: task.id,
        cwd: task.worktreeRoot,
      }) + "\n", "utf8");
      await assert.rejects(verifyPiSession(task), /重复/u);
    } finally {
      await repository.dispose();
    }
  });
});
