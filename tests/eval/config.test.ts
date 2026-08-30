import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEvalConfig } from "../../src/eval/config.js";

describe("Eval 模型配置", () => {
  it("默认使用 Flash，并允许显式选择 Pro", () => {
    const base = { MAINTAINER_BASE_URL: "https://api.deepseek.com/v1" };

    assert.equal(loadEvalConfig(base).model, "deepseek-v4-flash");
    assert.equal(loadEvalConfig({
      ...base,
      DUNGEON_EVAL_MODEL: " deepseek-v4-pro ",
    }).model, "deepseek-v4-pro");
  });
});
