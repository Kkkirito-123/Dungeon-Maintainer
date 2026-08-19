import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";
import {
  assertTaskSessionBinding,
  installDungeonMaintainerExtension,
} from "../src/pi/extension.js";
import { INITIAL_TASK_OBJECTIVE } from "../src/task/types.js";
import { TaskStore } from "../src/task/store.js";
import { createTemporaryGitRepository } from "./testSupport.js";

type RegisteredHandler = (...args: unknown[]) => unknown;

interface RegisteredCommand {
  description: string;
  handler(args: string, context: unknown): Promise<void>;
}

class RecordingExtensionApi {
  readonly providers = new Map<string, unknown>();
  readonly tools: string[] = [];
  readonly commands = new Map<string, RegisteredCommand>();
  readonly hooks = new Map<string, RegisteredHandler>();
  activeTools: string[] = [];
  sessionName = "";

  registerProvider(id: string, provider: unknown): void {
    this.providers.set(id, provider);
  }

  registerTool(tool: { name: string }): void {
    this.tools.push(tool.name);
  }

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  on(event: string, handler: RegisteredHandler): void {
    this.hooks.set(event, handler);
  }

  setActiveTools(tools: string[]): void {
    this.activeTools = [...tools];
  }

  setSessionName(name: string): void {
    this.sessionName = name;
  }

  async setModel(): Promise<boolean> {
    return true;
  }
}

function requireHook(
  pi: RecordingExtensionApi,
  name: string,
): RegisteredHandler {
  const hook = pi.hooks.get(name);
  assert.ok(hook, `缺少 ${name} hook`);
  return hook;
}

describe("Pi Extension 固定工具、命令和会话阻断", () => {
  it("只注册八个模型工具、五个业务命令和固定 Provider", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const dataDir = join(repository.temporaryRoot, "data");
      const store = new TaskStore(dataDir);
      const task = await store.create({
        id: "task-extension",
        objective: INITIAL_TASK_OBJECTIVE,
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("task-extension"), "pi"),
      });
      const pi = new RecordingExtensionApi();
      const config = loadConfig({
        LOCALAPPDATA: dataDir,
        MAINTAINER_API_KEY: "provider-secret",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "fixed-model",
      });
      installDungeonMaintainerExtension(pi as unknown as ExtensionAPI, {
        config,
        store,
        task,
      });

      assert.deepEqual(pi.tools, [
        "inspect",
        "patch",
        "check",
        "finish",
        "look",
        "go",
        "use",
        "query",
      ]);
      for (const command of ["play", "diff", "verify", "apply", "discard"]) {
        assert.ok(pi.commands.has(command));
      }
      assert.deepEqual([...pi.commands.keys()], [
        "play",
        "diff",
        "verify",
        "apply",
        "discard",
      ]);
      const provider = pi.providers.get("dungeon-maintainer") as {
        apiKey?: string;
        models?: Array<{ id?: string }>;
      };
      assert.equal(provider.apiKey, "$MAINTAINER_API_KEY");
      assert.equal(provider.models?.[0]?.id, "fixed-model");
      assert.ok(!JSON.stringify(provider).includes("provider-secret"));

      const promptResult = await requireHook(pi, "before_agent_start")() as {
        systemPrompt: string;
      };
      assert.deepEqual(pi.activeTools, pi.tools);
      assert.match(promptResult.systemPrompt, /detached worktree/u);
      assert.match(promptResult.systemPrompt, /SQL Dungeon/u);

      const notifications: string[] = [];
      const switchResult = await requireHook(pi, "session_before_switch")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { cancel: boolean };
      assert.deepEqual(switchResult, { cancel: true });
      const forkResult = await requireHook(pi, "session_before_fork")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { cancel: boolean };
      assert.deepEqual(forkResult, { cancel: true });
      const treeResult = await requireHook(pi, "session_before_tree")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { cancel: boolean };
      assert.deepEqual(treeResult, { cancel: true });
      const bashResult = await requireHook(pi, "user_bash")(
        {},
        { ui: { notify: (message: string) => notifications.push(message) } },
      ) as { result: { exitCode: number; output: string } };
      assert.equal(bashResult.result.exitCode, 1);
      assert.match(bashResult.result.output, /禁止/u);

      await requireHook(pi, "input")({
        source: "interactive",
        text: "修复首层问题 api_key=abcdefghijklmnop",
      });
      assert.notEqual(task.objective, INITIAL_TASK_OBJECTIVE);
      assert.ok(!task.objective.includes("abcdefghijklmnop"));
    } finally {
      await repository.dispose();
    }
  });
});

describe("Pi session-id、session-dir 与 worktree 固定绑定", () => {
  it("匹配时通过，任一 ID 漂移时拒绝", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const piSessionDir = join(repository.temporaryRoot, "task", "pi");
      const sessionFile = join(piSessionDir, "session_task-binding.jsonl");
      await mkdir(piSessionDir, { recursive: true });
      await writeFile(sessionFile, "{}\n", "utf8");
      const store = new TaskStore(join(repository.temporaryRoot, "data"));
      const task = await store.create({
        id: "task-binding",
        objective: "验证绑定",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir,
      });
      const sessionManager = {
        getSessionDir: () => piSessionDir,
        getCwd: () => repository.repoRoot,
        getSessionId: () => task.id,
        getSessionFile: () => sessionFile,
      };
      const context = {
        cwd: repository.repoRoot,
        sessionManager,
      } as unknown as ExtensionContext;

      await assertTaskSessionBinding(context, task);
      const driftedContext = {
        cwd: repository.repoRoot,
        sessionManager: {
          ...sessionManager,
          getSessionId: () => "other-task",
        },
      } as unknown as ExtensionContext;
      await assert.rejects(
        assertTaskSessionBinding(driftedContext, task),
        /session-id/u,
      );
    } finally {
      await repository.dispose();
    }
  });
});
