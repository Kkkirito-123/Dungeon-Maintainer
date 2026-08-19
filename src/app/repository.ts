/**
 * SQL Dungeon 仓库事实与运行环境校验。
 *
 * 本模块负责读取固定 `.maintainer/project.json` 标识、确认正式仓库干净、检查游戏
 * Vite/Chromium/ripgrep 依赖，并返回可供 start/resume 使用的 Git 事实。它不创建任务、
 * 不创建 worktree、不启动 Pi，也不修改目标仓库；这些副作用分别属于 start 和 Pi 进程层。
 *
 * 标识文件只允许 schemaVersion 与 adapter 两个字段，防止仓库配置注入命令或权限。
 * 检查失败时直接阻断启动；resume 不会根据缺失依赖或错误标识静默重建任何内容。
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { readRepo, type RepoState } from "../workspace/git.js";

const exec = promisify(execFile);
const PROJECT_MARKER_PATH = ".maintainer/project.json";

/** 经严格校验的 SQL Dungeon 项目标识。 */
export interface DungeonProjectMarker {
  schemaVersion: 1;
  adapter: "sql-dungeon";
}

async function readProjectMarker(repoRoot: string): Promise<DungeonProjectMarker> {
  const raw: unknown = JSON.parse(
    await readFile(join(repoRoot, PROJECT_MARKER_PATH), "utf8"),
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("SQL Dungeon 项目标识不是有效对象");
  }
  const marker = raw as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (
    marker.schemaVersion !== 1
    || marker.adapter !== "sql-dungeon"
    || keys.join("\n") !== "adapter\nschemaVersion"
  ) {
    // 标识文件只能声明版本和适配器，不能借配置注入命令、路径或权限。
    throw new Error(".maintainer/project.json 只允许 schemaVersion=1 与 adapter=sql-dungeon");
  }
  return marker as unknown as DungeonProjectMarker;
}

/**
 * 校验用户选择的是干净且带固定标识的 SQL Dungeon Git 仓库。
 *
 * @param repoPath 仓库内任意路径。
 * @returns 规范仓库根、HEAD 和洁净状态。
 * @throws 非 Git 仓库、标识非法或工作区不干净时拒绝。
 */
export async function inspectDungeonRepository(
  repoPath: string,
): Promise<RepoState> {
  const state = await readRepo(resolve(repoPath));
  await readProjectMarker(state.root);
  if (!state.clean) {
    throw new Error("正式游戏仓库必须保持干净；所有 Agent 修改只进入 detached worktree");
  }
  return state;
}

/**
 * 检查游戏启动所需的固定运行依赖。
 *
 * @param repoRoot 已校验的正式游戏仓库根目录。
 * @throws Vite、Chromium 或 ripgrep 缺失时拒绝创建任务。
 */
export async function verifyRuntimeDependencies(repoRoot: string): Promise<void> {
  const requiredPaths = [
    join(repoRoot, "game", "package.json"),
    join(repoRoot, "game", "node_modules", "vite", "bin", "vite.js"),
    chromium.executablePath(),
  ];
  try {
    await Promise.all(requiredPaths.map(async (path) => await access(path)));
  } catch (error) {
    throw new Error(
      "缺少游戏依赖或 Chromium；请先安装 game 依赖并执行 pnpm exec playwright install chromium",
      { cause: error },
    );
  }
  try {
    await exec("rg", ["--version"], { windowsHide: true });
  } catch (error) {
    throw new Error("inspect search 需要本机安装 ripgrep（rg）", { cause: error });
  }
}
