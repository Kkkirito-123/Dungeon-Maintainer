/**
 * 游戏同窗 Dashboard 的单一控制器。
 *
 * 本模块负责把三个无参数网页 binding 映射到“排查、修复、应用”三个既有安全流程，
 * 并把脱敏状态推送回游戏面板。它不解析网页输入、不持有 API Key、不执行 Shell，也
 * 不自行判断文件权限；读取、补丁、检查、核心审批、Git 并发保护分别继续由 Runtime、
 * tools 和 safety 模块强制执行。浏览器关闭或外部取消会中止当前作业，但任务证据和
 * worktree 会保留，便于人工检查。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runHarness, type HarnessRunOptions, type HarnessRunResult } from "../harness/runner.js";
import type { RuntimeConfig } from "../runtime/config.js";
import type { RuntimeModel } from "../runtime/model.js";
import type { TaskRecord, TaskStore } from "../runtime/task.js";
import { applyTaskPatch } from "../safety/worktree.js";
import { harnessEvent } from "../harness/events.js";
import {
  floorScenarioId,
  openSqlDungeonDashboard,
  sqlDungeonAdapter,
  type SqlDungeonDashboardSession,
} from "../adapters/sql-dungeon/adapter.js";
import type { CommandAck } from "../adapters/sql-dungeon/browser.js";

type DashboardCommand = "diagnose" | "fix" | "apply";

const PROBE_PROMPT = `你是 SQL Dungeon 的快速诊断 Agent。
从当前游戏状态开始，不得重置楼层。先调用 look，再根据可见状态选择少量 go/use/query；
只有发现客观异常时才调用 inspect 定位代码。当前阶段没有 patch 和 check 工具。
结束时必须调用 finish(status=diagnosed)，并提供 diagnosis：fault/healthy/blocked、故障、原因、
证据引用、最小解决方法、最多三个项目相对路径和风险。不要输出隐藏思维，不得读取或猜测
SQL、管理员答案、完整地图、快照、存档、身份或密钥。`;

function repairPrompt(task: TaskRecord): string {
  const diagnosis = task.diagnosis;
  return `你是 SQL Dungeon 的现场修复 Agent。
已确认故障：${diagnosis?.issue ?? "未记录"}
已确认原因：${diagnosis?.cause ?? "未记录"}
建议方案：${diagnosis?.fix ?? "未记录"}
建议文件：${diagnosis?.paths.join(", ") || "未记录"}
必须重新 inspect 取得最新 baseHash，再做最小 patch。核心文件会自动暂停等待用户批准，禁止绕过。
修改后必须重新 look 复测，并按实际文件范围运行适配器要求的固定检查；全部真实通过后才能
finish(status=ready)。不得读取或输出 SQL、答案、地图、快照、身份、密钥或隐藏思维。`;
}

function ack(accepted: boolean, reason: CommandAck["reason"]): CommandAck {
  return { schemaVersion: 1, accepted, reason };
}

/** Dashboard 创建与运行所需依赖。 */
export interface DashboardOptions {
  task: TaskRecord;
  store: TaskStore;
  config: RuntimeConfig;
  floor: number;
  signal?: AbortSignal;
  model?: RuntimeModel;
  /** 只输出任务 ID、批准命令和产物位置，不输出模型正文或凭据。 */
  write(line: string): void;
  /** 测试可替换浏览器、Harness 和应用动作；生产入口不设置。 */
  services?: Partial<DashboardServices>;
}

/** Dashboard 可替换的三个外部副作用边界。 */
export interface DashboardServices {
  /** 创建只连接隔离 worktree 的可视浏览器会话。 */
  open(options: Parameters<typeof openSqlDungeonDashboard>[0]): Promise<SqlDungeonDashboardSession>;
  /** 执行受限 Pi Harness；工具权限仍由传入 stage 决定。 */
  run(options: HarnessRunOptions): Promise<HarnessRunResult>;
  /** 在全部验证后按 Git/Hash 保护应用补丁。 */
  apply(task: TaskRecord): Promise<Record<string, string>>;
}

const DEFAULT_SERVICES: DashboardServices = {
  open: openSqlDungeonDashboard,
  run: runHarness,
  apply: applyTaskPatch,
};

/**
 * 维护一个页面、一个任务和一个活动作业。
 *
 * `accept` 在启动长任务前原子设置 busy，因而三枚按钮无法并发修改同一 worktree。
 * 页面只获得固定无参数函数；真实任务、仓库路径和批准状态始终留在 Node 进程。
 */
