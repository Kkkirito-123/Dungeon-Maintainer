import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promptTokenLimit } from "../src/shell/protocol.js";

describe("Token 状态展示", () => {
  it("默认展示上下文窗口的 75% 安全线", () => {
    assert.equal(promptTokenLimit(64_000, 4_096), 48_000);
  });

  it("输出预算更大时为回答保留空间", () => {
    assert.equal(promptTokenLimit(32_000, 10_000), 22_000);
  });

  it("安全线不会小于零，也不用于提交前阻断", () => {
    assert.equal(promptTokenLimit(4_096, 4_096), 0);
  });
});
