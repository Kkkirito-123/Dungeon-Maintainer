import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideTokenControl, estimateInputTokens, promptTokenLimit } from "../src/agent/token-control.js";

describe("Token 请求前门禁", () => {
  it("同时预留 25% 上下文和模型最大输出", () => {
    assert.equal(promptTokenLimit(64_000, 4_096), 48_000);
    assert.equal(promptTokenLimit(32_000, 10_000), 22_000);
  });

  it("按中英文输入估算下一轮并在超过安全线时要求压缩", () => {
    assert.equal(estimateInputTokens("abcd数据库"), 4);
    assert.equal(decideTokenControl(47_999, 64_000, 4_096, "abcd").action, "allow");
    assert.equal(decideTokenControl(48_000, 64_000, 4_096, "abcd").action, "compact");
  });

  it("Pi 用量未知时不凭空阻断新会话", () => {
    const decision = decideTokenControl(null, 64_000, 4_096, "继续修复");
    assert.equal(decision.action, "allow");
    assert.equal(decision.projectedTokens, null);
  });
});
