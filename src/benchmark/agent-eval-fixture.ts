/**
 * 内置 Agent Eval fixture 的安全物化。
 *
 * 本模块只负责从版本库内的 `test-fixtures/agent-evals/<id>` 读取固定
 * manifest、基线文件和补丁，并在调用方指定的全新目录中建立可重复的 Git
 * 评测仓库。它不运行 Benchmark、不选择任务、不修改 fixture 源数据，也不向
 * Agent 暴露任意 Git 或 Shell 能力。
 *
 * 输入是受限的 fixture ID、可选的 fixture 根目录和一个必须尚不存在的目标目录；
 * 输出只包含新仓库路径、实际基线提交与已校验的脏路径。唯一副作用是创建该
 * 目标目录并在其中执行参数固定的 Git 命令。Git 不经过 shell，提交作者、时间、
 * `core.autocrlf` 和 hooks 路径均被固定，不使用用户身份或证书。
 *
 * fixture 目录、manifest、补丁和基线文件都被当作不可信输入：路径穿越、
 * 符号链接/特殊文件、已有目标、Hash/文件数/脏路径不一致都会失败。若在创建
 * 目标后失败，模块只递归回收本次创建的精确目录；回收也失败时同时报告原错误
 * 和回收错误，不会静默留下可被误用的半成品。
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const FIXED_GIT_NAME = "Dungeon Maintainer Agent Eval";
const FIXED_GIT_EMAIL = "agent-eval@dungeon-maintainer.invalid";
const FIXED_GIT_DATE = "2000-01-01T00:00:00+00:00";

interface AgentEvalFixtureManifest {
  schemaVersion: 2;
  id: string;
  base: string;
  sourcePatch: "source.patch";
  patchSha256: string;
  dirtyPaths: string[];
}

interface AgentEvalSharedBaseManifest {
  schemaVersion: 1;
  id: string;
  sourceCommit: string;
  sourceFingerprint: string;
  baselineFileCount: number;
  repositoryDir: "repository";
}

/** Agent Eval fixture 物化的固定输入。 */
export interface AgentEvalFixtureMaterializeOptions {
  /** fixture ID，必须是不含路径分隔符的单一目录名。 */
  readonly id: string;
  /** 全新评测仓库的目标目录；其父目录必须已存在。 */
  readonly destination: string;
  /** fixture 根目录；省略时为当前工作目录下的 `test-fixtures/agent-evals`。 */
  readonly fixtureRoot?: string;
  /** `clean` 仅供零模型预检验证 after Oracle；正式 Agent Eval 始终省略并使用 broken。 */
  readonly variant?: "broken" | "clean";
}

/** 已建立且完成 manifest 一致性校验的 Agent Eval 仓库事实。 */
export interface MaterializedAgentEvalFixture {
  /** 新建仓库的规范绝对路径。 */
  readonly destination: string;
  /** 本地重建的实际基线提交，不要求与共享基线的 `sourceCommit` 相同。 */
  readonly baseCommit: string;
  /** 应用补丁后的排序去重项目相对路径。 */
  readonly dirtyPaths: readonly string[];
  /** 源码/地图组合指纹，用于绑定预检证书和结果来源。 */
  readonly sourceFingerprint: string;
}

/** 当前游戏 Benchmark Adapter 的物化参数。 */
export interface GameBenchmarkAdapterMaterializeOptions {
  readonly id: string;
  readonly destination: string;
  readonly gameRepositoryRoot: string;
  readonly variant?: "broken" | "clean";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function normalizeFixtureId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || id === "." || id === "..") {
    throw new Error("Agent Eval fixture ID 不是安全的单一目录名");
  }
  return id;
}

function normalizeFixturePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || isAbsolute(value)
    || value.includes("\\")
    || /[:*?"<>|]/u.test(value)
  ) {
    throw new Error("fixture.json 包含非法 dirtyPaths 路径");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || segments[0]?.toLowerCase() === ".git"
  ) {
    throw new Error("fixture.json 包含路径穿越或 Git 内部路径");
  }
  return segments.join("/");
}