export class DashboardController {
  private session: SqlDungeonDashboardSession | null = null;
  private job: Promise<void> | null = null;
  private active: AbortController | null = null;
  private busy = false;
  private closed = false;
  private readonly services: DashboardServices;

  /** @param options 已创建 worktree 且处于 diagnosing 的 Dashboard 任务。 */
  constructor(private readonly options: DashboardOptions) {
    this.services = { ...DEFAULT_SERVICES, ...options.services };
  }

  /**
   * 打开可视游戏并保持到用户关闭页面或取消。
   * @throws worktree、Vite、Chromium 或开发态桥无法启动时抛出。
   */
  async run(): Promise<void> {
    const task = this.options.task;
    if (task.source !== "dashboard" || !task.worktreeRoot) {
      throw new Error("Dashboard 需要带隔离 worktree 的 dashboard 任务");
    }
    const output = join(this.options.store.taskDir(task.id), "dashboard");
    await mkdir(output, { recursive: true });
    this.session = await this.services.open({
      repoRoot: task.worktreeRoot,
      output,
      ...(this.options.signal ? { signal: this.options.signal } : {}),
    });
    await this.session.bindDashboard({
      diagnose: async () => await this.accept("diagnose"),
      fix: async () => await this.accept("fix"),
      apply: async () => await this.accept("apply"),
    });
    const scenario = sqlDungeonAdapter.scenarios([floorScenarioId(this.options.floor)])[0];
    if (!scenario) throw new Error("找不到 Dashboard 初始楼层");
    await this.session.openScenario(scenario);
    await this.control("idle", "选择快速排查开始诊断", true, false, false);
    try {
      await this.session.waitUntilClosed(this.options.signal);
    } finally {
      this.closed = true;
      this.active?.abort();
      await this.job?.catch(() => undefined);
      await this.session.close().catch(() => undefined);
      this.session = null;
    }
  }

