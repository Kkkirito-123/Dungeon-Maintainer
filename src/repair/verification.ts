/**
 * 轻量候选检查、浏览器重放和可应用补丁封装。
 *
 * verification 是 ready_to_apply 的唯一入口。它只运行变更列表中直接修改的测试，以及
 * 直接修改架构检查脚本时的对应检查；不扩展到相关测试或完整构建。有活动复现时
 * 必须从原检查点刷新并完整重放。全部通过后才生成补丁、记录正式仓库 baseHash，并把验证
 * 绑定最终 worktree Hash。完整质量门仅由 publish 在发布前执行。
 */

import { appendEvent } from "../logging/events.js";
import { verificationEvidence } from "../evidence/projector.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord, VerificationRecord } from "../task/types.js";
import type { GameDriver } from "../game/driver.js";
import { capturePatch } from "../workspace/apply.js";
import { syncWorktreeChanges } from "../workspace/changes.js";
import { hashWorktree } from "../workspace/git.js";
import { assertChangedPathsWithinApprovedScope } from "../workspace/write-scope.js";
import {
  requiredChecks,
  formatCheckFailure,
  runCheck,
  type CheckId,
} from "../workspace/check.js";
import type { ProgressLine } from "../progress/reporter.js";
import {
  readActiveReproduction,
  type ReproductionRecord,
} from "./reproduction.js";
import { cachedSuccessfulReplay, replayReproduction } from "./replay.js";

/** /verify 和 finish ready 的完整结果。 */
export interface VerificationResult {
  record: VerificationRecord;
  patchPath: string;
  changedPaths: string[];
}

function checksForTask(task: TaskRecord): CheckId[] {
  return requiredChecks(task.changedPaths);
}

/**
 * 执行轻量任务验证并封装补丁。
 *
 * @param store 当前任务存储。
 * @param task 当前活动任务。
 * @param driver 当前浏览器驱动；纯静态问题允许为 null。
 * @param signal 用户取消信号。
 * @returns 绑定最终 Hash 的 VerificationRecord 与补丁位置；完整质量门仅由 publish 执行。
 */
export async function verifyTask(
  store: TaskStore,
  evidence: EvidenceStore,
  task: TaskRecord,
  driver: GameDriver | null,
  signal?: AbortSignal,
  onProgress?: ProgressLine,
): Promise<VerificationResult> {
  onProgress?.("同步 worktree 变更");
  // edit 的写后元数据可能在进程中断前尚未持久化；验证前以 Git 事实同步变化，确保候选
  // 检查、补丁封装和 apply 看到同一组文件，而不是依赖模型是否主动登记路径。
  await syncWorktreeChanges(store, task, "verify", evidence);
  if (task.changedPaths.length === 0) {
    throw new Error("任务 worktree 没有代码变化");
  }
  task.changedPaths = assertChangedPathsWithinApprovedScope(
    task,
    task.changedPaths,
  );
  if (task.state === "ready_to_apply") await store.transition(task, "active");
  if (task.state === "active") await store.transition(task, "verifying");
  if (task.state !== "verifying") {
    throw new Error("当前任务状态不能执行验证");
  }

  const reproduction = await readActiveReproduction(store, evidence, task);
  const checkIds = checksForTask(task);
  onProgress?.("候选检查：" + (checkIds.length > 0 ? checkIds.join("、") : "无直接测试文件"));
  for (const id of checkIds) {
    const result = await runCheck(
      store,
      evidence,
      task,
      id,
      signal,
      onProgress ? { onOutput: onProgress } : {},
    );
    if (result.record.status !== "passed") {
      throw new Error(formatCheckFailure(result));
    }
  }

  let replayPassed = true;
  const usedReproduction: ReproductionRecord | null = reproduction;
  if (usedReproduction) {
    onProgress?.("刷新浏览器检查点并重放复现：" + usedReproduction.id);
    const replayHash = await hashWorktree(task.worktreeRoot);
    const cached = cachedSuccessfulReplay(task, usedReproduction, replayHash);
    if (!cached && !driver) throw new Error("活动复现需要可用的游戏浏览器才能验证");
    const replay = cached ?? await replayReproduction(
      store, task, driver as GameDriver, usedReproduction, replayHash,
    );
    replayPassed = replay.passed;
    if (!replayPassed) {
      throw new Error(
        "复现动作或结果断言失败："
        + (replay.failure ?? "未知浏览器错误"),
      );
    }
    onProgress?.("复现重放通过");
  }

  onProgress?.("封装补丁并校验变更路径");
  const captured = await capturePatch(task, store.taskDir(task.id));
  const expected = [...task.changedPaths].sort();
  const actual = [...captured.paths].sort();
  if (expected.join("\n") !== actual.join("\n")) {
    throw new Error("worktree 在验证期间又发生了变化");
  }
  task.changedPaths = actual;
  task.baseHashes = captured.baseHashes;
  task.patchPath = captured.patchPath;
  task.reversePatchPath = captured.reversePatchPath;
  const worktreeHash = await hashWorktree(task.worktreeRoot);
  onProgress?.("绑定 worktree Hash：" + worktreeHash.slice(0, 12));
  const record: VerificationRecord = {
    worktreeHash,
    checkIds,
    reproductionId: usedReproduction?.id ?? null,
    replayPassed,
    verifiedAt: new Date().toISOString(),
  };
  task.verification = record;
  await store.transition(task, "ready_to_apply");
  const activeEvidence = await evidence.active();
  const links = activeEvidence.filter((item) => (
    (item.kind === "change" && item.worktreeHash === worktreeHash)
    || (item.kind === "check" && item.worktreeHash === worktreeHash)
    || (
      item.kind === "reproduction"
      && usedReproduction
      && item.metadata.reproductionId === usedReproduction.id
    )
  )).map((item) => item.id);
  await evidence.capture(verificationEvidence(record, links));
  await appendEvent(store, task.id, "verification.passed", {
    worktreeHash: worktreeHash.slice(0, 12),
    checkCount: checkIds.length,
    replayPassed,
  });
  onProgress?.("验证记录已保存，候选补丁就绪");
  return {
    record,
    patchPath: captured.patchPath,
    changedPaths: task.changedPaths,
  };
}
