/**
 * SQL Dungeon 项目适配器。
 *
 * 适配器是维护器通用运行时与具体游戏仓库之间的唯一连接点：它校验只读的
 * `.maintainer/project.json` 标识，登记固定检查命令，并提供试玩入口。项目文件
 * 不能声明命令、参数或权限，因而被修改的目标仓库无法借配置诱导维护器执行任意
 * Shell。所有命令使用 `execFile` 的参数数组，模型只能选择稳定检查 ID。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** SQL Dungeon 可执行的固定检查 ID。 */
export type CheckId =
  | "rules-test" | "rules-validate" | "agent-test"
  | "game-test" | "game-architecture" | "game-build";

/** 固定检查定义；不得从目标仓库配置扩展。 */
export interface CheckSpec {
  id: CheckId;
  file: string;
  args: readonly string[];
}

const SPECS: Readonly<Record<CheckId, CheckSpec>> = {
  "rules-test": { id: "rules-test", file: "python", args: ["scripts/test_validate_rules.py"] },
  "rules-validate": { id: "rules-validate", file: "python", args: ["scripts/validate-rules.py"] },
  "agent-test": { id: "agent-test", file: "python", args: ["-m", "unittest", "discover", "-s", "agent/tests"] },
  "game-test": { id: "game-test", file: "pnpm", args: ["--dir", "game", "test"] },
  "game-architecture": { id: "game-architecture", file: "pnpm", args: ["--dir", "game", "architecture:check"] },
  "game-build": { id: "game-build", file: "pnpm", args: ["--dir", "game", "build"] },
};

/**
 * 校验目标仓库选择了 SQL Dungeon 适配器。
 * @param root 目标仓库根目录。
 * @throws 文件缺失、额外字段、版本或适配器不匹配时拒绝。
 */
export async function verifyProject(root: string): Promise<void> {
  const value: unknown = JSON.parse(await readFile(join(root, ".maintainer", "project.json"), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("项目适配器配置非法");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "adapter,schemaVersion" || record.schemaVersion !== 1 || record.adapter !== "sql-dungeon") {
    throw new Error("目标仓库不是受支持的 SQL Dungeon 项目");
  }
}

/**
 * 返回固定检查定义。
 * @param id 模型只能从公开枚举选择的检查 ID。
 * @returns 不含 Shell 字符串和用户参数的命令定义。
 * @throws 未知 ID。
 */
export function checkSpec(id: string): CheckSpec {
  if (!Object.hasOwn(SPECS, id)) throw new Error(`未知检查 ID：${id}`);
  return SPECS[id as CheckId];
}

/** 返回完整固定检查 ID，用于 CLI 帮助和测试。 */
export function checkIds(): CheckId[] { return Object.keys(SPECS) as CheckId[]; }
