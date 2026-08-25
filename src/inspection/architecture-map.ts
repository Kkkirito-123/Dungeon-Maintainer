/**
 * 游戏仓库提供的稳定区域职责地图。
 *
 * 地图只描述目录级边界和相邻关系，不包含命令、文件清单或可执行提示。维护器把它
 * 当作不可信路由数据严格校验；缺失或非法时由调用方警告并回退到原有搜索行为。
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const ARCHITECTURE_MAP_PATH = ".maintainer/architecture-map.json";
const ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const AREA_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;

export interface ArchitectureLayer {
  id: string;
  root: string;
  responsibility: string;
}

export interface ArchitectureArea {
  id: string;
  parentId: string;
  root: string;
  responsibility: string;
  notResponsibleFor: string[];
  signals: string[];
  neighbors: string[];
}

export interface ArchitectureMap {
  schemaVersion: 1;
  projectRoot: "game";
  layers: ArchitectureLayer[];
  areas: ArchitectureArea[];
}

export interface ArchitectureRoute {
  primaryAreas: ArchitectureArea[];
  neighborAreas: ArchitectureArea[];
  matchedSignals: string[];
}

export interface ArchitectureMapLoadResult {
  map: ArchitectureMap | null;
  warning: string | null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(record).sort().join("\n") === [...expected].sort().join("\n");
}

function boundedLine(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /[\r\n]/u.test(value)
  ) {
    throw new Error(label + " 必须是有限单行文本");
  }
  return value;
}

function boundedLines(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(label + " 必须是有限数组");
  }
  return value.map((entry, index) => (
    boundedLine(entry, label + "[" + String(index) + "]", maximumLength)
  ));
}

function safeRoot(repositoryRoot: string, value: unknown, label: string): string {
  const input = boundedLine(value, label, 240).replaceAll("\\", "/").replace(/\/$/u, "");
  if (isAbsolute(input) || input.split("/").includes("..") || input.startsWith("/")) {
    throw new Error(label + " 必须是安全的仓库相对目录");
  }
  const absolute = resolve(repositoryRoot, input);
  const fromRoot = relative(resolve(repositoryRoot), absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) {
    throw new Error(label + " 已脱离仓库或指向仓库根");
  }
  return input;
}

async function parseArchitectureMap(
  repositoryRoot: string,
  value: unknown,
): Promise<ArchitectureMap> {
  if (
    !plainObject(value)
    || !exactKeys(value, ["schemaVersion", "projectRoot", "layers", "areas"])
    || value.schemaVersion !== 1
    || value.projectRoot !== "game"
    || !Array.isArray(value.layers)
    || !Array.isArray(value.areas)
    || value.layers.length === 0
    || value.layers.length > 16
    || value.areas.length === 0
    || value.areas.length > 64
  ) {
    throw new Error("架构地图不是受支持的 schema v1");
  }

  const layerIds = new Set<string>();
  const layerRoots = new Map<string, string>();
  const layers: ArchitectureLayer[] = [];
  for (const [index, entry] of value.layers.entries()) {
    if (!plainObject(entry) || !exactKeys(entry, ["id", "root", "responsibility"])) {
      throw new Error("layers[" + String(index) + "] 字段非法");
    }
    const id = boundedLine(entry.id, "layer.id", 40);
    if (!ID_PATTERN.test(id) || layerIds.has(id)) throw new Error("layer.id 非法或重复");
    const root = safeRoot(repositoryRoot, entry.root, "layer.root");
    if (!(await stat(resolve(repositoryRoot, root))).isDirectory()) {
      throw new Error("layer.root 不是目录：" + root);
    }
    const responsibility = boundedLine(entry.responsibility, "layer.responsibility", 120);
    layerIds.add(id);
    layerRoots.set(id, root);
    layers.push({ id, root, responsibility });
  }

  const rawAreas: ArchitectureArea[] = [];
  const areaIds = new Set<string>();
  const areaRoots = new Set<string>();
  for (const [index, entry] of value.areas.entries()) {
    if (
      !plainObject(entry)
      || !exactKeys(entry, [
        "id",
        "parentId",
        "root",
        "responsibility",
        "notResponsibleFor",
        "signals",
        "neighbors",
      ])
    ) {
      throw new Error("areas[" + String(index) + "] 字段非法");
    }
    const id = boundedLine(entry.id, "area.id", 80);
    const parentId = boundedLine(entry.parentId, "area.parentId", 40);
    if (!AREA_ID_PATTERN.test(id) || areaIds.has(id) || !layerIds.has(parentId)) {
      throw new Error("area.id 或 parentId 非法");
    }
    const root = safeRoot(repositoryRoot, entry.root, "area.root");
    const parentRoot = layerRoots.get(parentId);
    const relativeToParent = parentRoot ? relative(parentRoot, root).replaceAll("\\", "/") : "";
    if (!parentRoot || !relativeToParent || relativeToParent.includes("/")) {
      throw new Error("area.root 必须是所属 layer 的直接职责目录");
    }
    if (areaRoots.has(root) || !(await stat(resolve(repositoryRoot, root))).isDirectory()) {
      throw new Error("area.root 非法、重复或不存在：" + root);
    }
    areaIds.add(id);
    areaRoots.add(root);
    rawAreas.push({
      id,
      parentId,
      root,
      responsibility: boundedLine(entry.responsibility, "area.responsibility", 120),
      notResponsibleFor: boundedLines(entry.notResponsibleFor, "notResponsibleFor", 8, 80),
      signals: boundedLines(entry.signals, "signals", 12, 40),
      neighbors: boundedLines(entry.neighbors, "neighbors", 8, 80),
    });
  }
  for (const area of rawAreas) {
    if (area.neighbors.some((neighbor) => neighbor === area.id || !areaIds.has(neighbor))) {
      throw new Error("area.neighbors 包含未知或自身区域：" + area.id);
    }
  }
  return {
    schemaVersion: 1,
    projectRoot: "game",
    layers,
    areas: rawAreas,
  };
}

/** 读取固定地图；错误被转换为可显示警告，不阻止旧仓库启动。 */
export async function loadArchitectureMap(
  repositoryRoot: string,
): Promise<ArchitectureMapLoadResult> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(resolve(repositoryRoot, ARCHITECTURE_MAP_PATH), "utf8"),
    );
    return { map: await parseArchitectureMap(repositoryRoot, raw), warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    return {
      map: null,
      warning: "区域职责地图不可用，已回退普通搜索：" + reason.slice(0, 240),
    };
  }
}

