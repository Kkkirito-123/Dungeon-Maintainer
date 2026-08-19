import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("V1 启动与 Extension 职责分区", () => {
  it("app.ts 保持兼容门面，启动副作用归属 src/app 专用模块", async () => {
    const appFacade = await readFile(
      new URL("../../src/app.ts", import.meta.url),
      "utf8",
    );
    const piProcess = await readFile(
      new URL("../../src/app/pi-process.ts", import.meta.url),
      "utf8",
    );
    const start = await readFile(
      new URL("../../src/app/start.ts", import.meta.url),
      "utf8",
    );

    assert.match(appFacade, /from "\.\/app\/pi-process\.js"/u);
    assert.match(appFacade, /from "\.\/app\/start\.js"/u);
    assert.doesNotMatch(appFacade, /node:child_process/u);
    assert.match(piProcess, /spawn\(/u);
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

    assert.match(extension, /new DungeonGameRuntime/u);
    assert.match(extension, /registerSessionPolicyHooks/u);
    assert.doesNotMatch(extension, /startGameServer\(/u);
    assert.doesNotMatch(extension, /realpath\(/u);
    assert.match(sessionPolicy, /session_before_switch/u);
    assert.match(gameRuntime, /startGameServer\(/u);
  });
});
