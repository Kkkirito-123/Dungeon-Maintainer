import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MaintainerConfig } from "../../src/config.js";
import { EVAL_MODEL_ID } from "../../src/eval/config.js";
import {
  parseEvalJudgeVerdict,
  runEvalJudge,
} from "../../src/eval/execution/llm-judge.js";

const apiKey = "judge-test-secret";
const config: MaintainerConfig = {
  apiKey,
  baseUrl: "https://judge.invalid/v1",
  model: "ignored-model",
  contextWindow: 64_000,
  maxOutputTokens: 4_096,
  reasoning: true,
  dataDir: "unused",
};
const judgeInput = {
  publicTask: "恢复正常功能",
  sourcePatch: "故障补丁",
  candidateDiff: "候选修复",
};

function judgeResponse(content: string): Response {
  return Response.json({
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  });
}

describe("Eval Flash LLM Judge", () => {
  it("只接受字段和组合都严格匹配的 JSON", () => {
    assert.deepEqual(
      parseEvalJudgeVerdict({ verdict: "passed", reasonCode: "function-restored" }),
      { verdict: "passed", reasonCode: "function-restored" },
    );
    assert.throws(
      () => parseEvalJudgeVerdict({
        verdict: "passed",
        reasonCode: "function-restored",
        explanation: "不应返回",
      }),
      /llm-judge-response-invalid/u,
    );
    assert.throws(
      () => parseEvalJudgeVerdict({ verdict: "passed", reasonCode: "obvious-regression" }),
      /llm-judge-response-invalid/u,
    );
  });

  it("单次调用固定 Flash 和 128 输出 Token，返回结果不包含 Key", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      requests.push({
        url: typeof input === "string"
          ? input
          : input instanceof URL ? input.href : input.url,
        init: init ?? {},
      });
      return judgeResponse(JSON.stringify({
        verdict: "passed",
        reasonCode: "function-restored",
      }));
    };

    const result = await runEvalJudge(judgeInput, { config, request });

    assert.equal(requests.length, 1);
    const firstRequest = requests[0];
    assert.ok(firstRequest);
    assert.equal(firstRequest.url, "https://judge.invalid/v1/chat/completions");
    const encodedBody = firstRequest.init.body;
    if (typeof encodedBody !== "string") assert.fail("Judge 请求体必须是 JSON 文本");
    const body = JSON.parse(encodedBody) as Record<string, unknown>;
    assert.equal(EVAL_MODEL_ID, "deepseek-v4-flash");
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.max_tokens, 128);
    assert.deepEqual(
      {
        verdict: result.verdict,
        reasonCode: result.reasonCode,
        modelId: result.modelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
      },
      {
        verdict: "passed",
        reasonCode: "function-restored",
        modelId: "deepseek-v4-flash",
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
    );
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  });

  it("HTTP 429 直接失败且不重试", async () => {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls += 1;
      return new Response("rate limited", { status: 429 });
    };

    await assert.rejects(
      runEvalJudge(judgeInput, { config, request }),
      /llm-judge-http-429/u,
    );
    assert.equal(calls, 1);
  });

  it("拒绝模型正文中的非严格 JSON", async () => {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls += 1;
      return judgeResponse("```json\n{\"verdict\":\"passed\",\"reasonCode\":\"function-restored\"}\n```");
    };

    await assert.rejects(
      runEvalJudge(judgeInput, { config, request }),
      /llm-judge-response-invalid/u,
    );
    assert.equal(calls, 1);
  });

  it("畸形顶层 JSON 和缺失 usage 都作为基础设施响应错误", async () => {
    await assert.rejects(
      runEvalJudge(judgeInput, {
        config,
        request: async () => new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
      }),
      /llm-judge-response-invalid/u,
    );
    await assert.rejects(
      runEvalJudge(judgeInput, {
        config,
        request: async () => Response.json({
          choices: [{ message: { content: JSON.stringify({
            verdict: "passed",
            reasonCode: "function-restored",
          }) } }],
        }),
      }),
      /llm-judge-usage-invalid/u,
    );
  });
});
