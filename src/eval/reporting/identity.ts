/**
 * 游戏修复 Eval 的可比较性指纹。
 *
 * 本模块只输出非敏感模型 ID、SHA-256、版本号和相对资源清单摘要，不把 Prompt、AGENTS
 * 正文、Skill 正文、模型地址或临时绝对路径写入报告。指纹用于证明两种 Profile 使用了
 * 哪一份 fixture、项目上下文、工具面和模型配置；它不参与 Agent 判定，也不访问隐藏 Oracle。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type MaintainerConfig } from "../../config.js";
import { buildDungeonMaintainerPrompt } from "../../pi/prompt.js";
import { FULL_CODING_TOOLS } from "../../pi/tool-policy.js";
import { hashWorktree, runGitRaw } from "../../workspace/git.js";
import type { EvalRunProfile } from "../execution/run.js";
import { verifyPiBaselineSource } from "../profiles/profile.js";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function evalProjectRoot(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sourceOrDistRoot = resolve(directory, "..", "..", "..");
  return sourceOrDistRoot.endsWith("dist") ? dirname(sourceOrDistRoot) : sourceOrDistRoot;
}

/** 公开报告保存的非敏感模型身份与配置指纹。 */
export interface EvalModelFingerprint {
  readonly modelId: string;
  readonly modelConfigHash: string;
}

/** 一次 EvalSuite 从预检到最终汇总共享的低敏运行身份。 */
export interface EvalRunIdentity extends EvalModelFingerprint {
  readonly schemaVersion: 1;
  readonly runFingerprint: string;
  readonly evalCommit: string;
  readonly evalWorktreeHash: string;
  readonly datasetFingerprint: string;
  readonly oracleVersion: string;
}

/** 公开报告保存的运行来源指纹。 */
export interface EvalResultIdentity extends EvalModelFingerprint {
  readonly runFingerprint: string;
  readonly evalCommit: string;
  readonly evalWorktreeHash: string;
  readonly datasetFingerprint: string;
  readonly oracleVersion: string;
  readonly piSourceRepository: string;
  readonly piSourceTag: string;
  readonly piSourceCommit: string;
  readonly piPackageName: string;
  readonly piVersion: string;
  readonly piPackageIntegrity: string;
  readonly piCliHash: string;
  readonly workspaceHash: string;
  readonly agentsHash: string;
  readonly skillManifestHash: string;
  readonly publicPromptHash: string;
  readonly promptHash: string;
  readonly toolsetHash: string;
}

/** 从运行配置提取可审计但不包含密钥或模型地址明文的模型指纹。 */
export function evalModelFingerprint(config: MaintainerConfig): EvalModelFingerprint {
  return {
    modelId: config.model,
    modelConfigHash: digest(JSON.stringify({
      modelId: config.model,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      reasoning: config.reasoning,
      baseUrl: config.baseUrl,
    })),
  };
}

/**
 * 从显式组成项生成稳定运行身份；任一源码、游戏合同、模型配置或 Oracle 变化都会失效。
 *
 * @param input 已经去敏的维护器、游戏、模型和 Oracle 指纹。
 * @returns 可写入预检证书、checkpoint 和汇总的同一 SHA-256 身份。
 */
export function createEvalRunIdentity(input: {
  readonly evalCommit: string;
  readonly evalWorktreeHash: string;
  readonly datasetFingerprint: string;
  readonly oracleVersion: string;
  readonly modelId: string;
  readonly modelConfigHash: string;
}): EvalRunIdentity {
  const components = {
    evalCommit: input.evalCommit,
    evalWorktreeHash: input.evalWorktreeHash,
    datasetFingerprint: input.datasetFingerprint,
    oracleVersion: input.oracleVersion,
    modelId: input.modelId,
    modelConfigHash: input.modelConfigHash,
  };
  return {
    schemaVersion: 1,
    runFingerprint: digest(JSON.stringify(components)),
    ...components,
  };
}

/** 校验运行身份是唯一现行 schema，且指纹与各组成项一致。 */
export function evalRunIdentityIsCurrent(
  value: unknown,
): value is EvalRunIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const expectedKeys = [
    "evalCommit",
    "evalWorktreeHash",
    "datasetFingerprint",
    "modelConfigHash",
    "modelId",
    "oracleVersion",
    "runFingerprint",
    "schemaVersion",
  ];
  if (Object.keys(identity).sort().join("\n") !== expectedKeys.sort().join("\n")) return false;
  if (
    identity.schemaVersion !== 1
    || typeof identity.evalCommit !== "string"
    || !/^[0-9a-f]{40}$/u.test(identity.evalCommit)
    || typeof identity.evalWorktreeHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(identity.evalWorktreeHash)
    || typeof identity.datasetFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(identity.datasetFingerprint)
    || typeof identity.modelConfigHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(identity.modelConfigHash)
    || typeof identity.modelId !== "string"
    || !identity.modelId
    || typeof identity.oracleVersion !== "string"
    || !identity.oracleVersion
    || typeof identity.runFingerprint !== "string"
  ) return false;
  return createEvalRunIdentity({
    evalCommit: identity.evalCommit,
    evalWorktreeHash: identity.evalWorktreeHash,
    datasetFingerprint: identity.datasetFingerprint,
    oracleVersion: identity.oracleVersion,
    modelId: identity.modelId,
    modelConfigHash: identity.modelConfigHash,
  }).runFingerprint === identity.runFingerprint;
}

