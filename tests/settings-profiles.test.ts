import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AppController } from "../src/app/pi-process.js";
import { loadConfig } from "../src/config.js";
import { readProfileCredential } from "../src/settings/credential.js";
import {
  defaultModelProfile,
  type ModelProfile,
  ModelProfileStore,
  profileKeyEnvironmentName,
  profileProviderId,
} from "../src/settings/profiles.js";
import { TaskStore } from "../src/task/store.js";
import type { TaskRecord } from "../src/task/types.js";
import { createTemporaryGitRepository } from "./testSupport.js";

interface TestableAppController {
  activeTask: TaskRecord;
  profileStore: ModelProfileStore;
  profiles: ModelProfile[];
  profileKeys: Map<string, string>;
  rpc: object | null;
  reloadProfiles(): Promise<void>;
  startActivePi(): Promise<void>;
  stopActivePi(): Promise<void>;
  saveModelProfile(
    value: unknown,
    apiKey: string | null,
    activate: boolean,
  ): Promise<ModelProfile & {
    hasCredential: boolean;
    active: boolean;
    restarted: boolean;
  }>;
}

async function createControllerHarness(
  task: TaskRecord,
  config: ReturnType<typeof loadConfig>,
  credentialProfileIds: ReadonlySet<string> = new Set(["default"]),
): Promise<{
  controller: TestableAppController;
  failNextStart(): void;
  startCalls(): number;
  stopCalls(): number;
  activePi(): object | null;
}> {
  const controller = new AppController(task, config) as unknown as TestableAppController;
  const fakePi = {};
  let startCalls = 0;
  let stopCalls = 0;
  let failedStarts = 0;
  controller.reloadProfiles = async () => {
    controller.profiles = await controller.profileStore.list();
    controller.profileKeys.clear();
    for (const profile of controller.profiles) {
      if (credentialProfileIds.has(profile.id)) {
        controller.profileKeys.set(profile.id, "test-only-key");
      }
    }
  };
  controller.stopActivePi = async () => {
    stopCalls += 1;
    controller.rpc = null;
  };
  controller.startActivePi = async () => {
    startCalls += 1;
    if (failedStarts > 0) {
      failedStarts -= 1;
      throw new Error("模拟新 Pi 启动失败");
    }
    controller.rpc = fakePi;
  };
  await controller.reloadProfiles();
  controller.rpc = fakePi;
  return {
    controller,
    failNextStart: () => {
      failedStarts += 1;
    },
    startCalls: () => startCalls,
    stopCalls: () => stopCalls,
    activePi: () => controller.rpc,
  };
}