function parseManifest(value: unknown, requestedId: string): AgentEvalFixtureManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fixture.json 必须是对象");
  }
  const manifest = value as Record<string, unknown>;
  const expectedKeys = [
    "base",
    "dirtyPaths",
    "id",
    "patchSha256",
    "schemaVersion",
    "sourcePatch",
  ];
  if (Object.keys(manifest).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new Error("fixture.json 字段与当前 schema v2 不一致");
  }
  if (
    manifest.schemaVersion !== 2
    || manifest.id !== requestedId
    || typeof manifest.base !== "string"
    || normalizeFixtureId(manifest.base) !== manifest.base
    || manifest.sourcePatch !== "source.patch"
    || typeof manifest.patchSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(manifest.patchSha256)
    || !Array.isArray(manifest.dirtyPaths)
  ) {
    throw new Error("fixture.json 内容与当前 schema v2 不一致");
  }
  const dirtyPaths = manifest.dirtyPaths.map(normalizeFixturePath);
  if (new Set(dirtyPaths).size !== dirtyPaths.length) {
    throw new Error("fixture.json 的 dirtyPaths 不允许重复");
  }
  return {
    schemaVersion: 2,
    id: requestedId,
    base: manifest.base,
    sourcePatch: "source.patch",
    patchSha256: manifest.patchSha256,
    dirtyPaths: [...dirtyPaths].sort(),
  };
}

function parseSharedBaseManifest(
  value: unknown,
  requestedId: string,
): AgentEvalSharedBaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("base.json 必须是对象");
  }
  const manifest = value as Record<string, unknown>;
  const expectedKeys = [
    "baselineFileCount",
    "id",
    "repositoryDir",
    "schemaVersion",
    "sourceCommit",
    "sourceFingerprint",
  ];
  if (Object.keys(manifest).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new Error("base.json 字段与 schema v1 不一致");
  }
  if (
    manifest.schemaVersion !== 1
    || manifest.id !== requestedId
    || typeof manifest.sourceCommit !== "string"
    || !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit)
    || typeof manifest.sourceFingerprint !== "string"
    || !/^[0-9a-f]{64}$/u.test(manifest.sourceFingerprint)
    || typeof manifest.baselineFileCount !== "number"
    || !Number.isSafeInteger(manifest.baselineFileCount)
    || manifest.baselineFileCount < 0
    || manifest.repositoryDir !== "repository"
  ) {
    throw new Error("base.json 内容与 schema v1 不一致");
  }
  return {
    schemaVersion: 1,
    id: requestedId,
    sourceCommit: manifest.sourceCommit,
    sourceFingerprint: manifest.sourceFingerprint,
    baselineFileCount: manifest.baselineFileCount,
    repositoryDir: "repository",
  };
}

async function readManifest(path: string, requestedId: string): Promise<AgentEvalFixtureManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error("fixture.json 不是有效 UTF-8 JSON", { cause: error });
  }
  return parseManifest(value, requestedId);
}

async function readSharedBaseManifest(
  path: string,
  requestedId: string,
): Promise<AgentEvalSharedBaseManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error("base.json 不是有效 UTF-8 JSON", { cause: error });
  }
  return parseSharedBaseManifest(value, requestedId);
}

function assertDirectChild(parent: string, child: string, label: string): void {
  const childPath = relative(parent, child);
  if (
    childPath.length === 0
    || childPath.startsWith("..")
    || isAbsolute(childPath)
    || childPath.includes("/")
    || childPath.includes("\\")
  ) {
    throw new Error(label + " 逃逸 fixture 根目录");
  }
}

async function requirePlainFile(path: string, label: string): Promise<void> {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(label + " 必须是普通文件");
  }
}

interface AgentEvalFixtureDefinition {
  readonly manifest: AgentEvalFixtureManifest;
  readonly patchPath: string;
  readonly repositoryPath: string;
  readonly baselineFileCount: number;
  readonly sourceFingerprint: string;
}

