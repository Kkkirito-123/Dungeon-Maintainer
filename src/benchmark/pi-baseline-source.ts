/**
 * Benchmark 使用的官方 Pi 基线来源校验。
 *
 * GitHub Tag/Commit 用来说明上游源码身份；真正执行的是项目锁定的 npm
 * 包，因此还必须同时校验已安装包版本、仓库元数据和 pnpm lockfile integrity。
 * 本模块不访问网络，也不从可变的 main 分支下载代码。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolvePiCliPath } from "../app/pi-process.js";

/** 经 GitHub Tag 与 npm registry `gitHead` 双重确认的固定上游。 */
export const PI_BASELINE_SOURCE = {
  repository: "https://github.com/earendil-works/pi",
  tag: "v0.84.2",
  commit: "914cf1472e715297caa30db4b9535d534a9eb718",
  packageName: "@earendil-works/pi-coding-agent",
  packageVersion: "0.84.2",
  packageIntegrity: "sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==",
} as const;

const EXPECTED_PI_PACKAGES = {
  "@earendil-works/pi-agent-core": "0.84.2",
  "@earendil-works/pi-ai": "0.84.2",
  "@earendil-works/pi-coding-agent": "0.84.2",
} as const;

interface PackageMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly repository?: unknown;
}

/** 写入 Benchmark 报告的 Pi 执行来源，不包含本地绝对路径。 */
export interface PiBaselineSourceFingerprint {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageIntegrity: string;
  readonly cliHash: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeRepositoryUrl(value: string): string {
  return value
    .replace(/^git\+/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertProjectDependencyVersions(packageJson: unknown): void {
  const dependencies = record(record(packageJson)?.dependencies);
  if (!dependencies) throw new Error("Pi baseline 校验失败：项目 dependencies 缺失");
  for (const [name, version] of Object.entries(EXPECTED_PI_PACKAGES)) {
    if (dependencies[name] !== version) {
      throw new Error("Pi baseline 校验失败：" + name + " 未精确锁定为 " + version);
    }
  }
}

function assertLockfileIntegrity(lockfile: string): void {
  const packageKey = escapeRegExp(
    "'" + PI_BASELINE_SOURCE.packageName + "@" + PI_BASELINE_SOURCE.packageVersion + "':",
  );
  const integrity = escapeRegExp(PI_BASELINE_SOURCE.packageIntegrity);
  const packageBlock = new RegExp(
    "^  " + packageKey + "[\\s\\S]*?^  [^ \\r\\n].*:$",
    "mu",
  ).exec(lockfile)?.[0] ?? "";
  if (!new RegExp("resolution: \\{integrity: " + integrity + "\\}", "u").test(packageBlock)) {
    throw new Error("Pi baseline 校验失败：pnpm lockfile 中的官方包 integrity 不匹配");
  }
}

function assertInstalledPackage(metadata: PackageMetadata): void {
  if (metadata.name !== PI_BASELINE_SOURCE.packageName) {
    throw new Error("Pi baseline 校验失败：实际 CLI 包名不匹配");
  }
  if (metadata.version !== PI_BASELINE_SOURCE.packageVersion) {
    throw new Error("Pi baseline 校验失败：实际 CLI 版本不匹配");
  }
  const repository = record(metadata.repository);
  const repositoryUrl = typeof repository?.url === "string" ? repository.url : "";
  const repositoryDirectory = repository?.directory;
  if (
    normalizeRepositoryUrl(repositoryUrl) !== PI_BASELINE_SOURCE.repository
    || repositoryDirectory !== "packages/coding-agent"
  ) {
    throw new Error("Pi baseline 校验失败：实际 CLI 不是官方 coding-agent 包");
  }
}

/**
 * 在启动任何 Benchmark 模型前，验证官方 Pi 基线与本地真实执行物。
 *
 * @param projectRoot 包含 package.json 和 pnpm-lock.yaml 的维护器项目根目录。
 * @returns 可直接写入报告的低敏来源指纹。
 * @throws 任一固定版本、官方仓库元数据或 lockfile integrity 偏离时拒绝运行。
 */
export async function verifyPiBaselineSource(
  projectRoot: string,
): Promise<PiBaselineSourceFingerprint> {
  const root = resolve(projectRoot);
  const cliPath = resolvePiCliPath();
  const installedPackagePath = resolve(dirname(cliPath), "..", "package.json");
  const [projectPackageText, lockfile, installedPackageText, cli] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "pnpm-lock.yaml"), "utf8"),
    readFile(installedPackagePath, "utf8"),
    readFile(cliPath),
  ]);
  const projectPackage: unknown = JSON.parse(projectPackageText);
  const installedPackage: unknown = JSON.parse(installedPackageText);
  assertProjectDependencyVersions(projectPackage);
  assertLockfileIntegrity(lockfile);
  assertInstalledPackage(record(installedPackage) ?? {});
  return {
    ...PI_BASELINE_SOURCE,
    cliHash: createHash("sha256").update(cli).digest("hex"),
  };
}
