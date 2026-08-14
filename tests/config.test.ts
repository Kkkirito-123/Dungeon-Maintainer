/** 配置测试只使用注入环境，确保不会读取开发者真实密钥。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, normalizeBaseUrl, requireApiKey } from "../src/runtime/config.js";

void test("完整 chat-completions 地址会归一化为 API 根地址", () => {
  assert.equal(
    normalizeBaseUrl("https://example.test/v1/chat/completions"),
    "https://example.test/v1",
  );
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1");
});

void test("维护器只读取独立环境变量并限制上下文范围", () => {
  const config = loadConfig({
    LOCALAPPDATA: "C:\\task-data",
    MAIN_API_KEY: "game-secret",
    MAINTAINER_API_KEY: "maintainer-secret",
    MAINTAINER_BASE_URL: "https://example.test/v1/chat/completions",
    MAINTAINER_MODEL: "test-model",
    MAINTAINER_CONTEXT_WINDOW: "12000",
  });
  assert.equal(config.apiKey, "maintainer-secret");
  assert.equal(config.model, "test-model");
  assert.equal(config.contextWindow, 12_000);
  assert.match(config.dataDir, /dungeon-maintainer$/);
});

void test("缺少维护器密钥时在模型调用边界明确阻断", () => {
  const config = loadConfig({ LOCALAPPDATA: "C:\\task-data" });
  assert.throws(() => requireApiKey(config), /BLOCKED_ENV/);
});
