import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function typescriptFiles(directory: URL): Promise<URL[]> {
  const output: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) output.push(...await typescriptFiles(url));
    else if (entry.isFile() && entry.name.endsWith(".ts")) output.push(url);
  }
  return output;
}

describe("1.0 启动与 Extension 职责分区", () => {
  it("app.ts 保持轻量公开入口，启动副作用归属 src/app 专用模块", async () => {
    const appFacade = await readFile(
      new URL("../../src/app.ts", import.meta.url),
      "utf8",
    );
    const piProcess = await readFile(
      new URL("../../src/app/pi-process.ts", import.meta.url),
      "utf8",
    );
    const rpcProcess = await readFile(
      new URL("../../src/pi/rpc-process.ts", import.meta.url),
      "utf8",
    );
    const start = await readFile(
      new URL("../../src/app/start.ts", import.meta.url),
      "utf8",
    );

    assert.match(appFacade, /from "\.\/app\/pi-process\.js"/u);
    assert.match(appFacade, /from "\.\/app\/start\.js"/u);
    assert.doesNotMatch(appFacade, /node:child_process/u);
    assert.match(piProcess, /PiRpcProcess/u);
    assert.match(rpcProcess, /spawn\(/u);
    assert.match(start, /createTaskWorktree/u);
  });

  it("extension.ts 只装配会话策略和单游戏运行时", async () => {
    const extension = await readFile(
      new URL("../../src/pi/extension.ts", import.meta.url),
      "utf8",
    );
    const sessionPolicy = await readFile(
      new URL("../../src/pi/session-policy.ts", import.meta.url),
      "utf8",
    );
    const gameRuntime = await readFile(
      new URL("../../src/pi/game-runtime.ts", import.meta.url),
      "utf8",
    );
    const toolIndex = await readFile(
      new URL("../../src/pi/tools/index.ts", import.meta.url),
      "utf8",
    );

    assert.match(extension, /new DungeonGameRuntime/u);
    assert.match(extension, /registerSessionPolicyHooks/u);
    assert.doesNotMatch(extension, /startGameServer\(/u);
    assert.doesNotMatch(extension, /realpath\(/u);
    assert.doesNotMatch(extension, /task-queue|readDiagnosticEvidence|buildEvidenceCard/u);
    assert.doesNotMatch(extension, /on\("context"/u);
    assert.doesNotMatch(extension, /triggerTurn\s*:\s*true/u);
    assert.doesNotMatch(extension, /transition\(task,\s*"paused"/u);
    assert.match(toolIndex, /registerEvidenceTool/u);
    assert.match(sessionPolicy, /session_before_switch/u);
    assert.match(gameRuntime, /startGameServer\(/u);
  });

  it("领域与交互层只依赖中立能力，不反向导入 Pi Adapter", async () => {
    const layerDirectories = [
      "agent",
      "evidence",
      "game",
      "inspection",
      "logging",
      "repair",
      "settings",
      "shell",
      "task",
      "workspace",
    ];
    for (const directory of layerDirectories) {
      const files = await typescriptFiles(new URL("../../src/" + directory + "/", import.meta.url));
      for (const file of files) {
        const source = await readFile(file, "utf8");
        assert.doesNotMatch(
          source,
          /(?:from\s+|import\s*\()["'][^"']*(?:^|\/)pi\/|@earendil-works\/pi-/mu,
          "中立层不能依赖 Pi Adapter：" + file.pathname,
        );
      }
    }
  });

  it("Eval domain 不反向依赖执行、Profile、报告或 UI", async () => {
    const files = await typescriptFiles(new URL("../../src/eval/domain/", import.meta.url));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(
        source,
        /from\s+["']\.\.\/(?:execution|profiles|reporting|ui)\//u,
        "Eval domain 只能依赖领域和中立模块：" + file.pathname,
      );
    }
  });
});
