/**
 * 游戏仓库提供的稳定区域职责地图。
 *
 * 地图只描述目录级边界、功能路由和安全 Adapter 元数据，不包含命令、文件清单或
 * 可执行提示。维护器把它当作不可信数据校验；缺失或核心非法时开放失败到安全搜索。
 */

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const ARCHITECTURE_MAP_PATH = ".maintainer/architecture-map.json";
const MAX_MAP_BYTES = 256 * 1024;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const AREA_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const PARTITION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/u;
const FLOOR_SCOPE_ID_PATTERN = /^floor\.(\d{2,3})$/u;
const FEATURE_ID_PATTERN = /^feature\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

/** 一个稳定架构层。 */
export interface ArchitectureLayer {
  id: string;
  root: string;
  responsibility: string;
}

/** 一个稳定职责区域。 */
export interface ArchitectureArea {
  id: string;
  parentId: string;
  root: string;
  responsibility: string;
  notResponsibleFor: string[];
  signals: string[];
  neighbors: string[];
}

/** area 内部可独立路由的稳定目录。 */
export type ArchitecturePartition = ArchitectureArea;

/** 一个跨职责区域的稳定楼层切片；roots 只登记目录，不登记其中的文件。 */
export interface ArchitectureFloorScope {
  id: string;
  floor: number;
  roots: string[];
  responsibility: string;
  signals: string[];
  neighbors: string[];
  sharedPartitions: string[];
  contentRefs: string[];
  serviceRefs: string[];
  featureRefs: string[];
}

/** 一个功能组的分阶段稳定路由。 */
export interface ArchitectureFeatureRoute {
  primary: string[];
  adjacent: string[];
  shared: string[];
  fallback: string[];
}

/** 一个跨层产品功能；引用稳定 ID，不复制游戏源码或文件索引。 */
export interface ArchitectureFeature {
  id: string;
  roots: string[];
  responsibility: string;
  notResponsibleFor: string[];
  signals: string[];
  negativeSignals: string[];
  neighbors: string[];
  route: ArchitectureFeatureRoute;
  contentRefs: string[];
  serviceProviders: string[];
}

/** 游戏声明的安全运行时入口元数据；命令仍由维护器白名单拥有。 */
export interface ArchitectureRuntimeContract {
  sourceRoot: string;
  bridgeProtocol: 3;
  adapterVersion: 2;
  supportedCapabilities: string[];
}

/** 哪些变更需要维护架构表的稳定策略。 */
export interface ArchitectureMaintenancePolicy {
  ordinaryFile: "no-update";
  internalDirectory: "no-update";
  rootMoveOrRename: "update";
  areaPartitionChange: "update";
  responsibilityOrRouteChange: "update";
  invalidCore: "fallback";
}

/** 不包含源码内容和文件名的稳定边界签名。 */
export interface ArchitectureBoundary {
  algorithm: "direct-child-v1";
  signature: string;
}

/** 已验证并规范化的游戏架构地图。 */
export interface ArchitectureMap {
  schemaVersion: 4;
  projectRoot: string;
  contractId: string;
  contractVersion: number;
  boundaryRevision: number;
  layers: ArchitectureLayer[];
  areas: ArchitectureArea[];
  partitions: ArchitecturePartition[];
  floorScopes: ArchitectureFloorScope[];
  features: ArchitectureFeature[];
  runtime: ArchitectureRuntimeContract;
  maintenancePolicy: ArchitectureMaintenancePolicy;
  boundary: ArchitectureBoundary;
}

/** 当前自然语言请求的确定性路由结果。 */
export interface ArchitectureRoute {
  currentFloorScope: ArchitectureFloorScope | null;
  neighborFloorScopes: ArchitectureFloorScope[];
  sharedPartitions: ArchitecturePartition[];
  primaryFeatures: ArchitectureFeature[];
  featurePrimaryRoots: string[];
  featureAdjacentRoots: string[];
  featureSharedRoots: string[];
  featureFallbackRoots: string[];
  primaryPartitions: ArchitecturePartition[];
  neighborPartitions: ArchitecturePartition[];
  primaryAreas: ArchitectureArea[];
  neighborAreas: ArchitectureArea[];
  matchedSignals: string[];
}