  private async accept(command: DashboardCommand): Promise<CommandAck> {
    if (this.closed || !this.session) return ack(false, "closed");
    // busy 必须在第一次 await 前设置，否则两个相邻页面点击都可能穿过读取任务的空窗。
    if (this.busy) return ack(false, "busy");
    this.busy = true;
    try {
      await this.refresh();
      if (!this.allowed(command)) {
        this.busy = false;
        return ack(false, "invalid_state");
      }
      const controller = new AbortController();
      this.active = controller;
      const signal = this.options.signal
        ? AbortSignal.any([this.options.signal, controller.signal])
        : controller.signal;
      this.job = this.execute(command, signal)
        .catch(async (error: unknown) => await this.fail(error))
        .finally(() => {
          this.active = null;
          this.job = null;
          this.busy = false;
        });
      return ack(true, "started");
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  private allowed(command: DashboardCommand): boolean {
    const task = this.options.task;
    if (command === "apply") return task.state === "ready_to_apply";
    if (command === "fix") {
      return task.diagnosis?.result === "fault"
        && task.diagnosis.paths.length > 0
        && ["diagnosing", "needs_approval", "approved", "editing", "verifying", "blocked"].includes(task.state);
    }
    return task.changedPaths.length === 0 && ["diagnosing", "blocked"].includes(task.state);
  }

  private async execute(command: DashboardCommand, signal: AbortSignal): Promise<void> {
    if (command === "diagnose") await this.diagnose(signal);
    else if (command === "fix") await this.fix(signal);
    else await this.apply();
  }

  private async diagnose(signal: AbortSignal): Promise<void> {
    const session = this.needSession();
    const task = this.options.task;
    if (task.state === "blocked") await this.options.store.transition(task, "diagnosing");
    task.diagnosis = null;
    await this.options.store.save(task);
    const floor = await session.currentFloor();
    await this.control("diagnosing", `正在排查第 ${String(floor)} 层当前状态`, false, false, false);
    const report = await this.services.run({
      task,
      store: this.options.store,
      config: this.options.config,
      adapter: sqlDungeonAdapter,
      scenarioIds: [floorScenarioId(floor)],
      headed: true,
      session,
      resume: true,
      stage: "probe",
      limits: { turns: 6, toolCalls: 6, tokens: 8_000 },
      systemPrompt: PROBE_PROMPT,
      fresh: true,
      signal,
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    const updated = await this.options.store.read(task.id);
    Object.assign(task, updated);
    const diagnosis = updated.diagnosis;
    if (diagnosis) await session.emit(harnessEvent({ type: "diagnosis", diagnosis }));
    if (report.status === "PASS" && diagnosis && diagnosis.result !== "blocked") {
      await this.control(
        "diagnosed",
        diagnosis.issue,
        this.allowed("diagnose"),
        this.allowed("fix"),
        false,
      );
    } else {
      await this.control(
        "failed",
        task.conclusion ?? report.summary,
        this.allowed("diagnose"),
        this.allowed("fix"),
        false,
      );
    }
    this.options.write(`排查报告：${report.reportPath}`);
  }

  private async fix(signal: AbortSignal): Promise<void> {
    await this.refresh();
    const task = this.options.task;
    if (task.state === "needs_approval") {
      await this.control("needs_approval", "核心文件尚未批准；请先在终端执行批准命令", false, true, false);
      return;
    }
    if (task.state === "blocked") await this.options.store.transition(task, "diagnosing");
    const session = this.needSession();
    const floor = await session.currentFloor();
    await this.control("fixing", "正在隔离 worktree 中实施最小修复", false, false, false);
    const used = task.usage.input + task.usage.output + task.usage.cacheWrite;
    const remaining = Math.max(1, this.options.config.maxTokens - used);
    const report = await this.services.run({
      task,
      store: this.options.store,
      config: this.options.config,
      adapter: sqlDungeonAdapter,
      scenarioIds: [floorScenarioId(floor)],
      headed: true,
      session,
      resume: true,
      stage: "repair",
      limits: { turns: 20, toolCalls: 40, tokens: remaining },
      systemPrompt: repairPrompt(task),
      fresh: true,
      signal,
      onEvent: async (event) => {
        if (event.type === "action" && event.action === "patch" && event.state === "done") {
          if (task.diagnosis) {
            await session.emit(harnessEvent({ type: "diagnosis", diagnosis: task.diagnosis }));
          }
          await this.control("fixing", "页面已刷新并恢复当前进度，继续修复", false, false, false);
        }
        if (event.type === "action" && event.action === "check" && event.state === "start") {
          await this.control("verifying", "正在执行固定检查并准备现场复测", false, false, false);
        }
      },
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    await this.refresh();
    if (report.approvalToken) {
      const paths = task.approval?.paths.join(", ") ?? "未知路径";
      this.options.write(`核心修改文件：${paths}`);
      this.options.write(`批准命令：dungeon-maintain approve ${task.id} ${report.approvalToken}`);
      await this.control(
        "needs_approval",
        "核心修复等待终端批准",
        this.allowed("diagnose"),
        this.allowed("fix"),
        false,
      );
    } else if (task.state === "ready_to_apply") {
      await this.control("ready_to_apply", "修复、固定检查和现场复测均已通过", false, false, true);
    } else {
      await this.control(
        "failed",
        task.conclusion ?? report.summary,
        this.allowed("diagnose"),
        this.allowed("fix"),
        this.allowed("apply"),
      );
    }
    this.options.write(`修复报告：${report.reportPath}`);
  }

  private async apply(): Promise<void> {
    await this.refresh();
    const task = this.options.task;
    if (task.state !== "ready_to_apply") {
      await this.control("failed", "任务尚未通过验证，不能应用", true, false, false);
      return;
    }
    task.appliedHashes = await this.services.apply(task);
    await this.options.store.transition(task, "applied");
    await this.control("applied", "补丁已应用到目标工作区；未创建提交", false, false, false);
    this.options.write(`补丁已应用：${task.changedPaths.join(", ")}`);
  }

  private async refresh(): Promise<void> {
    Object.assign(this.options.task, await this.options.store.read(this.options.task.id));
  }

  private needSession(): SqlDungeonDashboardSession {
    if (!this.session || this.closed) throw new Error("Dashboard 浏览器已经关闭");
    return this.session;
  }

  private async control(
    state: "idle" | "diagnosing" | "diagnosed" | "fixing" | "needs_approval" | "verifying" | "ready_to_apply" | "applied" | "failed",
    message: string,
    canCheck: boolean,
    canFix: boolean,
    canApply: boolean,
  ): Promise<void> {
    await this.needSession().emit(harnessEvent({
      type: "control",
      state,
      canCheck,
      canFix,
      canApply,
      message: message.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160),
    }));
  }

  private async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "Dashboard 任务失败";
    if (!this.closed && this.session) {
      await this.refresh().catch(() => undefined);
      await this.control(
        "failed",
        message,
        this.allowed("diagnose"),
        this.allowed("fix"),
        this.allowed("apply"),
      ).catch(() => undefined);
    }
    this.options.write(`Dashboard 错误：${message}`);
  }
}
