import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { startShellServer } from "../src/shell/server.js";
import { TaskStore } from "../src/task/store.js";
import { INITIAL_TASK_OBJECTIVE } from "../src/task/types.js";
import { createTemporaryGitRepository } from "./testSupport.js";

describe("统一 Chromium Shell HTTP/SSE 边界", () => {
  it("页面单独由 shell 文件夹提供，状态和令牌校验不泄漏敏感配置", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "shell-secret",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "fixed-model",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "shell-task",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("shell-task"), "pi"),
      });
      const commands: Array<Record<string, unknown>> = [];
      const shell = await startShellServer({
        task,
        model: config.model,
        contextWindow: config.contextWindow,
        store,
        sendPiCommand: async (command) => {
          commands.push(command);
          return { ok: true };
        },
        onClose: async () => undefined,
      });
      try {
        const pageResponse = await fetch(shell.url);
        const page = await pageResponse.text();
        assert.equal(pageResponse.status, 200);
        assert.match(page, /id="game-frame"/u);
        assert.match(page, /id="status-bar"/u);
        assert.doesNotMatch(page, /shell-secret/u);

        const stateResponse = await fetch(shell.url.replace("/?", "/api/state?"));
        assert.equal(stateResponse.status, 200);
        const state = await stateResponse.json() as { status: { taskState: string } };
        assert.equal(state.status.taskState, "created");

        const badState = await fetch(
          shell.url.replace("/?", "/api/state?").replace("token=", "token=bad-"),
        );
        assert.equal(badState.status, 403);

        const inputResponse = await fetch(shell.url.replace("/?", "/api/input?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "定位问题" }),
        });
        assert.equal(inputResponse.status, 200);
        const firstCommand = commands[0];
        assert.ok(firstCommand);
        assert.equal(firstCommand.type, "prompt");
        assert.equal(firstCommand.message, "定位问题");

        const commandResponse = await fetch(shell.url.replace("/?", "/api/command?"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "/bad" }),
        });
        assert.equal(commandResponse.status, 400);

        const runtimeUrl = new URL("/api/runtime", shell.url);
        runtimeUrl.search = new URL(shell.url).search;
        const runtimeResponse = await fetch(runtimeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dungeon-token": shell.token,
          },
          body: JSON.stringify({
            state: "ready",
            gameUrl: "http://127.0.0.1:4173/?playtest=agent",
          }),
        });
        assert.equal(runtimeResponse.status, 200);
      } finally {
        await shell.close();
      }
    } finally {
      await repository.dispose();
    }
  });
});