/** 地图加载结果；warning 只包含有限元数据原因。 */
export interface ArchitectureMapLoadResult {
  map: ArchitectureMap | null;
  warning: string | null;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateShape(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!plainObject(value) || expected.some((key) => !(key in value))) {
    throw new Error(label + " 缺少必需字段");
  }
  const unknown = Object.keys(value).filter((key) => !expected.includes(key));
  if (unknown.length > 0) {
    throw new Error(label + " 包含未知字段：" + unknown.slice(0, 8).join(","));
  }
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
  const output = value.map((entry, index) => (
    boundedLine(entry, label + "[" + String(index) + "]", maximumLength)
  ));
  if (new Set(output).size !== output.length) throw new Error(label + " 不能重复");
  return output;
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

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === ""
    || (fromParent !== ".." && !fromParent.startsWith("..\\") && !isAbsolute(fromParent));
}

async function safeExistingDirectory(
  repositoryRoot: string,
  value: unknown,
  label: string,
): Promise<string> {
  const input = safeRoot(repositoryRoot, value, label);
  const repositoryRealPath = await realpath(repositoryRoot);
  const target = resolve(repositoryRoot, input);
  const targetRealPath = await realpath(target);
  if (!isInside(repositoryRealPath, targetRealPath) || !(await stat(targetRealPath)).isDirectory()) {
    throw new Error(label + " 不是仓库内目录：" + input);
  }
  return input;
}

function isWithinRoot(parent: string, child: string): boolean {
  const fromParent = relative(parent, child).replaceAll("\\", "/");
  return fromParent === "" || (fromParent !== ".." && !fromParent.startsWith("../"));
}

