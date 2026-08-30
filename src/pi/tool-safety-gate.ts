/**
 * Pi 写入工具的确定性安全门。
 *
 * 本模块只负责三件事：解析本次写入目标、取得一次精确文件范围授权、在执行前再次
 * 校验 allowedPaths 与 realpath 边界。它不终止 Agent 请求，也不建立刷新检查点；
 * 因此用户拒绝、非法路径或授权存储失败都只阻止当前工具调用。
 */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendEvent } from "../logging/events.js";
import { redactText } from "../logging/redact.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { resolveProjectPath } from "../workspace/policy.js";
import {
  assertWritePathAllowed,
  validateWriteScopePaths,
} from "../workspace/write-scope.js";

export interface ToolSafetyBlock {
  kind: "block";
  reason: string;
  reasonCode:
    | "authorization-denied"
    | "authorization-unavailable"
    | "path-rejected";
}

export type ToolSafetyDecision = { kind: "allow" } | ToolSafetyBlock;

interface ToolSafetyGateOptions {
  task: TaskRecord;
  store: TaskStore;
  isExecutionApproved(): boolean;
  approveExecution(): void;
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "未知安全错误";
  return redactText(message).replace(/\s+/gu, " ").trim().slice(0, 400)
    || "未知安全错误";
}

async function requestedWritePaths(
  task: TaskRecord,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<string[]> {
  if (toolName !== "edit" || !Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("edit 缺少合法 edits。");
  }
  const paths = input.edits.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("edit 缺少合法 edits。");
    }
    const path = (value as Record<string, unknown>).path;
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("edit 缺少合法项目相对路径。");
    }
    return path;
  });
  return await validateWriteScopePaths(task.worktreeRoot, paths);
}

async function approvedPathFailure(
  task: TaskRecord,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  if (toolName !== "edit" || !Array.isArray(input.edits)) return "edit 缺少合法 edits。";
  for (const value of input.edits) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "edit 缺少合法 edits。";
    }
    const path = (value as Record<string, unknown>).path;
    if (typeof path !== "string" || !path.trim()) {
      return "edit 缺少合法项目相对路径。";
    }
    try {
      const scoped = assertWritePathAllowed(task, path);
      await resolveProjectPath(task.worktreeRoot, scoped, "write");
    } catch (error) {
      return safeFailure(error);
    }
  }
  return null;
}

/**
 * 单任务写入安全门。实例与 Extension 生命周期一致，不保存额外授权副本。
 * TaskRecord 中的 writeScope 始终是唯一权威事实。
 */
export class ToolSafetyGate {
  private readonly task: TaskRecord;
  private readonly store: TaskStore;
  private readonly isExecutionApproved: () => boolean;
  private readonly approveExecution: () => void;

  constructor(options: ToolSafetyGateOptions) {
    this.task = options.task;
    this.store = options.store;
    // 用闭包保留调用语义，避免调用方传入实例方法时丢失其 this 绑定。
    this.isExecutionApproved = () => options.isExecutionApproved();
    this.approveExecution = () => options.approveExecution();
  }

  /**
   * 为当前 edit 取得授权并复核路径。任何拒绝都只影响当前工具调用。
   */
  async authorize(
    toolName: "edit",
    input: Readonly<Record<string, unknown>>,
    context: ExtensionContext,
  ): Promise<ToolSafetyDecision> {
    if (!this.isExecutionApproved()) {
      let paths: string[];
      try {
        paths = await requestedWritePaths(this.task, toolName, input);
      } catch (error) {
        return { kind: "block", reason: safeFailure(error), reasonCode: "path-rejected" };
      }
      const approvalMessage = [
        "模型准备修改以下文件：",
        ...paths.map((path) => "- " + path),
        "",
        "批准后，本轮只允许修改这些文件；代码仍只写入 detached worktree，最终验证通过后才可 /apply。",
      ].join("\n");
      const approved = context.hasUI
        && typeof context.ui.confirm === "function"
        && await context.ui.confirm("是否允许本次代码修改", approvalMessage);
      const digest = createHash("sha256")
        .update(this.task.id + ":" + this.task.baseHead + ":" + paths.join("\n"))
        .digest("hex");
      // 审计失败不能反向决定是否可以写；真正的授权事实仍由 approveWriteScope 落盘。
      await appendEvent(this.store, this.task.id, "execution.approval", {
        digest: digest.slice(0, 16),
        approved,
        pathCount: paths.length,
        source: "first-write",
      }).catch(() => undefined);
      if (!approved) {
        return {
          kind: "block",
          reason: "用户未批准本次代码修改；worktree 保持不变。",
          reasonCode: "authorization-denied",
        };
      }
      try {
        await this.store.approveWriteScope(this.task, paths, digest);
        this.approveExecution();
      } catch (error) {
        return {
          kind: "block",
          reason: "无法保存本次写入授权：" + safeFailure(error),
          reasonCode: "authorization-unavailable",
        };
      }
    }

    const pathFailure = await approvedPathFailure(this.task, toolName, input);
    return pathFailure
      ? { kind: "block", reason: pathFailure, reasonCode: "path-rejected" }
      : { kind: "allow" };
  }
}
