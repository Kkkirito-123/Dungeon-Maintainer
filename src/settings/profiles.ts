/**
 * OpenAI-compatible 模型档案的本地非敏感持久化。
 *
 * 本模块只保存名称、地址、模型 ID、上下文、输出上限和推理支持；API Key 永远交给
 * Windows 凭据管理器或开发环境变量。profiles.json 使用原子替换，不读取游戏仓库，
 * 也不动态修改正在运行的 Pi Provider。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MaintainerConfig } from "../config.js";
import { normalizeBaseUrl } from "../config.js";

/** 1.0 支持的 OpenAI-compatible 模型档案。 */
export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
}

interface ProfileDocument {
  schemaVersion: 1;
  profiles: ModelProfile[];
}

const MODEL_PROFILE_KEYS = [
  "id",
  "name",
  "baseUrl",
  "modelId",
  "contextWindow",
  "maxOutputTokens",
  "reasoning",
] as const;

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + " 超出允许范围");
  }
  return value;
}

/** 校验并规范化一个模型档案。 */
export function normalizeModelProfile(value: unknown): ModelProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型档案必须是 JSON 对象");
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, MODEL_PROFILE_KEYS)) {
    throw new Error("模型档案字段不是当前格式");
  }
  const id = typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(id)) {
    throw new Error("模型档案 ID 只允许 1 到 32 位小写字母、数字、下划线和连字符");
  }
  if (!name || name.length > 80 || !modelId || modelId.length > 160) {
    throw new Error("模型档案名称或模型 ID 无效");
  }
  if (typeof record.reasoning !== "boolean") {
    throw new Error("模型档案 reasoning 必须是布尔值");
  }
  return {
    id,
    name,
    baseUrl: normalizeBaseUrl(baseUrl),
    modelId,
    contextWindow: boundedInteger(record.contextWindow, "上下文窗口", 8_000, 2_000_000),
    maxOutputTokens: boundedInteger(record.maxOutputTokens, "输出上限", 256, 64_000),
    reasoning: record.reasoning,
  };
}

function validateProfiles(value: unknown, requireDefault: boolean): ModelProfile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("模型档案列表必须是非空数组");
  }
  const profiles = value.map(normalizeModelProfile);
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) throw new Error("模型档案 ID 不能重复");
  if (requireDefault && !ids.has("default")) {
    throw new Error("模型档案文档缺少 default");
  }
  return profiles;
}

/** 从开发环境配置生成始终可用的默认档案。 */
export function defaultModelProfile(config: MaintainerConfig): ModelProfile {
  return {
    id: "default",
    name: config.model,
    baseUrl: config.baseUrl,
    modelId: config.model,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    reasoning: config.reasoning,
  };
}

/** Pi Provider 使用的稳定 ID；默认档案使用产品基础 ID。 */
export function profileProviderId(profileId: string): string {
  return profileId === "default"
    ? "dungeon-maintainer"
    : "dungeon-maintainer-" + profileId;
}

/** Pi 子进程中保存单个档案密钥的环境变量名。 */
export function profileKeyEnvironmentName(profileId: string): string {
  return "DUNGEON_MAINTAINER_PROFILE_KEY_"
    + profileId.replace(/[^a-z0-9]/giu, "_").toUpperCase();
}

/** profiles.json 的原子读写入口。 */
export class ModelProfileStore {
  private readonly path: string;

  /**
   * @param dataDir 维护器专用数据目录。
   * @param fallback 没有配置文件时使用的开发环境默认档案。
   */
  constructor(
    dataDir: string,
    private readonly fallback: ModelProfile,
  ) {
    this.path = join(dataDir, "settings", "profiles.json");
  }

  /** 读取全部档案；损坏文档会明确失败，不静默覆盖。 */
  async list(): Promise<ModelProfile[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [this.fallback];
      throw error;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("模型档案文档无效");
    }
    const document = raw as Record<string, unknown>;
    if (
      !hasExactKeys(document, ["schemaVersion", "profiles"])
      || document.schemaVersion !== 1
    ) {
      throw new Error("模型档案 schemaVersion 无效");
    }
    return validateProfiles(document.profiles, true);
  }

  /** 新增或替换单个非敏感档案并原子保存。 */
  async save(value: unknown): Promise<ModelProfile> {
    const profile = normalizeModelProfile(value);
    const profiles = await this.list();
    const index = profiles.findIndex((entry) => entry.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    const document: ProfileDocument = {
      schemaVersion: 1,
      profiles: profiles.sort((left, right) => left.id.localeCompare(right.id)),
    };
    const directory = join(this.path, "..");
    await mkdir(directory, { recursive: true });
    const temporary = this.path + "." + String(process.pid) + ".tmp";
    await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", "utf8");
    await rename(temporary, this.path);
    return profile;
  }
}

/** 从父进程传入的非敏感 JSON 解析 Extension 应注册的档案。 */
export function profilesFromEnvironment(
  environment: NodeJS.ProcessEnv,
  fallback: ModelProfile,
): ModelProfile[] {
  const text = environment.DUNGEON_MAINTAINER_MODEL_PROFILES?.trim();
  if (!text) return [fallback];
  const value: unknown = JSON.parse(text);
  return validateProfiles(value, false);
}