async function parseArchitectureMap(
  repositoryRoot: string,
  value: unknown,
): Promise<ArchitectureMap> {
  if (!plainObject(value)) throw new Error("架构地图必须是对象");
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 4) {
    throw new Error("架构地图只接受当前 schema v4");
  }
  validateShape(
    value,
    [
      "schemaVersion",
      "contractId",
      "contractVersion",
      "projectRoot",
      "boundaryRevision",
      "layers",
      "areas",
      "partitions",
      "floorScopes",
      "features",
      "runtime",
      "maintenancePolicy",
      "boundary",
    ],
    "architecture-map",
  );

  if (
    !Array.isArray(value.layers)
    || !Array.isArray(value.areas)
    || value.layers.length === 0
    || value.layers.length > 16
    || value.areas.length === 0
    || value.areas.length > 64
    || !Array.isArray(value.partitions)
    || value.partitions.length > 64
    || !Array.isArray(value.floorScopes)
    || value.floorScopes.length > 64
    || !Array.isArray(value.features)
    || value.features.length > 32
  ) {
    throw new Error("架构地图核心集合非法");
  }

  const projectRoot = await safeExistingDirectory(
    repositoryRoot,
    value.projectRoot,
    "projectRoot",
  );
  const layerIds = new Set<string>();
  const layerRoots = new Map<string, string>();
  const layers: ArchitectureLayer[] = [];
  for (const [index, entry] of value.layers.entries()) {
    validateShape(
      entry,
      ["id", "root", "responsibility"],
      "layers[" + String(index) + "]",
    );
    const id = boundedLine(entry.id, "layer.id", 40);
    if (!ID_PATTERN.test(id) || layerIds.has(id)) throw new Error("layer.id 非法或重复");
    const root = await safeExistingDirectory(repositoryRoot, entry.root, "layer.root");
    if (!isWithinRoot(projectRoot, root) || root === projectRoot) {
      throw new Error("layer.root 必须位于 projectRoot 内");
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
    validateShape(
      entry,
      [
        "id",
        "parentId",
        "root",
        "responsibility",
        "notResponsibleFor",
        "signals",
        "neighbors",
      ],
      "areas[" + String(index) + "]",
    );
    const id = boundedLine(entry.id, "area.id", 80);
    const parentId = boundedLine(entry.parentId, "area.parentId", 40);
    if (!AREA_ID_PATTERN.test(id) || areaIds.has(id) || !layerIds.has(parentId)) {
      throw new Error("area.id 或 parentId 非法");
    }
    const root = await safeExistingDirectory(repositoryRoot, entry.root, "area.root");
    const parentRoot = layerRoots.get(parentId);
    const relativeToParent = parentRoot ? relative(parentRoot, root).replaceAll("\\", "/") : "";
    if (!parentRoot || !relativeToParent || relativeToParent.includes("/")) {
      throw new Error("area.root 必须是所属 layer 的直接职责目录");
    }
    if (areaRoots.has(root)) throw new Error("area.root 重复：" + root);
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

  const rawPartitions: ArchitecturePartition[] = [];
  const partitionIds = new Set<string>();
  const partitionRoots = new Set<string>();
  const partitionEntries = value.partitions;
  for (const [index, entry] of partitionEntries.entries()) {
    validateShape(
      entry,
      [
        "id",
        "parentId",
        "root",
        "responsibility",
        "notResponsibleFor",
        "signals",
        "neighbors",
      ],
      "partitions[" + String(index) + "]",
    );
    const id = boundedLine(entry.id, "partition.id", 100);
    const parentId = boundedLine(entry.parentId, "partition.parentId", 80);
    const parent = rawAreas.find((area) => area.id === parentId);
    if (!PARTITION_ID_PATTERN.test(id) || partitionIds.has(id) || !parent) {
      throw new Error("partition.id 或 parentId 非法");
    }
    const root = await safeExistingDirectory(repositoryRoot, entry.root, "partition.root");
    if (!isWithinRoot(parent.root, root) || root === parent.root || partitionRoots.has(root)) {
      throw new Error("partition.root 必须唯一、存在且位于所属 area 内");
    }
    partitionIds.add(id);
    partitionRoots.add(root);
    rawPartitions.push({
      id,
      parentId,
      root,
      responsibility: boundedLine(entry.responsibility, "partition.responsibility", 120),
      notResponsibleFor: boundedLines(entry.notResponsibleFor, "notResponsibleFor", 8, 80),
      signals: boundedLines(entry.signals, "signals", 12, 40),
      neighbors: boundedLines(entry.neighbors, "neighbors", 8, 100),
    });
  }
  for (const partition of rawPartitions) {
    if (
      partition.neighbors.some((neighbor) => (
        neighbor === partition.id || !partitionIds.has(neighbor)
      ))
    ) {
      throw new Error("partition.neighbors 包含未知或自身分区：" + partition.id);
    }
  }

  const rawFloorScopes: ArchitectureFloorScope[] = [];
  const floorScopeIds = new Set<string>();
  const floorNumbers = new Set<number>();
  const floorRoots = new Set<string>();
  const floorScopeEntries = value.floorScopes;
  for (const [index, entry] of floorScopeEntries.entries()) {
    validateShape(
      entry,
      [
        "id",
        "floor",
        "roots",
        "responsibility",
        "signals",
        "neighbors",
        "sharedPartitions",
        "contentRefs",
        "serviceRefs",
        "featureRefs",
      ],
      "floorScopes[" + String(index) + "]",
    );
    const id = boundedLine(entry.id, "floorScope.id", 40);
    const idMatch = FLOOR_SCOPE_ID_PATTERN.exec(id);
    const floor = entry.floor;
    if (
      !idMatch
      || typeof floor !== "number"
      || !Number.isInteger(floor)
      || floor < 1
      || floor > 999
      || Number(idMatch[1]) !== floor
      || id !== "floor." + String(floor).padStart(2, "0")
      || floorScopeIds.has(id)
      || floorNumbers.has(floor)
    ) {
      throw new Error("floorScope.id/floor 非法、重复或不一致");
    }
    const rootValues = boundedLines(entry.roots, "floorScope.roots", 8, 240);
    if (rootValues.length === 0) throw new Error("floorScope.roots 不能为空");
    const roots: string[] = [];
    for (const [rootIndex, rootValue] of rootValues.entries()) {
      const root = await safeExistingDirectory(
        repositoryRoot,
        rootValue,
        "floorScope.roots[" + String(rootIndex) + "]",
      );
      const owningArea = rawAreas.find((area) => isWithinRoot(area.root, root) && area.root !== root);
      if (
        !owningArea
        || [...floorRoots, ...roots].some((existingRoot) => (
          root === existingRoot
          || root.startsWith(existingRoot + "/")
          || existingRoot.startsWith(root + "/")
        ))
      ) {
        throw new Error("floorScope.root 必须唯一、存在且位于已登记 area 内：" + root);
      }
      roots.push(root);
    }
    floorScopeIds.add(id);
    floorNumbers.add(floor);
    roots.forEach((root) => floorRoots.add(root));
    rawFloorScopes.push({
      id,
      floor,
      roots,
      responsibility: boundedLine(entry.responsibility, "floorScope.responsibility", 120),
      signals: boundedLines(entry.signals, "floorScope.signals", 12, 40),
      neighbors: boundedLines(entry.neighbors, "floorScope.neighbors", 2, 40),
      sharedPartitions: boundedLines(
        entry.sharedPartitions,
        "floorScope.sharedPartitions",
        12,
        100,
      ),
      contentRefs: boundedLines(entry.contentRefs, "floorScope.contentRefs", 12, 100),
      serviceRefs: boundedLines(entry.serviceRefs, "floorScope.serviceRefs", 12, 100),
      featureRefs: boundedLines(entry.featureRefs, "floorScope.featureRefs", 12, 100),
    });
  }

  const stableAreaReferences = new Set([...areaIds, ...partitionIds]);
  for (const floorScope of rawFloorScopes) {
    for (const neighborId of floorScope.neighbors) {
      const neighbor = rawFloorScopes.find((candidate) => candidate.id === neighborId);
      if (!neighbor || neighbor.id === floorScope.id || Math.abs(neighbor.floor - floorScope.floor) !== 1) {
        throw new Error("floorScope.neighbors 只能引用相邻楼层：" + floorScope.id);
      }
    }
    if (floorScope.sharedPartitions.some((partitionId) => !partitionIds.has(partitionId))) {
      throw new Error("floorScope.sharedPartitions 包含未知 partition：" + floorScope.id);
    }
    if (
      floorScope.contentRefs.some((reference) => !stableAreaReferences.has(reference))
      || floorScope.serviceRefs.some((reference) => !stableAreaReferences.has(reference))
    ) {
      throw new Error("floorScope content/service 引用未知稳定区域：" + floorScope.id);
    }
    for (const partitionId of floorScope.sharedPartitions) {
      const partition = rawPartitions.find((candidate) => candidate.id === partitionId);
      if (partition && floorScope.roots.some((root) => (
        root === partition.root
        || root.startsWith(partition.root + "/")
        || partition.root.startsWith(root + "/")
      ))) {
        throw new Error("floorScope 与 shared partition 目录不能重叠：" + floorScope.id);
      }
    }
  }

  const stableReferences = new Set([
    ...areaIds,
    ...partitionIds,
    ...floorScopeIds,
  ]);
  const rawFeatures: ArchitectureFeature[] = [];
  const featureIds = new Set<string>();
  const featureEntries = value.features;
  for (const [index, rawFeature] of featureEntries.entries()) {
    validateShape(
      rawFeature,
      [
        "id",
        "roots",
        "responsibility",
        "notResponsibleFor",
        "signals",
        "negativeSignals",
        "neighbors",
        "route",
        "contentRefs",
        "serviceProviders",
      ],
      "features[" + String(index) + "]",
    );
    const id = boundedLine(rawFeature.id, "feature.id", 100);
    if (!FEATURE_ID_PATTERN.test(id) || featureIds.has(id)) {
      throw new Error("feature.id 非法或重复");
    }
    const roots = boundedLines(rawFeature.roots, "feature.roots", 12, 100);
    if (roots.length === 0 || roots.some((reference) => !stableReferences.has(reference))) {
      throw new Error("feature.roots 包含未知引用");
    }
    validateShape(
      rawFeature.route,
      ["primary", "adjacent", "shared", "fallback"],
      "feature.route",
    );
    const route: ArchitectureFeatureRoute = {
      primary: boundedLines(rawFeature.route.primary, "feature.route.primary", 8, 100),
      adjacent: boundedLines(rawFeature.route.adjacent, "feature.route.adjacent", 8, 100),
      shared: boundedLines(rawFeature.route.shared, "feature.route.shared", 8, 100),
      fallback: boundedLines(rawFeature.route.fallback, "feature.route.fallback", 8, 100),
    };
    const routeReferences = [
      ...route.primary,
      ...route.adjacent,
      ...route.shared,
      ...route.fallback,
    ];
    if (
      route.primary.length === 0
      || routeReferences.some((reference) => !stableReferences.has(reference))
      || routeReferences.some((reference) => !roots.includes(reference))
    ) {
      throw new Error("feature.route 必须引用自身 roots 中的有效稳定 ID");
    }
    const neighbors = boundedLines(rawFeature.neighbors, "feature.neighbors", 8, 100);
    const contentRefs = boundedLines(rawFeature.contentRefs, "feature.contentRefs", 8, 100);
    const serviceProviders = boundedLines(
      rawFeature.serviceProviders,
      "feature.serviceProviders",
      8,
      100,
    );
    if (
      neighbors.some((reference) => !stableReferences.has(reference))
      || contentRefs.some((reference) => !stableAreaReferences.has(reference))
      || serviceProviders.some((reference) => !stableAreaReferences.has(reference))
    ) {
      throw new Error("feature 邻接、内容或服务引用未知稳定 ID");
    }
    const signals = boundedLines(rawFeature.signals, "feature.signals", 16, 60);
    if (signals.length === 0) throw new Error("feature.signals 不能为空");
    featureIds.add(id);
    rawFeatures.push({
      id,
      roots,
      responsibility: boundedLine(rawFeature.responsibility, "feature.responsibility", 160),
      notResponsibleFor: boundedLines(
        rawFeature.notResponsibleFor,
        "feature.notResponsibleFor",
        8,
        80,
      ),
      signals,
      negativeSignals: boundedLines(
        rawFeature.negativeSignals,
        "feature.negativeSignals",
        8,
        60,
      ),
      neighbors,
      route,
      contentRefs,
      serviceProviders,
    });
  }
  for (const floorScope of rawFloorScopes) {
    if (floorScope.featureRefs.some((featureId) => !featureIds.has(featureId))) {
      throw new Error("floorScope.featureRefs 包含未知 feature：" + floorScope.id);
    }
  }

  const contractId = boundedLine(value.contractId, "contractId", 100);
  if (!/^[a-z][a-z0-9.-]+$/u.test(contractId)) throw new Error("contractId 非法");
  if (
    typeof value.contractVersion !== "number"
    || !Number.isInteger(value.contractVersion)
    || value.contractVersion < 1
    || typeof value.boundaryRevision !== "number"
    || !Number.isInteger(value.boundaryRevision)
    || value.boundaryRevision < 1
  ) {
    throw new Error("contractVersion/boundaryRevision 非法");
  }

  validateShape(
    value.runtime,
    ["sourceRoot", "bridgeProtocol", "adapterVersion", "supportedCapabilities"],
    "runtime",
  );
  const sourceRoot = await safeExistingDirectory(
    repositoryRoot,
    value.runtime.sourceRoot,
    "runtime.sourceRoot",
  );
  if (!isWithinRoot(projectRoot, sourceRoot)) {
    throw new Error("runtime.sourceRoot 必须位于 projectRoot 内");
  }
  if (
    value.runtime.bridgeProtocol !== 3
    || value.runtime.adapterVersion !== 2
  ) {
    throw new Error("runtime 只接受 bridgeProtocol 3 和 adapterVersion 2");
  }
  const runtime: ArchitectureRuntimeContract = {
    sourceRoot,
    bridgeProtocol: 3,
    adapterVersion: 2,
    supportedCapabilities: boundedLines(
      value.runtime.supportedCapabilities,
      "runtime.supportedCapabilities",
      16,
      60,
    ),
  };

  validateShape(
    value.maintenancePolicy,
    [
      "ordinaryFile",
      "internalDirectory",
      "rootMoveOrRename",
      "areaPartitionChange",
      "responsibilityOrRouteChange",
      "invalidCore",
    ],
    "maintenancePolicy",
  );
  const maintenancePolicy: ArchitectureMaintenancePolicy = {
    ordinaryFile: value.maintenancePolicy.ordinaryFile === "no-update"
      ? "no-update" : (() => { throw new Error("maintenancePolicy.ordinaryFile 非法"); })(),
    internalDirectory: value.maintenancePolicy.internalDirectory === "no-update"
      ? "no-update" : (() => { throw new Error("maintenancePolicy.internalDirectory 非法"); })(),
    rootMoveOrRename: value.maintenancePolicy.rootMoveOrRename === "update"
      ? "update" : (() => { throw new Error("maintenancePolicy.rootMoveOrRename 非法"); })(),
    areaPartitionChange: value.maintenancePolicy.areaPartitionChange === "update"
      ? "update" : (() => { throw new Error("maintenancePolicy.areaPartitionChange 非法"); })(),
    responsibilityOrRouteChange: value.maintenancePolicy.responsibilityOrRouteChange === "update"
      ? "update" : (() => {
        throw new Error("maintenancePolicy.responsibilityOrRouteChange 非法");
      })(),
    invalidCore: value.maintenancePolicy.invalidCore === "fallback"
      ? "fallback" : (() => { throw new Error("maintenancePolicy.invalidCore 非法"); })(),
  };

  validateShape(
    value.boundary,
    ["algorithm", "signature"],
    "boundary",
  );
  if (
    value.boundary.algorithm !== "direct-child-v1"
    || typeof value.boundary.signature !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.boundary.signature)
  ) {
    throw new Error("boundary 非法");
  }
  const boundary: ArchitectureBoundary = {
    algorithm: "direct-child-v1",
    signature: value.boundary.signature,
  };

  return {
    schemaVersion,
    projectRoot,
    contractId,
    contractVersion: value.contractVersion,
    boundaryRevision: value.boundaryRevision,
    layers,
    areas: rawAreas,
    partitions: rawPartitions,
    floorScopes: rawFloorScopes,
    features: rawFeatures,
    runtime,
    maintenancePolicy,
    boundary,
  };
}