async function readFixtureDefinition(
  fixtureRoot: string,
  id: string,
): Promise<AgentEvalFixtureDefinition> {
  const rootInformation = await lstat(fixtureRoot);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new Error("Agent Eval fixture 根必须是真实目录");
  }
  const realFixtureRoot = await realpath(fixtureRoot);
  const requestedFixtureDirectory = resolve(realFixtureRoot, id);
  const fixtureInformation = await lstat(requestedFixtureDirectory);
  if (fixtureInformation.isSymbolicLink() || !fixtureInformation.isDirectory()) {
    throw new Error("Agent Eval fixture 必须是真实目录");
  }
  const fixtureDirectory = await realpath(requestedFixtureDirectory);
  assertDirectChild(realFixtureRoot, fixtureDirectory, "Agent Eval fixture");

  const manifestPath = join(fixtureDirectory, "fixture.json");
  const patchPath = join(fixtureDirectory, "source.patch");
  await requirePlainFile(manifestPath, "fixture.json");
  await requirePlainFile(patchPath, "source.patch");
  const manifest = await readManifest(manifestPath, id);

  const basesPath = join(realFixtureRoot, "_bases");
  const basesInformation = await lstat(basesPath);
  if (basesInformation.isSymbolicLink() || !basesInformation.isDirectory()) {
    throw new Error("Agent Eval 共享基线根必须是真实目录");
  }
  const realBasesPath = await realpath(basesPath);
  assertDirectChild(realFixtureRoot, realBasesPath, "Agent Eval 共享基线根");
  const requestedBaseDirectory = resolve(realBasesPath, manifest.base);
  const baseInformation = await lstat(requestedBaseDirectory);
  if (baseInformation.isSymbolicLink() || !baseInformation.isDirectory()) {
    throw new Error("Agent Eval 共享基线必须是真实目录");
  }
  const baseDirectory = await realpath(requestedBaseDirectory);
  assertDirectChild(realBasesPath, baseDirectory, "Agent Eval 共享基线");
  const baseManifestPath = join(baseDirectory, "base.json");
  await requirePlainFile(baseManifestPath, "base.json");
  const baseManifest = await readSharedBaseManifest(baseManifestPath, manifest.base);
  return {
    manifest,
    patchPath,
    repositoryPath: join(baseDirectory, baseManifest.repositoryDir),
    baselineFileCount: baseManifest.baselineFileCount,
    sourceFingerprint: baseManifest.sourceFingerprint,
  };
}

/** 读取内置 fixture 当前共享基线的源码/地图指纹。 */
export async function readAgentEvalFixtureSourceFingerprint(options: {
  readonly id: string;
  readonly fixtureRoot: string;
}): Promise<string> {
  const id = normalizeFixtureId(options.id);
  const definition = await readFixtureDefinition(resolve(options.fixtureRoot), id);
  return definition.sourceFingerprint;
}

async function inspectRepositoryTree(root: string): Promise<number> {
  let fileCount = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git") {
      throw new Error("fixture repository 不得包含 Git 内部目录");
    }
    const entryPath = join(root, entry.name);
    const information = await lstat(entryPath);
    if (information.isSymbolicLink()) {
      throw new Error("fixture repository 不得包含符号链接或 junction");
    }
    if (information.isDirectory()) {
      fileCount += await inspectRepositoryTree(entryPath);
    } else if (information.isFile()) {
      fileCount += 1;
    } else {
      throw new Error("fixture repository 不得包含特殊文件");
    }
  }
  return fileCount;
}

async function copyRepositoryTree(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git") {
      throw new Error("fixture repository 在复制期间出现 Git 内部目录");
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const information = await lstat(sourcePath);
    if (information.isSymbolicLink()) {
      throw new Error("fixture repository 在复制期间出现符号链接或 junction");
    }
    if (information.isDirectory()) {
      await mkdir(destinationPath);
      await copyRepositoryTree(sourcePath, destinationPath);
    } else if (information.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      // inspectRepositoryTree 已经拒绝过链接和特殊文件；复制时再检查是为了
      // 防止 fixture 在校验与复制之间被替换。
      throw new Error("fixture repository 在复制期间出现链接或特殊文件");
    }
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await executeFile("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function initializeRepository(destination: string): Promise<void> {
  await runGit(destination, ["init", "--quiet"]);
  await runGit(destination, ["config", "core.autocrlf", "false"]);
  await runGit(destination, ["config", "user.name", FIXED_GIT_NAME]);
  await runGit(destination, ["config", "user.email", FIXED_GIT_EMAIL]);
  await runGit(destination, ["config", "commit.gpgSign", "false"]);
  await runGit(destination, ["config", "core.hooksPath", ".git/no-hooks"]);
}

async function commitBaseline(destination: string): Promise<string> {
  await runGit(destination, ["add", "--all", "--force", "--"]);
  await runGit(destination, [
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "--no-verify",
    "--message",
    "agent-eval buggy root",
  ], {
    GIT_AUTHOR_NAME: FIXED_GIT_NAME,
    GIT_AUTHOR_EMAIL: FIXED_GIT_EMAIL,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_NAME: FIXED_GIT_NAME,
    GIT_COMMITTER_EMAIL: FIXED_GIT_EMAIL,
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
    TZ: "UTC",
  });
  return (await runGit(destination, ["rev-parse", "HEAD"])).trim();
}

async function readDirtyPaths(destination: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(destination, ["diff", "--name-only", "-z", "--no-renames", "--"]),
    runGit(destination, ["ls-files", "-z", "--others"]),
  ]);
  return [...new Set(
    (tracked + untracked)
      .split("\0")
      .filter(Boolean)
      .map(normalizeFixturePath),
  )].sort();
}

