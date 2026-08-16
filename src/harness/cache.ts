/**
 * Harness 的结果缓存与模型决策缓存。
 *
 * 结果缓存绑定适配器版本、场景和完整代码 Hash；代码变化会自然失效。决策缓存绑定
 * 稳定系统前缀、模型、工具契约和去除时间戳/usage/toolCallId 后的完整可见轨迹。
 * 命中时只重放一个经过适配器净化的环境工具调用；inspect、patch、check、finish
 * 永远不能进入缓存。磁盘只保存 Hash、动作名、有限参数和隐藏验证摘要，不保存提示词、
 * completion、思维、SQL、地图、快照或 Key。缓存损坏、过期或写入失败都退回正常模型
 * 路径，不能影响权限和任务正确性。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type JsonValue,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { redactText } from "../safety/redact.js";
import type { RuntimeModel } from "../runtime/model.js";
import type { DecisionCachePolicy, HarnessEventSink, HarnessVerdict } from "./contract.js";
import { harnessEvent } from "./events.js";

const DEFAULT_DECISION_TTL = 10 * 60_000;
const DEFAULT_RESULT_TTL = 24 * 60 * 60_000;
const DEFAULT_DECISION_LIMIT = 256;
const DEFAULT_RESULT_LIMIT = 128;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|completion|password|prompt|secret|sql|token)/iu;
const SQL_TEXT = /\b(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|ATTACH)\b/iu;

interface CachedAction {
  tool: string;
  args: Record<string, JsonValue>;
}

interface DecisionEntry {
  key: string;
  action: CachedAction;
  savedAt: number;
  expiresAt: number;
}

interface ResultEntry {
  key: string;
  verdict: HarnessVerdict;
  savedAt: number;
  expiresAt: number;
}

interface CacheFile {
  schemaVersion: 1;
  decisions: DecisionEntry[];
  results: ResultEntry[];
}

/** 缓存时钟、TTL 与容量；测试可缩短，生产使用保守固定默认值。 */
export interface HarnessCacheOptions {
  now?: () => number;
  decisionTtlMs?: number;
  resultTtlMs?: number;
  decisionLimit?: number;
  resultLimit?: number;
}

/** 决策键所需的稳定上下文。 */
export interface DecisionKeyInput {
  adapterId: string;
  adapterVersion: number;
  scenarioId: string;
  model: Model<Api>;
  context: Context;
}

/** 结果键所需的代码与场景身份。 */
export interface ResultKeyInput {
  adapterId: string;
  adapterVersion: number;
  scenarioId: string;
  codeHash: string;
}

function emptyCache(): CacheFile {
  return { schemaVersion: 1, decisions: [], results: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return `[${typeof value}]`;
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) output[key] = stableValue(item);
  }
  return output;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function content(value: unknown): JsonValue {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item): JsonValue[] => {
    if (!isRecord(item) || typeof item.type !== "string") return [];
    if (item.type === "thinking") return [];
    if (item.type === "text") return [{ type: "text", text: typeof item.text === "string" ? item.text : "" }];
    if (item.type === "image") {
      return [{ type: "image", mimeType: typeof item.mimeType === "string" ? item.mimeType : "", dataHash: digest(item.data) }];
    }
    if (item.type === "toolCall") {
      return [{ type: "toolCall", name: typeof item.name === "string" ? item.name : "", arguments: stableValue(item.arguments) }];
    }
    return [];
  });
}

function visibleContext(context: Context): JsonValue {
  const messages = context.messages.map((message) => {
    if (message.role === "user") return { role: message.role, content: content(message.content) };
    if (message.role === "assistant") return { role: message.role, content: content(message.content), stopReason: message.stopReason };
    return {
      role: message.role,
      toolName: message.toolName,
      content: content(message.content),
      isError: message.isError,
    };
  });
  const tools = (context.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: stableValue(tool.parameters),
    constrainedSampling: stableValue(tool.constrainedSampling ?? null),
  }));
  return { systemPrompt: context.systemPrompt ?? "", tools, messages };
}

/**
 * 计算忽略运行噪声但保留全部可见反馈的模型决策键。
 * @param input 适配器、场景、模型和 Pi 请求上下文。
 * @returns SHA-256；原始上下文不会写入缓存文件。
 */
export function decisionCacheKey(input: DecisionKeyInput): string {
  return digest({
    schemaVersion: 1,
    adapter: `${input.adapterId}@${String(input.adapterVersion)}`,
    scenario: input.scenarioId,
    model: { provider: input.model.provider, api: input.model.api, id: input.model.id },
    context: visibleContext(input.context),
  });
}

/** 计算代码变化即失效的场景结果键。 */
export function resultCacheKey(input: ResultKeyInput): string {
  return digest({ schemaVersion: 1, ...input });
}