/**
 * 读取固定地图。
 *
 * 任意 schema 错误转换为可显示警告并回退普通搜索。
 */
export async function loadArchitectureMap(
  repositoryRoot: string,
): Promise<ArchitectureMapLoadResult> {
  try {
    const repositoryRealPath = await realpath(repositoryRoot);
    const mapPath = resolve(repositoryRoot, ARCHITECTURE_MAP_PATH);
    const mapInformation = await lstat(mapPath);
    if (
      !mapInformation.isFile()
      || mapInformation.isSymbolicLink()
      || mapInformation.size > MAX_MAP_BYTES
    ) {
      throw new Error("architecture-map.json 必须是有限大小的普通文件");
    }
    const mapRealPath = await realpath(mapPath);
    if (!isInside(repositoryRealPath, mapRealPath)) {
      throw new Error("architecture-map.json 已脱离仓库");
    }
    const raw: unknown = JSON.parse(await readFile(mapRealPath, "utf8"));
    const map = await parseArchitectureMap(repositoryRoot, raw);
    return {
      map,
      warning: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    return {
      map: null,
      warning: "区域职责地图不可用，已回退普通搜索：" + reason.slice(0, 240),
    };
  }
}

interface RankedEntry<T> {
  entry: T;
  order: number;
  matches: string[];
  score: number;
}

function rankEntries<T extends { signals: string[]; negativeSignals?: string[] }>(
  entries: readonly T[],
  normalizedRequest: string,
): Array<RankedEntry<T>> {
  return entries.map((entry, order) => {
    const negativeMatched = entry.negativeSignals?.some((signal) => (
      normalizedRequest.includes(signal.toLocaleLowerCase("zh-CN"))
    )) ?? false;
    const matches = negativeMatched
      ? []
      : entry.signals.filter((signal) => (
        normalizedRequest.includes(signal.toLocaleLowerCase("zh-CN"))
      ));
    return {
      entry,
      order,
      matches,
      score: matches.length === 0
        ? 0
        : Math.max(...matches.map((signal) => 1_000 + signal.length)) + matches.length,
    };
  }).filter((entry) => entry.score > 0).sort((left, right) => (
    right.score - left.score || left.order - right.order
  ));
}

function uniqueById<T extends { id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/** 把 area、partition 或 floor 稳定引用解析为一个或多个目录 root。 */
export function architectureReferenceRoots(
  map: ArchitectureMap | null,
  references: readonly string[],
): string[] {
  if (!map) return [];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const area = map.areas.find((candidate) => candidate.id === reference);
    const partition = map.partitions.find((candidate) => candidate.id === reference);
    const floorScope = map.floorScopes.find((candidate) => candidate.id === reference);
    const values = floorScope?.roots ?? (partition ? [partition.root] : area ? [area.root] : []);
    for (const value of values) {
      if (seen.has(value)) continue;
      seen.add(value);
      roots.push(value);
    }
  }
  return roots;
}

function owningAreaIdsForReferences(
  map: ArchitectureMap,
  references: readonly string[],
): string[] {
  const output = new Set<string>();
  for (const reference of references) {
    const area = map.areas.find((candidate) => candidate.id === reference);
    if (area) {
      output.add(area.id);
      continue;
    }
    const partition = map.partitions.find((candidate) => candidate.id === reference);
    if (partition) {
      output.add(partition.parentId);
      continue;
    }
    const floorScope = map.floorScopes.find((candidate) => candidate.id === reference);
    if (!floorScope) continue;
    for (const candidate of map.areas) {
      if (floorScope.roots.some((root) => isWithinRoot(candidate.root, root))) {
        output.add(candidate.id);
      }
    }
  }
  return [...output];
}

/** 根据功能意图、楼层上下文和区域信号选择稳定搜索范围；不调用模型。 */
export function routeArchitecture(
  map: ArchitectureMap | null,
  request: string,
  activeFloor: number | null = null,
): ArchitectureRoute | null {
  if (!map) return null;
  const normalized = request.toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;

  const rankedFeatures = rankEntries(map.features, normalized);
  const strongestFeatureScore = rankedFeatures[0]?.score ?? 0;
  // 没有任何正向信号时不能把所有 feature 当作同分主路由，否则一次普通请求会
  // 展开整张地图并抵消分区路由的 Token/时间收益。
  const primaryFeatures = strongestFeatureScore > 0
    ? rankedFeatures
      .filter((entry) => entry.score >= strongestFeatureScore - 2 && entry.score > 0)
      .slice(0, 2)
      .map((entry) => entry.entry)
    : [];
  const rankedFloorScopes = rankEntries(map.floorScopes, normalized);
  const rankedPartitions = rankEntries(map.partitions, normalized);
  const rankedAreas = rankEntries(map.areas, normalized);
  const activeFloorScope = activeFloor === null
    ? null
    : map.floorScopes.find((scope) => scope.floor === activeFloor) ?? null;

  // 功能意图是主路由；显式楼层信号仍保留为后续上下文，实时楼层只在没有更具体意图时兜底。
  const currentFloorScope = rankedFloorScopes[0]?.entry
    ?? (
      primaryFeatures.length === 0
      && rankedPartitions.length === 0
      && rankedAreas.length === 0
        ? activeFloorScope
        : null
    );
  if (
    primaryFeatures.length === 0
    && !currentFloorScope
    && rankedPartitions.length === 0
    && rankedAreas.length === 0
  ) return null;

  const neighborFloorIds = new Set(currentFloorScope?.neighbors ?? []);
  const neighborFloorScopes = map.floorScopes.filter((scope) => neighborFloorIds.has(scope.id));
  const sharedPartitionIds = new Set(currentFloorScope?.sharedPartitions ?? []);
  const sharedPartitions = map.partitions.filter((partition) => sharedPartitionIds.has(partition.id));

  const featurePrimaryReferences = primaryFeatures.flatMap((feature) => feature.route.primary);
  const featureAdjacentReferences = primaryFeatures.flatMap((feature) => feature.route.adjacent);
  const featureSharedReferences = primaryFeatures.flatMap((feature) => feature.route.shared);
  const featureFallbackReferences = primaryFeatures.flatMap((feature) => feature.route.fallback);
  const featurePartitionIds = new Set([
    ...featurePrimaryReferences,
    ...featureAdjacentReferences,
  ]);
  const primaryPartitions = uniqueById([
    ...map.partitions.filter((partition) => featurePartitionIds.has(partition.id)),
    ...rankedPartitions.slice(0, 2).map((entry) => entry.entry),
  ]);
  const primaryPartitionIds = new Set(primaryPartitions.map((partition) => partition.id));
  const neighborPartitionIds = new Set(primaryPartitions.flatMap((partition) => partition.neighbors));
  const neighborPartitions = map.partitions.filter((partition) => (
    neighborPartitionIds.has(partition.id) && !primaryPartitionIds.has(partition.id)
  ));

  const owningAreaIds = new Set([
    ...owningAreaIdsForReferences(map, [
      ...featurePrimaryReferences,
      ...featureAdjacentReferences,
      ...featureSharedReferences,
      ...featureFallbackReferences,
    ]),
    ...primaryPartitions.map((partition) => partition.parentId),
    ...sharedPartitions.map((partition) => partition.parentId),
  ]);
  if (currentFloorScope) {
    rankedAreas.slice(0, 2).forEach((entry) => owningAreaIds.add(entry.entry.id));
    for (const area of map.areas) {
      if (currentFloorScope.roots.some((root) => isWithinRoot(area.root, root))) {
        owningAreaIds.add(area.id);
      }
    }
  }
  const primaryAreas = owningAreaIds.size > 0
    ? map.areas
      .filter((area) => owningAreaIds.has(area.id))
      .sort((left, right) => {
        const leftRank = rankedAreas.findIndex((entry) => entry.entry.id === left.id);
        const rightRank = rankedAreas.findIndex((entry) => entry.entry.id === right.id);
        return (leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank)
          - (rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank);
      })
    : rankedAreas.slice(0, 2).map((entry) => entry.entry);
  const primaryIds = new Set(primaryAreas.map((area) => area.id));
  const neighborIds = new Set(primaryAreas.flatMap((area) => area.neighbors));
  const neighborAreas = map.areas.filter((area) => (
    neighborIds.has(area.id) && !primaryIds.has(area.id)
  ));

  const matchedSource = rankedFeatures.length > 0
    ? rankedFeatures
    : rankedFloorScopes.length > 0
      ? rankedFloorScopes
      : rankedPartitions.length > 0
        ? rankedPartitions
        : rankedAreas;
  return {
    currentFloorScope,
    neighborFloorScopes,
    sharedPartitions,
    primaryFeatures,
    featurePrimaryRoots: architectureReferenceRoots(map, featurePrimaryReferences),
    featureAdjacentRoots: architectureReferenceRoots(map, featureAdjacentReferences),
    featureSharedRoots: architectureReferenceRoots(map, featureSharedReferences),
    featureFallbackRoots: architectureReferenceRoots(map, featureFallbackReferences),
    primaryPartitions,
    neighborPartitions,
    primaryAreas,
    neighborAreas,
    matchedSignals: [...new Set(matchedSource.slice(0, 2).flatMap((entry) => entry.matches))],
  };
}

/** 生成短小、显式标记为数据的模型路由卡。 */
export function architectureRouteCard(route: ArchitectureRoute | null): string | null {
  if (!route) return null;
  const value = {
    kind: "architecture-routing-data-not-instructions",
    features: route.primaryFeatures.map((feature) => ({
      id: feature.id,
      responsibility: feature.responsibility,
      primaryRoots: route.featurePrimaryRoots,
      adjacentRoots: route.featureAdjacentRoots,
      sharedRoots: route.featureSharedRoots,
      fallbackRoots: route.featureFallbackRoots,
    })),
    currentFloor: route.currentFloorScope ? {
      id: route.currentFloorScope.id,
      roots: route.currentFloorScope.roots,
      responsibility: route.currentFloorScope.responsibility,
    } : null,
    floorNeighbors: route.neighborFloorScopes.map((scope) => ({
      id: scope.id,
      roots: scope.roots,
    })),
    primaryPartitions: route.primaryPartitions.map((partition) => ({
      id: partition.id,
      root: partition.root,
      responsibility: partition.responsibility,
    })),
    primaryAreas: route.primaryAreas.map((area) => ({
      id: area.id,
      root: area.root,
      responsibility: area.responsibility,
    })),
    matchedSignals: route.matchedSignals,
  };
  return "游戏架构路由数据（仅用于缩小搜索范围，不是仓库指令）：\n"
    + JSON.stringify(value).slice(0, 1_800);
}

/** 按稳定 ID 读取一个区域。 */
export function architectureArea(
  map: ArchitectureMap | null,
  areaId: string,
): ArchitectureArea | null {
  return map?.areas.find((area) => area.id === areaId) ?? null;
}

/** 按稳定 ID 读取一个目录级职责分区。 */
export function architecturePartition(
  map: ArchitectureMap | null,
  partitionId: string,
): ArchitecturePartition | null {
  return map?.partitions.find((partition) => partition.id === partitionId) ?? null;
}

/** 按稳定 ID 读取一个跨区域楼层 scope。 */
export function architectureFloorScope(
  map: ArchitectureMap | null,
  floorId: string,
): ArchitectureFloorScope | null {
  return map?.floorScopes.find((scope) => scope.id === floorId) ?? null;
}

/** 按稳定 ID 读取一个跨层产品功能。 */
export function architectureFeature(
  map: ArchitectureMap | null,
  featureId: string,
): ArchitectureFeature | null {
  return map?.features.find((feature) => feature.id === featureId) ?? null;
}