/**
 * 将单个内置 Agent Eval fixture 物化为可直接运行评测的本地 Git 仓库。
 *
 * @param options fixture ID、目标目录与可选的测试根目录。目标父目录必须已存在，
 * 目标本身必须不存在。
 * @returns 规范目标路径、唯一 Bug root commit 和补丁涉及的已校验路径。
 * @throws ID/路径穿越、符号链接或特殊文件、已有目标、manifest 不一致、
 * Git 失败或补丁后脏路径不一致时拒绝；创建后失败会回收本次目标。
 * @remarks 调用方只授权创建 `destination`；函数不改动 fixture、其他目录或用户
 * Git 配置。共享基线的 `sourceCommit` 仅作为来源元数据，不强制本地重建提交同 Hash。
 */
export async function materializeAgentEvalFixture(
  options: AgentEvalFixtureMaterializeOptions,
): Promise<MaterializedAgentEvalFixture> {
  const id = normalizeFixtureId(options.id);
  const fixtureRoot = resolve(
    options.fixtureRoot ?? join(process.cwd(), "test-fixtures", "agent-evals"),
  );
  const destination = resolve(options.destination);
  if (dirname(destination) === destination) {
    throw new Error("拒绝将文件系统根目录作为 Agent Eval 目标");
  }
  if (await pathExists(destination)) {
    throw new Error("Agent Eval 目标目录已存在");
  }

  const definition = await readFixtureDefinition(fixtureRoot, id);
  const {
    manifest,
    patchPath,
    repositoryPath,
    baselineFileCount,
    sourceFingerprint,
  } = definition;
  const repositoryInformation = await lstat(repositoryPath);
  if (repositoryInformation.isSymbolicLink() || !repositoryInformation.isDirectory()) {
    throw new Error("fixture repository 必须是真实目录");
  }

  const actualBaselineFileCount = await inspectRepositoryTree(repositoryPath);
  if (actualBaselineFileCount !== baselineFileCount) {
    throw new Error("fixture repository 文件数与 manifest 不一致");
  }
  const patchBytes = await readFile(patchPath);
  const canonicalPatch = patchBytes.toString("utf8").replace(/\r\n/gu, "\n");
  const patchSha256 = createHash("sha256").update(canonicalPatch).digest("hex");
  if (patchSha256 !== manifest.patchSha256) {
    throw new Error("source.patch SHA-256 与 manifest 不一致");
  }

  let created = false;
  try {
    await mkdir(destination);
    created = true;
    await copyRepositoryTree(repositoryPath, destination);
    // 临时 index 只用于验证 source.patch 的精确脏路径；正确版本永远不会形成提交。
    await initializeRepository(destination);
    await runGit(destination, ["add", "--all", "--force", "--"]);
    // 固定 core.autocrlf=false 只保证物化仓库后续不再自动转换换行；已打包的 fixture 可能在
    // Windows 检出时已保存为 CRLF，而 source.patch 依然使用 Git 标准 LF。只忽略上下文换行空白，
    // 不忽略字符内容，可使同一 fixture 在不同检出环境中稳定应用。
    let dirtyPaths: string[] = [];
    if ((options.variant ?? "broken") === "broken") {
      await runGit(destination, [
        "apply",
        "--ignore-space-change",
        "--whitespace=nowarn",
        "--",
        patchPath,
      ]);
      dirtyPaths = await readDirtyPaths(destination);
      if (dirtyPaths.join("\n") !== manifest.dirtyPaths.join("\n")) {
        throw new Error("应用 source.patch 后的 dirtyPaths 与 manifest 不一致");
      }
    }
    // 删除包含正确版本 index 的临时 Git 元数据，再把 Bug 代码建成唯一 root commit。
    // 这样 Agent 不能通过 HEAD^、git diff 或 index 找到注入补丁的反向答案。
    await rm(join(destination, ".git"), { recursive: true, force: true, maxRetries: 3 });
    await initializeRepository(destination);
    const baseCommit = await commitBaseline(destination);
    const trackedFileCount = (await runGit(destination, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean)
      .length;
    if (trackedFileCount !== baselineFileCount) {
      throw new Error("Bug root commit 文件数与 manifest 不一致");
    }
    if ((await runGit(destination, ["status", "--porcelain"])).trim()) {
      throw new Error("Bug root commit 后工作区不干净");
    }
    if ((await runGit(destination, ["rev-list", "--count", "HEAD"])).trim() !== "1") {
      throw new Error("Agent Eval 必须只有一个 Bug root commit");
    }
    return { destination, baseCommit, dirtyPaths, sourceFingerprint };
  } catch (error) {
    if (created) {
      try {
        await rm(destination, { recursive: true, force: true, maxRetries: 3 });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Agent Eval fixture 物化失败，且无法回收半成品目录",
        );
      }
    }
    throw error;
  }
}

