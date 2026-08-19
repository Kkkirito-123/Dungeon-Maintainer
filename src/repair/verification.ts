/**
 * 固定检查、浏览器重放和可应用补丁封装。
 *
 * verification 是 ready_to_apply 的唯一入口。它先确认任务存在复现用例或历史失败
 * 检查证据，再运行当前变更路径要求的固定检查；有活动复现时必须从原检查点刷新并
 * 完整重放。全部通过后才生成补丁、记录正式仓库 baseHash，并把验证绑定最终
 * worktree Hash。代码任意变化都会让 /apply 拒绝。
 */

import { appendEvent } from "../logging/events.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord, VerificationRecord } from "../task/types.js";
import type { GameDriver } from "../game/driver.js";
import { capturePatch } from "../workspace/apply.js";
import { hashWorktree } from "../workspace/git.js";
import {
  requiredChecks,
  runCheck,
  type CheckId,
} from "../workspace/check.js";
import {
  readActiveReproduction,
  type ReproductionRecord,
} from "./reproduction.js";
import { replayReproduction } from "./replay.js";

/** /verify 和 finish ready 的完整结果。 */
export interface VerificationResult {
  record: VerificationRecord;
  patchPath: string;
  changedPaths: string[];
}

function checksForTask(task: TaskRecord): CheckId[] {
  const required = requiredChecks(task.changedPaths);
  return required.length > 0 ? required : ["rules-validate"];
}

/**
 * 执行完整任务验证并封装补丁。
 *
 * @param store 当前任务存储。
 * @param task 当前活动任务。
 * @param driver 当前浏览器驱动；纯静态问题允许为 null。
 * @param signal 用户取消信号。
 * @returns 绑定最终 Hash 的 VerificationRecord 与补丁位置。
 */
export async function verifyTask(
  store: TaskStore,
  task: TaskRecord,
  driver: GameDriver | null,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  if (task.changedPaths.length === 0) {
    throw new Error("任务没有通过 patch 工具记录的代码变化");
  }
  if (task.state === "ready_to_apply") await store.transition(task, "active");
  if (task.state === "active") await store.transition(task, "verifying");
  if (task.state !== "verifying") {
    throw new Error("当前任务状态不能执行验证");
  }

  const reproduction = await readActiveReproduction(store, task);
  const hasStaticFailureEvidence = task.checks.some(
    (record) => record.status !== "passed",
  );
  if (!reproduction && !hasStaticFailureEvidence) {
    throw new Error("运行问题需要已保存复现；静态问题需要至少一次失败检查证据");
  }

  const checkIds = checksForTask(task);
  for (const id of checkIds) {
    const result = await runCheck(store, task, id, signal);
    if (result.record.status !== "passed") {
      throw new Error("固定检查未通过：" + id);
    }
  }

  let replayPassed = true;
  const usedReproduction: ReproductionRecord | null = reproduction;
  if (usedReproduction) {
    if (!driver) {
      throw new Error("活动复现需要可用的游戏浏览器才能验证");
    }
    const replay = await replayReproduction(
      store,
      task,
      driver,
      usedReproduction,
    );
    replayPassed = replay.passed;
    if (!replayPassed) {
      throw new Error(
        "复现动作重放失败："
        + (replay.failure ?? "未知浏览器错误"),
      );
    }
  }

  const captured = await capturePatch(task, store.taskDir(task.id));
  const expected = [...task.changedPaths].sort();
  const actual = [...captured.paths].sort();
  if (expected.join("\n") !== actual.join("\n")) {
    throw new Error("worktree 包含未经过 patch 工具登记的文件变化");
  }
  task.changedPaths = actual;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  const worktreeHash = await hashWorktree(task.worktreeRoot);
  const record: VerificationRecord = {
    worktreeHash,
    checkIds,
    reproductionId: usedReproduction?.id ?? null,
    replayPassed,
    verifiedAt: new Date().toISOString(),
  };
  task.verification = record;
  await store.transition(task, "ready_to_apply");
  await appendEvent(store, task.id, "verification.passed", {
    worktreeHash: worktreeHash.slice(0, 12),
    checkCount: checkIds.length,
    replayPassed,
  });
  return {
    record,
    patchPath: captured.patchPath,
    changedPaths: task.changedPaths,
  };
}