describe("OpenAI-compatible 模型档案与凭据边界", () => {
  it("profiles.json 只保存非敏感字段并保留默认档案", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "secret-from-environment",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "model-a",
        MAINTAINER_REASONING: "true",
      });
      const store = new ModelProfileStore(
        config.dataDir,
        defaultModelProfile(config),
      );
      assert.equal((await store.list())[0]?.id, "default");

      const saved = await store.save({
        id: "fast",
        name: "Fast Model",
        baseUrl: "https://gateway.example/v1/chat/completions",
        modelId: "model-fast",
        contextWindow: 128_000,
        maxOutputTokens: 8_000,
        reasoning: false,
        apiKey: "must-not-persist",
      });

      assert.equal(saved.baseUrl, "https://gateway.example/v1");
      assert.equal(profileProviderId(saved.id), "dungeon-maintainer-fast");
      assert.equal(
        profileKeyEnvironmentName(saved.id),
        "DUNGEON_MAINTAINER_PROFILE_KEY_FAST",
      );
      const raw = await readFile(
        join(config.dataDir, "settings", "profiles.json"),
        "utf8",
      );
      assert.ok(!raw.includes("must-not-persist"));
      assert.ok(!raw.includes("secret-from-environment"));
      assert.deepEqual(
        (await store.list()).map((profile) => profile.id),
        ["default", "fast"],
      );
    } finally {
      await repository.dispose();
    }
  });

  it("开发环境变量可以提供档案 Key 而不访问凭据管理器", async () => {
    const key = await readProfileCredential("fast", {
      DUNGEON_MAINTAINER_PROFILE_KEY_FAST: "environment-profile-secret",
    });
    assert.equal(key, "environment-profile-secret");
  });

  it("保存非活动档案不会重启当前唯一 Pi", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "default-test-key",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "model-a",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "profile-save-inactive",
        objective: "test",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("profile-save-inactive"), "pi"),
      });
      const harness = await createControllerHarness(task, config);
      const before = harness.activePi();

      const result = await harness.controller.saveModelProfile({
        id: "fast",
        name: "Fast Model",
        baseUrl: "https://fast.example/v1",
        modelId: "model-fast",
        contextWindow: 32_000,
        maxOutputTokens: 2_048,
        reasoning: false,
      }, null, false);

      assert.equal(result.restarted, false);
      assert.equal(result.active, false);
      assert.equal(harness.stopCalls(), 0);
      assert.equal(harness.startCalls(), 0);
      assert.equal(harness.activePi(), before);
    } finally {
      await repository.dispose();
    }
  });

  it("启用缺少 Key 的档案时保留旧 Pi 和旧任务模型", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "default-test-key",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "model-a",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "profile-missing-key",
        objective: "test",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("profile-missing-key"), "pi"),
      });
      const harness = await createControllerHarness(task, config);
      const before = harness.activePi();

      await assert.rejects(
        harness.controller.saveModelProfile({
          id: "private",
          name: "Private Model",
          baseUrl: "https://private.example/v1",
          modelId: "model-private",
          contextWindow: 32_000,
          maxOutputTokens: 2_048,
          reasoning: true,
        }, null, true),
        /缺少 API Key，旧 Pi 保持运行/u,
      );

      assert.equal(harness.stopCalls(), 0);
      assert.equal(harness.startCalls(), 0);
      assert.equal(harness.activePi(), before);
      assert.equal((await store.read(task.id)).modelProfileId, "default");
    } finally {
      await repository.dispose();
    }
  });

  it("更新活动档案时只重启一次并返回 restarted", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "default-test-key",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "model-a",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "profile-restart-active",
        objective: "test",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("profile-restart-active"), "pi"),
      });
      const harness = await createControllerHarness(task, config);

      const result = await harness.controller.saveModelProfile({
        ...defaultModelProfile(config),
        name: "Updated Default",
        modelId: "model-a-v2",
      }, null, false);

      assert.equal(result.restarted, true);
      assert.equal(result.active, true);
      assert.equal(harness.stopCalls(), 1);
      assert.equal(harness.startCalls(), 1);
      assert.ok(harness.activePi());
    } finally {
      await repository.dispose();
    }
  });

  it("切换模型启动失败后恢复旧任务与旧 Pi", async () => {
    const repository = await createTemporaryGitRepository({ "README.md": "test\n" });
    try {
      const config = loadConfig({
        LOCALAPPDATA: join(repository.temporaryRoot, "data"),
        MAINTAINER_API_KEY: "default-test-key",
        MAINTAINER_BASE_URL: "https://api.example/v1",
        MAINTAINER_MODEL: "model-a",
      });
      const store = new TaskStore(config.dataDir);
      const task = await store.create({
        id: "profile-recover-pi",
        objective: "test",
        repoRoot: repository.repoRoot,
        baseHead: repository.baseHead,
        worktreeRoot: repository.repoRoot,
        piSessionDir: join(store.taskDir("profile-recover-pi"), "pi"),
      });
      const harness = await createControllerHarness(
        task,
        config,
        new Set(["default", "fast"]),
      );
      harness.failNextStart();

      await assert.rejects(
        harness.controller.saveModelProfile({
          id: "fast",
          name: "Fast Model",
          baseUrl: "https://fast.example/v1",
          modelId: "model-fast",
          contextWindow: 32_000,
          maxOutputTokens: 2_048,
          reasoning: false,
        }, null, true),
        /模拟新 Pi 启动失败/u,
      );

      assert.equal(harness.stopCalls(), 1);
      assert.equal(harness.startCalls(), 2);
      assert.ok(harness.activePi());
      assert.equal(harness.controller.activeTask.modelProfileId, "default");
      assert.equal((await store.read(task.id)).modelProfileId, "default");
    } finally {
      await repository.dispose();
    }
  });
});
