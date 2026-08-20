import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PiRpcProcess } from "../src/pi/rpc-process.js";

describe("Pi RPC JSONL 进程适配", () => {
  it("关联 response，并把非 response 行转成事件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dungeon-rpc-test-"));
    const script = join(directory, "fake-rpc.mjs");
    await writeFile(script, [
      "import { createInterface } from 'node:readline';",
      "const input = createInterface({ input: process.stdin });",
      "input.on('line', (line) => {",
      "  const command = JSON.parse(line);",
      "  process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');",
      "  process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data: { ok: true } }) + '\\n');",
      "});",
    ].join("\n"), "utf8");
    const events: unknown[] = [];
    const processHandle = new PiRpcProcess(
      script,
      [],
      {},
      (event) => events.push(event),
    );
    try {
      await processHandle.start();
      const response = await processHandle.send({ type: "get_state" });
      assert.deepEqual(response, { ok: true });
      assert.deepEqual(events, [{ type: "agent_start" }]);
    } finally {
      await processHandle.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
