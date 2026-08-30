/**
 * 当前游戏仓库的独立静态合同检查。
 *
 * GameContractCheck 不读取 EvalDataset，也不运行场景。它只确认维护器可见的游戏目录、
 * 固定脚本和协议 1.0 开发桥仍存在，让游戏开发与冻结 Eval 数据互不修改。
 */

import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 单项游戏合同检查。 */
export interface GameContractCheck {
  readonly id: string;
  readonly passed: boolean;
}

/** 当前游戏仓库的静态合同结果。 */
export interface GameContractCheckResult {
  readonly schemaVersion: 1;
  readonly status: "passed" | "failed";
  readonly checks: readonly GameContractCheck[];
}

async function plainFile(path: string): Promise<boolean> {
  try {
    const information = await lstat(path);
    return information.isFile() && !information.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 检查当前游戏仓库是否仍满足维护器运行合同。
 *
 * @param repositoryRoot 包含 `game/` 的游戏仓库根。
 * @returns 只含稳定检查 ID 和布尔结果，不执行游戏脚本。
 */
export async function runGameContractCheck(
  repositoryRoot: string,
): Promise<GameContractCheckResult> {
  const root = await realpath(resolve(repositoryRoot));
  const packagePath = join(root, "game", "package.json");
  const protocolPath = join(root, "game", "src", "devtools", "dungeon-agent", "protocol.ts");
  const checks: GameContractCheck[] = [
    { id: "game-package", passed: await plainFile(packagePath) },
    { id: "playtest-protocol", passed: await plainFile(protocolPath) },
  ];
  if (checks.every((check) => check.passed)) {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = packageJson.scripts ?? {};
    checks.push(
      { id: "game-test-script", passed: typeof scripts.test === "string" },
      { id: "game-build-script", passed: typeof scripts.build === "string" },
      { id: "game-architecture-script", passed: typeof scripts["architecture:check"] === "string" },
    );
    const protocol = await readFile(protocolPath, "utf8");
    checks.push(
      { id: "playtest-protocol", passed: /readonly version:\s*1;/u.test(protocol) },
      { id: "playtest-player-actions", passed: ["look", "act", "query"]
        .every((name) => protocol.includes(name + "(")) },
      { id: "playtest-oracle-actions", passed: ["prepare", "checkpoint", "judge", "events"]
        .every((name) => protocol.includes(name + "(")) },
    );
  }
  return {
    schemaVersion: 1,
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
  };
}
