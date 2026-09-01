import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withProgress, type ProgressUi } from "../src/progress/reporter.js";

function capture(): { ui: ProgressUi; statuses: string[]; widgets: string[][] } {
  const statuses: string[] = [];
  const widgets: string[][] = [];
  return {
    statuses,
    widgets,
    ui: {
      setStatus: (_key, text) => { if (text) statuses.push(text); },
      setWidget: (_key, lines) => { if (lines) widgets.push([...lines]); },
    },
  };
}

describe("ProgressReporter", () => {
  it("formats safe parameters and strips ANSI text", async () => {
    const target = capture();
    await withProgress(target.ui, "query", {
      path: "game/src/query.ts",
      token: "secret-value",
      API_KEY: "api-secret",
      content: "private patch",
      mazeFloor: 7,
      inventory: ["hidden-item"],
      sql: "SELECT * FROM rooms",
    }, async (reporter) => {
      reporter.line(String.fromCharCode(27) + "[31mstdout\nnext");
    });

    const text = target.widgets.at(-1)?.join("\n") ?? "";
    assert.match(text, /game\/src\/query\.ts/u);
    assert.match(text, /SELECT \* FROM rooms/u);
    assert.doesNotMatch(text, /secret-value|api-secret|private patch|hidden-item/u);
    assert.equal(text.includes(String.fromCharCode(27)), false);
    assert.match(text, /stdout next/u);
  });

  it("keeps at most 80 bounded lines and reports completion/failure", async () => {
    const target = capture();
    await withProgress(target.ui, "check", undefined, async (reporter) => {
      for (let index = 0; index < 100; index += 1) {
        reporter.line(String(index) + "-" + "x".repeat(700));
      }
      reporter.done("ok");
    });
    const lines = target.widgets.at(-1) ?? [];
    assert.equal(lines.length, 80);
    assert.ok(lines.every((line) => line.length <= 500));
    assert.match(lines.at(-1) ?? "", /通过 .*秒/u);

    await assert.rejects(
      withProgress(target.ui, "fail", undefined, async () => {
        throw new Error("boom");
      }),
      /boom/u,
    );
    assert.match(target.statuses.at(-1) ?? "", /失败 boom/u);

    await assert.rejects(
      withProgress(target.ui, "wrapped", {}, async () => { throw new Error("wrapped-failure"); }),
      /wrapped-failure/u,
    );
  });

  it("does not let a broken UI channel change the result", async () => {
    const ui: ProgressUi = {
      setStatus: () => { throw new Error("ui down"); },
      setWidget: () => { throw new Error("ui down"); },
    };
    assert.equal(await withProgress(ui, "ok", undefined, async () => "value"), "value");
  });
});