/** 收集当前维护器、模型配置和固定 Dataset 指纹，生成 EvalSuite 运行身份。 */
export async function collectEvalRunIdentity(input: {
  readonly datasetFingerprint: string;
  readonly oracleVersion: string;
}): Promise<EvalRunIdentity> {
  const projectRoot = evalProjectRoot();
  const model = evalModelFingerprint(loadConfig());
  return createEvalRunIdentity({
    evalCommit: (await runGitRaw(projectRoot, ["rev-parse", "HEAD"])).trim(),
    evalWorktreeHash: await hashWorktree(projectRoot),
    datasetFingerprint: input.datasetFingerprint,
    oracleVersion: input.oracleVersion,
    ...model,
  });
}

/** 项目 AGENTS 与 Skill 清单的低敏指纹，供双 Profile 启动公平性测试复用。 */
export async function collectProjectContextFingerprint(repositoryRoot: string): Promise<{
  agentsHash: string;
  skillManifestHash: string;
}> {
  const root = resolve(repositoryRoot);
  const agentsPath = join(root, "AGENTS.md");
  const agentsHash = await exists(agentsPath)
    ? digest(await readFile(agentsPath))
    : digest("");
  const entries: Array<{ path: string; name: string; hash: string }> = [];
  for (const relativeRoot of [".agents/skills", ".pi/skills"]) {
    const skillsRoot = join(root, relativeRoot);
    if (!(await exists(skillsRoot))) continue;
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillPath = join(skillsRoot, entry.name, "SKILL.md");
      if (!(await exists(skillPath))) continue;
      const information = await lstat(skillPath);
      if (!information.isFile() || information.isSymbolicLink()) continue;
      entries.push({
        path: relative(root, skillPath).replaceAll("\\", "/"),
        name: entry.name,
        hash: digest(await readFile(skillPath)),
      });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { agentsHash, skillManifestHash: digest(JSON.stringify(entries)) };
}

/** 计算一次 Profile 运行所需的全部来源指纹。 */
export async function collectEvalResultIdentity(input: {
  readonly repositoryRoot: string;
  readonly profile: EvalRunProfile;
  readonly publicPrompt: string;
  readonly datasetFingerprint: string;
  readonly oracleVersion: string;
  readonly runIdentity?: EvalRunIdentity;
}): Promise<EvalResultIdentity> {
  const projectRoot = evalProjectRoot();
  const runIdentity = input.runIdentity ?? await collectEvalRunIdentity({
    datasetFingerprint: input.datasetFingerprint,
    oracleVersion: input.oracleVersion,
  });
  if (
    !evalRunIdentityIsCurrent(runIdentity)
    || runIdentity.datasetFingerprint !== input.datasetFingerprint
    || runIdentity.oracleVersion !== input.oracleVersion
  ) {
    throw new Error("Eval 运行身份与当前游戏或 Oracle 不一致");
  }
  const context = await collectProjectContextFingerprint(input.repositoryRoot);
  const source = await verifyPiBaselineSource(projectRoot);
  const version = source.packageVersion;
  const toolset = input.profile === "pi-baseline"
    ? ["read", "bash", "edit", "write"]
    : [...FULL_CODING_TOOLS];
  const profileRules = input.profile === "pi-baseline"
    ? "pi-default-system-prompt@" + version
    : buildDungeonMaintainerPrompt();
  return {
    runFingerprint: runIdentity.runFingerprint,
    evalCommit: runIdentity.evalCommit,
    evalWorktreeHash: runIdentity.evalWorktreeHash,
    datasetFingerprint: runIdentity.datasetFingerprint,
    oracleVersion: runIdentity.oracleVersion,
    piSourceRepository: source.repository,
    piSourceTag: source.tag,
    piSourceCommit: source.commit,
    piPackageName: source.packageName,
    piVersion: version,
    piPackageIntegrity: source.packageIntegrity,
    piCliHash: source.cliHash,
    workspaceHash: await hashWorktree(input.repositoryRoot),
    agentsHash: context.agentsHash,
    skillManifestHash: context.skillManifestHash,
    publicPromptHash: digest(input.publicPrompt),
    promptHash: digest(JSON.stringify({
      publicPrompt: input.publicPrompt,
      agentsHash: context.agentsHash,
      skillManifestHash: context.skillManifestHash,
      profileRules,
    })),
    toolsetHash: digest(JSON.stringify(toolset)),
    modelId: runIdentity.modelId,
    modelConfigHash: runIdentity.modelConfigHash,
  };
}