function safeString(value: string, limit: number): string {
  const clean = redactText(value).replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  return SQL_TEXT.test(clean) ? "[敏感正文已省略]" : clean.slice(0, limit);
}

function safeJson(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 4) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const text = safeString(value, 160);
    return text === "[敏感正文已省略]" ? undefined : text;
  }
  if (Array.isArray(value)) {
    if (value.length > 24) return undefined;
    const items = value.map((item) => safeJson(item, depth + 1));
    return items.some((item) => item === undefined) ? undefined : items as JsonValue[];
  }
  if (!isRecord(value) || Object.keys(value).length > 24) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) return undefined;
    const safe = safeJson(item, depth + 1);
    if (safe === undefined) return undefined;
    output[key] = safe;
  }
  return output;
}

function safeVerdict(value: HarnessVerdict): HarnessVerdict {
  const metrics: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value.metrics).slice(0, 32)) {
    if (SENSITIVE_KEY.test(key)) continue;
    metrics[key] = typeof item === "string" ? safeString(item, 120) : item;
  }
  return {
    passed: value.passed,
    summary: safeString(value.summary, 600),
    metrics,
    facts: value.facts.slice(0, 16).map((item) => safeString(item, 180)),
  };
}

function validAction(value: unknown): value is CachedAction {
  return isRecord(value) && typeof value.tool === "string" && isRecord(value.args)
    && safeJson(value.args) !== undefined;
}

function validDecision(value: unknown): value is DecisionEntry {
  return isRecord(value) && typeof value.key === "string" && validAction(value.action)
    && typeof value.savedAt === "number" && typeof value.expiresAt === "number";
}

function validVerdict(value: unknown): value is HarnessVerdict {
  return isRecord(value) && typeof value.passed === "boolean" && typeof value.summary === "string"
    && isRecord(value.metrics) && Array.isArray(value.facts) && value.facts.every((item) => typeof item === "string");
}

function validResult(value: unknown): value is ResultEntry {
  return isRecord(value) && typeof value.key === "string" && validVerdict(value.verdict)
    && typeof value.savedAt === "number" && typeof value.expiresAt === "number";
}

/** 轻量原子 JSON 缓存。任何读取异常都按空缓存处理。 */
export class HarnessCache {
  readonly path: string;
  private readonly now: () => number;
  private readonly decisionTtlMs: number;
  private readonly resultTtlMs: number;
  private readonly decisionLimit: number;
  private readonly resultLimit: number;
  private value: CacheFile | null = null;
  private pending: Promise<void> = Promise.resolve();

  /** @param root 维护器自身数据目录下的缓存目录，不能来自目标仓库配置。 */
  constructor(root: string, options: HarnessCacheOptions = {}) {
    this.path = join(resolve(root), "harness-v1.json");
    this.now = options.now ?? Date.now;
    this.decisionTtlMs = options.decisionTtlMs ?? DEFAULT_DECISION_TTL;
    this.resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL;
    this.decisionLimit = options.decisionLimit ?? DEFAULT_DECISION_LIMIT;
    this.resultLimit = options.resultLimit ?? DEFAULT_RESULT_LIMIT;
  }

  /** 返回未过期的安全动作；不存在或损坏时返回 null。 */
  async decision(key: string): Promise<CachedAction | null> {
    await this.pending;
    const value = await this.load();
    const entry = value.decisions.find((item) => item.key === key && item.expiresAt > this.now());
    return entry ? { tool: entry.action.tool, args: structuredClone(entry.action.args) } : null;
  }

  /**
   * 保存一个已经通过适配器净化的环境动作。
   * @returns 参数仍含敏感字段、SQL 或超限结构时返回 false，不写磁盘。
   */
  async saveDecision(key: string, action: CachedAction): Promise<boolean> {
    const safe = safeJson(action.args);
    if (!isRecord(safe) || SENSITIVE_KEY.test(action.tool)) return false;
    return await this.mutate((value) => {
      const now = this.now();
      value.decisions = value.decisions.filter((item) => item.key !== key && item.expiresAt > now);
      value.decisions.push({ key, action: { tool: action.tool, args: safe }, savedAt: now, expiresAt: now + this.decisionTtlMs });
      value.decisions = value.decisions.sort((a, b) => a.savedAt - b.savedAt).slice(-this.decisionLimit);
      return true;
    });
  }

  /** 返回同一代码 Hash 下未过期的 PASS 断言。 */
  async result(key: string): Promise<HarnessVerdict | null> {
    await this.pending;
    const value = await this.load();
    const entry = value.results.find((item) => item.key === key && item.expiresAt > this.now());
    return entry ? safeVerdict(structuredClone(entry.verdict)) : null;
  }

