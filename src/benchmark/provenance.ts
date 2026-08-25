/**
 * 游戏修复 Benchmark 的可比较性指纹。
 *
 * 本模块只输出非敏感模型 ID、SHA-256、版本号和相对资源清单摘要，不把 Prompt、AGENTS
 * 正文、Skill 正文、模型地址或临时绝对路径写入报告。指纹用于证明两种 Profile 使用了
 * 哪一份 fixture、项目上下文、工具面和模型配置；它不参与 Agent 判定，也不访问隐藏 Oracle。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type MaintainerConfig } from "../config.js";
import { buildDungeonMaintainerPrompt } from "../pi/prompt.js";
import { FULL_CODING_TOOLS } from "../pi/tool-policy.js";
import { defaultModelProfile } from "../settings/profiles.js";
import { hashWorktree, runGitRaw } from "../workspace/git.js";
import type { GameRepairEvalProfile } from "./agent-eval-runner.js";
import { verifyPiBaselineSource } from "./pi-baseline-source.js";

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

function benchmarkProjectRoot(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sourceOrDistRoot = resolve(directory, "..", "..");
  return sourceOrDistRoot.endsWith("dist") ? dirname(sourceOrDistRoot) : sourceOrDistRoot;
}

/** 公开报告保存的非敏感模型身份与配置指纹。 */
export interface BenchmarkModelFingerprint {
  readonly modelId: string;
  readonly modelConfigHash: string;
}

/** 公开报告保存的运行来源指纹。 */
export interface BenchmarkProvenance extends BenchmarkModelFingerprint {
  readonly benchmarkCommit: string;
  readonly benchmarkWorktreeHash: string;
  readonly piSourceRepository: string;
  readonly piSourceTag: string;
  readonly piSourceCommit: string;
  readonly piPackageName: string;
  readonly piVersion: string;
  readonly piPackageIntegrity: string;
  readonly piCliHash: string;
  readonly fixtureHash: string;
  readonly agentsHash: string;
  readonly skillManifestHash: string;
  readonly publicPromptHash: string;
  readonly promptHash: string;
  readonly toolsetHash: string;
}

/** 从运行配置提取可审计但不包含密钥或模型地址明文的模型指纹。 */
export function benchmarkModelFingerprint(config: MaintainerConfig): BenchmarkModelFingerprint {
  const model = defaultModelProfile(config);
  return {
    modelId: model.modelId,
    modelConfigHash: digest(JSON.stringify({
      modelId: model.modelId,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      baseUrl: model.baseUrl,
    })),
  };
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
export async function collectBenchmarkProvenance(input: {
  readonly repositoryRoot: string;
  readonly profile: GameRepairEvalProfile;
  readonly publicPrompt: string;
}): Promise<BenchmarkProvenance> {
  const projectRoot = benchmarkProjectRoot();
  const config = loadConfig();
  const modelFingerprint = benchmarkModelFingerprint(config);
  const context = await collectProjectContextFingerprint(input.repositoryRoot);
  const source = await verifyPiBaselineSource(projectRoot);
  const version = source.packageVersion;
  const toolset = input.profile === "pi-original"
    ? ["read", "bash", "edit", "write"]
    : [...FULL_CODING_TOOLS];
  const profileRules = input.profile === "pi-original"
    ? "pi-default-system-prompt@" + version
    : buildDungeonMaintainerPrompt();
  return {
    benchmarkCommit: (await runGitRaw(projectRoot, ["rev-parse", "HEAD"])).trim(),
    benchmarkWorktreeHash: await hashWorktree(projectRoot),
    piSourceRepository: source.repository,
    piSourceTag: source.tag,
    piSourceCommit: source.commit,
    piPackageName: source.packageName,
    piVersion: version,
    piPackageIntegrity: source.packageIntegrity,
    piCliHash: source.cliHash,
    fixtureHash: await hashWorktree(input.repositoryRoot),
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
    ...modelFingerprint,
  };
}
