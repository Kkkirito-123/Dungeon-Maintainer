/**
 * 浏览器语义动作的短期环形 Trace。
 *
 * Trace 只保存 look/go/use/input-sql/query 的动作类型、有限参数、公开结果摘要与序号，不保存
 * SQL、鼠标轨迹、渲染帧或完整快照。内存上限固定为 500 条；只有复现流程明确截取
 * 的窗口才会写入 reproductions 目录。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactText } from "./redact.js";

/** 一条可重放语义动作。 */
export interface SemanticTraceEntry {
  sequence: number;
  at: string;
  action: "look" | "go" | "use" | "input-sql" | "query";
  arguments: Record<string, string | number | boolean | null>;
  ok: boolean;
  summary: string;
}

/** 固定容量的语义事件缓冲。 */
export class SemanticTrace {
  private readonly entries: SemanticTraceEntry[] = [];
  private sequence = 0;

  /** @param capacity 最大内存事件数，默认 500。 */
  constructor(private readonly capacity = 500) {}

  /**
   * 追加语义动作并分配单调序号。
   *
   * @param entry 不含序号和时间的公开动作结果。
   * @returns 已写入的完整事件。
   */
  push(
    entry: Omit<SemanticTraceEntry, "sequence" | "at" | "summary"> & {
      summary: string;
    },
  ): SemanticTraceEntry {
    const value: SemanticTraceEntry = {
      ...entry,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      summary: redactText(entry.summary).replace(/\s+/gu, " ").slice(0, 500),
    };
    this.entries.push(value);
    if (this.entries.length > this.capacity) this.entries.shift();
    return value;
  }

  /** 清空当前复现窗口，但保持序号单调递增。 */
  clear(): void {
    this.entries.length = 0;
  }

  /** 返回不可变副本，调用方不能修改内部缓冲。 */
  snapshot(): SemanticTraceEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      arguments: { ...entry.arguments },
    }));
  }

  /**
   * 将当前窗口写入指定 JSONL 文件。
   *
   * @param path reproductions 目录中的精确目标文件。
   */
  async persist(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const body = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(path, body ? body + "\n" : "", "utf8");
  }
}
