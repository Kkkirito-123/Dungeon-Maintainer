/**
 * 启动编排公开入口。
 *
 * 具体实现已按职责拆到 `src/app/`：仓库事实、Pi 进程、任务生命周期、start 和 resume
 * 各自拥有独立文件。本入口只重新导出 CLI 和测试需要的启动接口；它不新增业务逻辑，
 * 也不产生文件系统或进程副作用。
 */

export {
  inspectDungeonRepository,
  verifyRuntimeDependencies,
  type DungeonProjectMarker,
} from "./app/repository.js";
export {
  buildPiArguments,
  resolvePiCliPath,
  runPiProcess,
  verifyPiSession,
} from "./app/pi-process.js";
export { startMaintainer } from "./app/start.js";
export { resumeMaintainer } from "./app/resume.js";