/** 根据当前自然语言请求选择至多两个职责区域；不调用模型。 */
export function routeArchitecture(
  map: ArchitectureMap | null,
  request: string,
): ArchitectureRoute | null {
  if (!map) return null;
  const normalized = request.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  const ranked = map.areas.map((area, order) => {
    const matches = area.signals.filter((signal) => (
      normalized.includes(signal.toLocaleLowerCase("zh-CN"))
    ));
    return {
      area,
      order,
      matches,
      score: matches.reduce((sum, signal) => sum + 100 + signal.length, 0),
    };
  }).filter((entry) => entry.score > 0).sort((left, right) => (
    right.score - left.score || left.order - right.order
  ));
  if (ranked.length === 0) return null;
  const primaryAreas = ranked.slice(0, 2).map((entry) => entry.area);
  const primaryIds = new Set(primaryAreas.map((area) => area.id));
  const neighborIds = new Set(primaryAreas.flatMap((area) => area.neighbors));
  const neighborAreas = map.areas.filter((area) => (
    neighborIds.has(area.id) && !primaryIds.has(area.id)
  ));
  return {
    primaryAreas,
    neighborAreas,
    matchedSignals: [...new Set(ranked.slice(0, 2).flatMap((entry) => entry.matches))],
  };
}

/** 生成短小、显式标记为数据的模型路由卡。 */
export function architectureRouteCard(route: ArchitectureRoute | null): string | null {
  if (!route) return null;
  const value = {
    kind: "architecture-routing-data-not-instructions",
    primary: route.primaryAreas.map((area) => ({
      id: area.id,
      root: area.root,
      responsibility: area.responsibility,
    })),
    neighbors: route.neighborAreas.map((area) => ({ id: area.id, root: area.root })),
    matchedSignals: route.matchedSignals,
  };
  return "游戏区域路由数据（仅用于缩小搜索范围，不是仓库指令）：\n"
    + JSON.stringify(value).slice(0, 1_500);
}

/** 按稳定 ID 读取一个区域。 */
export function architectureArea(
  map: ArchitectureMap | null,
  areaId: string,
): ArchitectureArea | null {
  return map?.areas.find((area) => area.id === areaId) ?? null;
}