  /** 保存通过的隐藏验证摘要；失败结果不缓存。 */
  async saveResult(key: string, verdict: HarnessVerdict): Promise<boolean> {
    if (!verdict.passed) return false;
    return await this.mutate((value) => {
      const now = this.now();
      value.results = value.results.filter((item) => item.key !== key && item.expiresAt > now);
      value.results.push({ key, verdict: safeVerdict(verdict), savedAt: now, expiresAt: now + this.resultTtlMs });
      value.results = value.results.sort((a, b) => a.savedAt - b.savedAt).slice(-this.resultLimit);
      return true;
    });
  }

  private async load(): Promise<CacheFile> {
    if (this.value) return this.value;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.decisions) || !Array.isArray(parsed.results)) {
        this.value = emptyCache();
      } else {
        this.value = {
          schemaVersion: 1,
          decisions: parsed.decisions.filter(validDecision),
          results: parsed.results.filter(validResult),
        };
      }
    } catch {
      this.value = emptyCache();
    }
    return this.value;
  }

  private async mutate(work: (value: CacheFile) => boolean): Promise<boolean> {
    let result = false;
    const operation = this.pending.then(async () => {
      const value = await this.load();
      result = work(value);
      if (!result) return;
      await mkdir(resolve(this.path, ".."), { recursive: true });
      const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    });
    this.pending = operation.catch(() => undefined);
    await operation;
    return result;
  }
}

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function replay(model: Model<Api>, action: CachedAction): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: `cache-${randomUUID()}`, name: action.tool, arguments: action.args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  stream.push({ type: "done", reason: "toolUse", message });
  return stream;
}

async function notify(sink: HarnessEventSink | undefined, event: Parameters<HarnessEventSink>[0]): Promise<void> {
  await Promise.resolve(sink?.(event)).catch(() => undefined);
}

function capturedStream(
  inner: AssistantMessageEventStream,
  cache: HarnessCache,
  key: string,
  policy: DecisionCachePolicy,
  sink?: HarnessEventSink,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      if (event.type === "done") {
        const calls = event.message.content.filter((item) => item.type === "toolCall");
        const call = calls.length === 1 && event.message.content.length === 1 ? calls[0] : undefined;
        const args = call && policy.tools.includes(call.name) ? policy.sanitize(call.name, call.arguments) : null;
        const stored = call && args ? await cache.saveDecision(key, { tool: call.name, args }).catch(() => false) : false;
        await notify(sink, harnessEvent({
          type: "cache", state: stored ? "store" : "skip", scope: "decision",
          message: stored ? "安全动作已缓存" : "该动作不允许缓存",
        }));
      }
      outer.push(event);
    }
    outer.end(await inner.result());
  })().catch(() => {
    const error: AssistantMessage = {
      role: "assistant", content: [], api: "openai-completions", provider: "dungeon-maintainer",
      model: "cache-forward", usage: zeroUsage(), stopReason: "error",
      errorMessage: "缓存流转发失败", timestamp: Date.now(),
    };
    outer.push({ type: "error", reason: "error", error });
  });
  return outer;
}

/** 决策缓存包装参数；适配器和场景身份必须来自维护器静态代码。 */
export interface CachedModelOptions {
  cache: HarnessCache;
  adapterId: string;
  adapterVersion: number;
  scenarioId: string;
  policy: DecisionCachePolicy;
  sink?: HarnessEventSink;
}

/**
 * 为 RuntimeModel 增加安全的单动作缓存。
 * @param source 真实或 Faux Pi 模型。
 * @param options 缓存、静态适配器策略与脱敏事件通道。
 * @returns 模型身份不变的包装器；缓存异常自动回退 source。
 */
export function cachedRuntimeModel(source: RuntimeModel, options: CachedModelOptions): RuntimeModel {
  const stream: StreamFn = async (
    model: Model<Api>,
    context: Context,
    streamOptions?: SimpleStreamOptions,
  ) => {
    const key = decisionCacheKey({
      adapterId: options.adapterId,
      adapterVersion: options.adapterVersion,
      scenarioId: options.scenarioId,
      model,
      context,
    });
    const hit = await options.cache.decision(key).catch(() => null);
    if (hit && options.policy.tools.includes(hit.tool)) {
      const safeHit = options.policy.sanitize(hit.tool, hit.args);
      if (safeHit) {
        await notify(options.sink, harnessEvent({ type: "cache", state: "hit", scope: "decision", message: "复用安全动作 / 0 TOKENS" }));
        return replay(model, { tool: hit.tool, args: safeHit });
      }
    }
    await notify(options.sink, harnessEvent({ type: "cache", state: "miss", scope: "decision", message: "调用模型生成新动作" }));
    const inner = await source.stream(model, context, streamOptions);
    return capturedStream(inner, options.cache, key, options.policy, options.sink);
  };
  return { model: source.model, stream };
}