/** 让当前游戏仓库从自身工作树物化评测仓库，维护器不再持有游戏源码快照。 */
export async function materializeAgentEvalFixtureFromGameAdapter(
  options: GameBenchmarkAdapterMaterializeOptions,
): Promise<MaterializedAgentEvalFixture> {
  const id = normalizeFixtureId(options.id);
  const destination = resolve(options.destination);
  if (dirname(destination) === destination || await pathExists(destination)) {
    throw new Error("游戏 Benchmark Adapter 目标非法或已存在");
  }
  const root = await realpath(resolve(options.gameRepositoryRoot));
  const rootInformation = await lstat(root);
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    throw new Error("游戏 Benchmark Adapter 根必须是真实目录");
  }
  const adapter = join(root, "scripts", "benchmark-adapter.mjs");
  await requirePlainFile(adapter, "游戏 Benchmark Adapter");
  const variant = options.variant ?? "broken";
  const result = await executeFile(process.execPath, [
    adapter,
    "materialize",
    "--fixture", id,
    "--destination", destination,
    "--variant", variant,
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error("游戏 Benchmark Adapter 物化结果不是有效 JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("游戏 Benchmark Adapter 物化结果必须是对象");
  }
  const output = value as Record<string, unknown>;
  const expectedKeys = [
    "adapterVersion", "baseCommit", "destination", "dirtyPaths",
    "fixtureId", "schemaVersion", "sourceFingerprint", "variant",
  ];
  if (Object.keys(output).sort().join("\n") !== expectedKeys.sort().join("\n")) {
    throw new Error("游戏 Benchmark Adapter 物化结果字段不一致");
  }
  if (
    output.schemaVersion !== 2
    || output.adapterVersion !== 2
    || output.fixtureId !== id
    || output.variant !== variant
    || resolve(String(output.destination)) !== destination
    || typeof output.baseCommit !== "string"
    || !/^[0-9a-f]{40}$/u.test(output.baseCommit)
    || !Array.isArray(output.dirtyPaths)
    || typeof output.sourceFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(output.sourceFingerprint)
  ) throw new Error("游戏 Benchmark Adapter 物化结果不合法");
  const dirtyPaths = output.dirtyPaths.map(normalizeFixturePath).sort();
  if (new Set(dirtyPaths).size !== dirtyPaths.length) {
    throw new Error("游戏 Benchmark Adapter dirtyPaths 不允许重复");
  }
  if (variant === "clean" && dirtyPaths.length !== 0) {
    throw new Error("游戏 Benchmark Adapter clean 结果不得包含 dirtyPaths");
  }
  return { destination, baseCommit: output.baseCommit, dirtyPaths, sourceFingerprint: output.sourceFingerprint };
}
