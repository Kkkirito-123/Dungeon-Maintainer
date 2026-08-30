/** Maintainer Eval 的事件遥测投影。 */

import { readFile } from "node:fs/promises";

export interface MaintainerTelemetry {
  executions: number;
  receiptHits: number;
  semanticEvidenceHits: number;
  bundles: number;
  bundleWindows: number;
  inspectCandidateFiles: number;
  inspectSelectedFiles: number;
  inspectFailures: number;
  writeRejected: number;
  writeFailures: number;
  writeNoops: number;
  writeMutations: number;
  writeReplayFailures: number;
  parseErrors: number;
  firstMutationAt: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function emptyTelemetry(): MaintainerTelemetry {
  return {
    executions: 0,
    receiptHits: 0,
    semanticEvidenceHits: 0,
    bundles: 0,
    bundleWindows: 0,
    inspectCandidateFiles: 0,
    inspectSelectedFiles: 0,
    inspectFailures: 0,
    writeRejected: 0,
    writeFailures: 0,
    writeNoops: 0,
    writeMutations: 0,
    writeReplayFailures: 0,
    parseErrors: 0,
    firstMutationAt: null,
  };
}

function recordMutationAt(telemetry: MaintainerTelemetry, event: Record<string, unknown>): void {
  const at = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
  if (!Number.isFinite(at)) return;
  telemetry.firstMutationAt = telemetry.firstMutationAt === null
    ? at
    : Math.min(telemetry.firstMutationAt, at);
}

/** 从 Maintainer 事件 JSONL 构造低敏遥测，不暴露事件正文。 */
export async function readMaintainerTelemetry(eventsPath: string): Promise<MaintainerTelemetry> {
  const telemetry = emptyTelemetry();
  let rows: string[];
  try {
    rows = (await readFile(eventsPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") telemetry.parseErrors += 1;
    return telemetry;
  }
  for (const row of rows) {
    try {
      const event = record(JSON.parse(row));
      if (!event || typeof event.type !== "string") {
        telemetry.parseErrors += 1;
        continue;
      }
      const detail = record(event.detail);
      if (event.type === "tool.patch" || event.type === "worktree.native_change") {
        recordMutationAt(telemetry, event);
      }
      if (event.type === "tool.inspect") {
        const outcome = detail?.outcome;
        if (outcome !== "execution" && outcome !== "receipt" && outcome !== "failure") {
          telemetry.parseErrors += 1;
          continue;
        }
        if (outcome === "receipt") telemetry.receiptHits += 1;
        else if (outcome === "failure") telemetry.inspectFailures += 1;
        else telemetry.executions += 1;
        if (detail?.cacheKind === "semantic") telemetry.semanticEvidenceHits += 1;
        if (outcome === "execution" && detail?.action === "bundle") {
          telemetry.bundles += 1;
          if (typeof detail.bundleWindows === "number") {
            telemetry.bundleWindows += Math.max(0, Math.floor(detail.bundleWindows));
          }
          if (typeof detail.candidateFiles === "number") {
            telemetry.inspectCandidateFiles += Math.max(0, Math.floor(detail.candidateFiles));
          }
          if (typeof detail.selectedFiles === "number") {
            telemetry.inspectSelectedFiles += Math.max(0, Math.floor(detail.selectedFiles));
          }
        }
      } else if (event.type === "tool.write_outcome") {
        const outcome = detail?.outcome;
        if (outcome === "rejected") telemetry.writeRejected += 1;
        else if (outcome === "failed") telemetry.writeFailures += 1;
        else if (outcome === "noop") telemetry.writeNoops += 1;
        else if (outcome === "mutated" || outcome === "mutated_replay_failed") {
          telemetry.writeMutations += 1;
          if (outcome === "mutated_replay_failed") telemetry.writeReplayFailures += 1;
          recordMutationAt(telemetry, event);
        } else {
          telemetry.parseErrors += 1;
        }
      }
    } catch {
      telemetry.parseErrors += 1;
    }
  }
  return telemetry;
}
