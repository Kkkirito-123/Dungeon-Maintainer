/**
 * 本地 Git 工作树查看与安全切换工具。
 *
 * 本模块只枚举当前游戏仓库已经注册的 worktree，并允许 Agent 在用户确认后启动一个
 * 绑定目标树的新维护任务。它不执行 checkout、不改变分支、不移动用户文件，也不在
 * 当前 Pi 会话中偷换 cwd；旧任务及其隔离 worktree 会完整保留，可按原 taskId 恢复。
 *
 * 切换进程使用维护器固定入口、固定 start 参数和继承的密钥环境，目标必须来自本次
 * 枚举结果且带合法项目标识。启动失败不会修改来源树；用户可继续恢复旧任务诊断。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { appendEvent } from "../../logging/events.js";
import type { TaskStore } from "../../task/store.js";
import type { TaskRecord } from "../../task/types.js";
import {
  listRepositoryWorktrees,
  type RepositoryWorktreeSummary,
} from "../../workspace/catalog.js";
import { withProgress } from "../../progress/reporter.js";

/**
 * `workspace` 的模型参数契约。
 *
 * `switch` 只接受前一次 `list` 返回的 12 位临时 treeId，不接收路径、分支名或仓库地址，
 * 防止模型把任意目录变成新任务来源。
 */
export const TreeParameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("switch")]),
  treeId: Type.Optional(Type.String({ minLength: 12, maxLength: 12 })),
}, { additionalProperties: false });

/** `TreeParameters` 对应的已校验 TypeScript 输入；switch 分支仍要求存在 `treeId`。 */
export type TreeInput = Static<typeof TreeParameters>;

/**
 * `workspace` 所需的当前任务依赖。
 *
 * TaskStore 用于限定同一 Git common-dir 的合法候选并记录低敏切换事件；工具不持有新的
 * 任务对象，实际创建和 Pi 生命周期切换由 AppController 完成。
 */
export interface TreeToolContext {
  task: TaskRecord;
  store: TaskStore;
}

async function requestControllerSwitch(tree: RepositoryWorktreeSummary): Promise<void> {
  const shellUrl = process.env.DUNGEON_MAINTAINER_SHELL_URL?.trim();
  if (!shellUrl) throw new Error("统一 Shell 未绑定，不能切换工作树");
  const shell = new URL(shellUrl);
  const endpoint = new URL("/api/tasks/switch", shell);
  endpoint.search = shell.search;
  // 只回调当前 Shell URL 并复用其中随机令牌；tree 的绝对路径不进入请求正文或模型输出。
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dungeon-token": shell.searchParams.get("token") ?? "",
    },
    body: JSON.stringify({
      kind: "worktree",
      id: tree.id,
      agentConfirmed: true,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(
      typeof detail.error === "string" ? detail.error : "AppController 拒绝切换工作树",
    );
  }
}

/**
 * 注册受限工作树工具。
 *
 * @param pi 当前固定 Pi Extension API。
 * @param context 当前任务和任务存储；候选只能来自同一 Git common-dir 的注册 worktree。
 * @returns 无返回值；注册后 list 只读，switch 经 UI 确认后请求 AppController 创建新任务。
 * @throws 工具名冲突时同步抛错；执行时可能因非法 treeId、无 UI、Shell 拒绝或超时而失败。
 * @remarks 当前会话的 cwd、分支和任务记录不会原地改变，旧 Pi 必须先停止后才能启动新任务。
 */
export function registerWorkspaceTool(pi: ExtensionAPI, context: TreeToolContext): void {
  pi.registerTool({
    name: "workspace",
    label: "工作树",
    description: "列出当前游戏仓库的本地工作树，或经用户确认后用目标树启动一个新任务。",
    promptSnippet: "用 workspace 查看或切换本地 Git 工作树",
    promptGuidelines: [
      "切换前必须先 workspace(action=list)，并只使用返回的 12 位 treeId。",
      "workspace(action=switch) 会创建新任务并结束当前运行时，不能用它规避 /apply。",
    ],
    executionMode: "sequential",
    parameters: TreeParameters,
    async execute(_toolCallId, input: TreeInput, signal, _onUpdate, extensionContext: ExtensionContext) {
      return await withProgress(
        extensionContext.ui,
        "workspace",
        input,
        async (progress) => {
          signal?.throwIfAborted();
          progress.line("枚举可用工作树");
          const candidates = await listRepositoryWorktrees(context.task, context.store);
          if (input.action === "list") {
            await appendEvent(context.store, context.task.id, "tool.tree_list", {
              count: candidates.length,
            });
            progress.line("找到 " + String(candidates.length) + " 个工作树");
            return {
              content: [{
                type: "text",
                text: candidates.length > 0
                  ? candidates.map((candidate) => [
                    "TREE " + candidate.id,
                    "branch=" + candidate.branch,
                    "dirtyFiles=" + String(candidate.dirtyFiles),
                    "current=" + String(candidate.current),
                  ].join(" ")).join("\n")
                  : "没有可切换的 SQL Dungeon 本地工作树",
              }],
              details: candidates.map((candidate) => ({
                id: candidate.id,
                branch: candidate.branch,
                dirtyFiles: candidate.dirtyFiles,
                current: candidate.current,
              })),
            };
          }
          if (!input.treeId) throw new Error("switch 必须提供 list 返回的 treeId");
          const target = candidates.find((candidate) => candidate.id === input.treeId);
          if (!target) throw new Error("treeId 不属于当前可切换工作树列表");
          if (target.current) throw new Error("目标已经是当前来源工作树");
          progress.line("等待确认切换到 " + target.branch);
          const confirmed = await extensionContext.ui.confirm(
            "切换 SQL Dungeon 工作树",
            "将结束当前运行时并创建新任务。目标分支：" + target.branch
            + "；本地修改文件：" + String(target.dirtyFiles),
          );
          if (!confirmed) throw new Error("用户取消切换工作树");
          // 这里只记录不含路径的候选 ID 和脏文件数量；AppController 会再次按当下目录事实
          // 解析目标，不能把模型或旧 list 响应里的路径当成权威。
          await appendEvent(context.store, context.task.id, "tool.tree_switch", {
            treeId: target.id,
            dirtyFiles: target.dirtyFiles,
          });
          progress.line("请求 AppController 切换工作树");
          await requestControllerSwitch(target);
          return {
            content: [{ type: "text", text: "已确认切换；AppController 将先停止当前 Pi，再启动目标任务和右侧游戏。" }],
            details: { treeId: target.id, branch: target.branch },
          };
        },
      );
    },
  });
}
