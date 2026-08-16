/** 五工具集成测试使用临时 Git 仓库，覆盖隔离写入、审批、Hash 与固定检查。 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { check, type CheckCatalog } from "../src/tools/check.js";
import { finish } from "../src/tools/finish.js";
import { inspect } from "../src/tools/inspect.js";
import { patch } from "../src/tools/patch.js";
import { TaskStore } from "../src/runtime/task.js";
import { createTaskWorktree, hashFile } from "../src/safety/worktree.js";
import { sqlDungeonChecks } from "../src/adapters/sql-dungeon/adapter.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, encoding: "utf8", windowsHide: true })).stdout.trim();
}

async function fixture(context: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "maintainer-tools-"));
  const repo = join(parent, "repo");
  const data = join(parent, "data");
  await mkdir(join(repo, ".maintainer"), { recursive: true });
  await mkdir(join(repo, "game", "tests"), { recursive: true });
  await mkdir(join(repo, "game", "src", "domain"), { recursive: true });
  await mkdir(join(repo, "scripts"), { recursive: true });
  await writeFile(join(repo, ".maintainer", "project.json"), '{"schemaVersion":1,"adapter":"sql-dungeon"}\n', "utf8");
  await writeFile(join(repo, "game", "tests", "view.test.ts"), "export const label = 'old';\n", "utf8");
  await writeFile(join(repo, "game", "tests", "one.test.ts"), "export const one = 'old';\n", "utf8");
  await writeFile(join(repo, "game", "tests", "two.test.ts"), "export const two = 'old';\n", "utf8");
  await writeFile(join(repo, "game", "tests", "three.test.ts"), "export const three = 'old';\n", "utf8");
  await writeFile(join(repo, "game", "src", "domain", "rule.ts"), "export const hp = 2;\n", "utf8");
  await writeFile(join(repo, "scripts", "test_validate_rules.py"), "print('规则通过')\n", "utf8");
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "user.name", "Maintainer Test"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "fixture"]);
  const store = new TaskStore(data);
  context.after(async () => rm(parent, { recursive: true, force: true }));
  return { parent, repo, data, store, head: await git(repo, ["rev-parse", "HEAD"]) };
}

void test("inspect 对读取结果分页并生成稳定证据", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "diagnose", objective: "读取展示", repoRoot: value.repo, baseHead: value.head });
  await value.store.transition(task, "diagnosing");
  const output = await inspect({ task, store: value.store }, { action: "read", path: "game/tests/view.test.ts", startLine: 1 });
  assert.match(output.text, /label/);
  assert.match(output.details.evidenceId, /^[0-9a-f]{16}$/u);
  assert.match(output.details.baseHash ?? "", /^[0-9a-f]{64}$/u);
  await assert.rejects(inspect({ task, store: value.store }, { action: "read", path: ".env" }), /禁止访问/);
});

void test("inspect 根搜索过滤永久禁止目录且不回传搜索错误正文", async (context) => {
  const value = await fixture(context);
  const marker = "SEARCH_GUARD_SENTINEL";
  await mkdir(join(value.repo, "node_modules", "private"), { recursive: true });
  await mkdir(join(value.repo, "game", "dist"), { recursive: true });
  await writeFile(join(value.repo, ".env"), `${marker}=credential\n`, "utf8");
  await writeFile(join(value.repo, "node_modules", "private", "leak.ts"), `export const leak = '${marker}';\n`, "utf8");
  await writeFile(join(value.repo, "game", "dist", "leak.js"), `const leak = '${marker}';\n`, "utf8");
  await writeFile(join(value.repo, "game", "tests", "search.test.ts"), `export const visible = '${marker}';\n`, "utf8");
  const task = await value.store.create({ mode: "diagnose", objective: "验证搜索边界", repoRoot: value.repo, baseHead: value.head });
  await value.store.transition(task, "diagnosing");

  const output = await inspect({ task, store: value.store }, { action: "search", query: marker });
  assert.match(output.text, /game\/tests\/search\.test\.ts/u);
  assert.doesNotMatch(output.text, /\.env|node_modules|game\/dist|credential|private\/leak/iu);
  await assert.rejects(
    inspect({ task, store: value.store }, { action: "search", query: "(" }),
    (error: unknown) => error instanceof Error && error.message === "inspect search 执行失败",
  );
});

void test("patch 校验 baseHash、唯一文本和核心一次性批准", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "fix", objective: "修改规则", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");
  const path = "game/src/domain/rule.ts";
  const baseHash = await hashFile(task.worktreeRoot, path);
  await assert.rejects(
    patch({ task, store: value.store }, { edits: [{ path, baseHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }] }),
    /NEEDS_APPROVAL/,
  );
  const token = await value.store.requestApproval(task, [path]);
  await value.store.approve(task, token);
  await patch({ task, store: value.store }, { edits: [{ path, baseHash, oldText: "export const hp = 2;", newText: "export const hp = 3;" }] });
  assert.equal((await readFile(join(task.worktreeRoot, path), "utf8")).replaceAll("\r\n", "\n"), "export const hp = 3;\n");
  assert.ok(task.approval?.usedAt);
  await assert.rejects(
    patch({ task, store: value.store }, { edits: [{ path, baseHash, oldText: "export const hp = 3;", newText: "export const hp = 4;" }] }),
    /需要任务级一次批准|NEEDS_APPROVAL|baseHash/u,
  );
});

void test("Dashboard 检查点失败发生在源码写入前", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "fix", objective: "验证刷新检查点", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");
  const path = "game/tests/view.test.ts";
  const baseHash = await hashFile(task.worktreeRoot, path);

  await assert.rejects(patch({
    task,
    store: value.store,
    beforePatch: async () => {
      const current = await readFile(join(task.worktreeRoot ?? "", path), "utf8");
      assert.match(current, /'old'/u);
      throw new Error("检查点不可用");
    },
  }, {
    edits: [{ path, baseHash, oldText: "'old'", newText: "'new'" }],
  }), /检查点不可用/u);

  assert.match(await readFile(join(task.worktreeRoot, path), "utf8"), /'old'/u);
  assert.deepEqual(task.changedPaths, []);
});

void test("固定检查按 worktree Hash 缓存且 ready 生成可应用补丁", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "fix", objective: "修复测试展示", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");
  const path = "game/tests/view.test.ts";
  const baseHash = await hashFile(task.worktreeRoot, path);
  await patch({ task, store: value.store }, { edits: [{ path, baseHash, oldText: "'old'", newText: "'new'" }] });
  const first = await check({ task, store: value.store, checks: sqlDungeonChecks }, { id: "rules-test" });
  const second = await check({ task, store: value.store, checks: sqlDungeonChecks }, { id: "rules-test" });
  assert.equal(first.details.status, "passed");
  assert.equal(first.details.cached, false);
  assert.equal(second.details.cached, true);
  const done = await finish({ task, store: value.store }, {
    status: "ready", summary: "展示文案已更新。", risk: "仅一处测试展示文本。", checks: ["rules-test"],
  });
  assert.equal(done.details.state, "ready_to_apply");
  assert.ok(done.details.patchPath);
  assert.equal((await readFile(join(value.repo, path), "utf8")).replaceAll("\r\n", "\n"), "export const label = 'old';\n");
});

void test("check 只执行组合入口注入的固定目录", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "diagnose", objective: "验证检查注入", repoRoot: value.repo, baseHead: value.head });
  await value.store.transition(task, "diagnosing");
  const catalog: CheckCatalog = {
    spec: (id) => ({ id, file: process.execPath, args: ["--version"] }),
    required: () => ["rules-test"],
  };

  const result = await check({ task, store: value.store, checks: catalog }, { id: "rules-test" });

  assert.equal(result.details.status, "passed");
  assert.match(await readFile(result.details.logPath, "utf8"), /^v\d+/u);
});

void test("模型不能伪造未执行的检查", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "fix", objective: "伪造检查", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");
  await value.store.transition(task, "verifying");
  await assert.rejects(
    finish({ task, store: value.store }, { status: "ready", summary: "完成", risk: "低", checks: ["game-test"] }),
    /没有真实通过记录/,
  );
});

void test("finish 拒绝检查过程在 patch 清单外产生的源码变化", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "fix", objective: "拒绝额外变化", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");
  const path = "game/tests/view.test.ts";
  await patch({ task, store: value.store }, {
    edits: [{ path, baseHash: await hashFile(task.worktreeRoot, path), oldText: "'old'", newText: "'new'" }],
  });
  await check({ task, store: value.store, checks: sqlDungeonChecks }, { id: "rules-test" });
  await writeFile(join(task.worktreeRoot, "game", "tests", "outside.test.ts"), "export const outside = true;\n", "utf8");
  // 额外变化会使先前检查缓存失效；重新检查后才能单独验证补丁清单约束。
  await check({ task, store: value.store, checks: sqlDungeonChecks }, { id: "rules-test" });

  await assert.rejects(finish({ task, store: value.store }, {
    status: "ready", summary: "修改完成。", risk: "低。", checks: ["rules-test"],
  }), /未经过 patch 工具记录/u);
  assert.equal(task.state, "verifying");
});

void test("多次 patch 调用共享整个任务的文件预算", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "fix", objective: "验证累计预算", repoRoot: value.repo, baseHead: value.head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");

  for (const name of ["view", "one", "two"]) {
    const path = `game/tests/${name}.test.ts`;
    const baseHash = await hashFile(task.worktreeRoot, path);
    await patch({ task, store: value.store }, {
      edits: [{ path, baseHash, oldText: "'old'", newText: "'new'" }],
    });
  }

  const fourth = "game/tests/three.test.ts";
  await assert.rejects(
    patch({ task, store: value.store }, {
      edits: [{ path: fourth, baseHash: await hashFile(task.worktreeRoot, fourth), oldText: "'old'", newText: "'new'" }],
    }),
    /PATCH_BUDGET_EXCEEDED.*3 个文件/u,
  );
  assert.deepEqual(task.changedPaths, [
    "game/tests/one.test.ts", "game/tests/two.test.ts", "game/tests/view.test.ts",
  ]);
});

void test("多次 patch 调用共享整个任务的行数预算", async (context) => {
  const value = await fixture(context);
  const path = "game/tests/view.test.ts";
  const lines = Array.from({ length: 70 }, (_, index) => `line-${String(index)}`);
  await writeFile(join(value.repo, path), `${lines.join("\n")}\n`, "utf8");
  await git(value.repo, ["add", path]);
  await git(value.repo, ["commit", "-m", "line budget fixture"]);
  const head = await git(value.repo, ["rev-parse", "HEAD"]);
  const task = await value.store.create({ mode: "fix", objective: "验证累计行数", repoRoot: value.repo, baseHead: head });
  task.worktreeRoot = await createTaskWorktree(task, join(value.data, "worktrees"));
  await value.store.transition(task, "diagnosing");
  const worktreeText = await readFile(join(task.worktreeRoot, path), "utf8");
  const eol = worktreeText.includes("\r\n") ? "\r\n" : "\n";
  const firstOld = lines.slice(0, 30).join(eol);
  const firstNew = lines.slice(0, 30).map((line) => `first-${line}`).join(eol);
  await patch({ task, store: value.store }, {
    edits: [{ path, baseHash: await hashFile(task.worktreeRoot, path), oldText: firstOld, newText: firstNew }],
  });
  const secondOld = lines.slice(30, 61).join(eol);
  const secondNew = lines.slice(30, 61).map((line) => `second-${line}`).join(eol);
  await assert.rejects(
    patch({ task, store: value.store }, {
      edits: [{ path, baseHash: await hashFile(task.worktreeRoot, path), oldText: secondOld, newText: secondNew }],
    }),
    /PATCH_BUDGET_EXCEEDED.*120 行/u,
  );
  assert.equal(task.patchLines, 60);
});

void test("finish 生成只含结构化事实的脱敏中文报告", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({ mode: "diagnose", objective: "检查展示问题", repoRoot: value.repo, baseHead: value.head });
  await value.store.transition(task, "diagnosing");
  const done = await finish({ task, store: value.store }, {
    status: "diagnosed",
    summary: "发现展示问题，api_key=abcdefghijklmnop",
    risk: "SELECT secret FROM hidden;",
    checks: [],
  });
  const report = await readFile(done.details.reportPath, "utf8");
  assert.match(report, /# Dungeon Maintainer 任务报告/u);
  assert.match(report, /\[CREDENTIAL REDACTED\]/u);
  assert.doesNotMatch(report, /abcdefghijklmnop|SELECT secret/iu);
  assert.match(report, /未运行固定检查/u);
});

void test("Dashboard 排查保存严格结构化方案且不允许代码改动", async (context) => {
  const value = await fixture(context);
  const task = await value.store.create({
    mode: "fix",
    source: "dashboard",
    objective: "排查当前楼层",
    repoRoot: value.repo,
    baseHead: value.head,
  });
  await value.store.transition(task, "diagnosing");
  const diagnosis = {
    result: "fault" as const,
    issue: "任务提示没有刷新",
    cause: "展示订阅仍读取旧状态",
    evidence: ["步骤 3：状态变化后标题不变"],
    fix: "在展示层订阅回调中使用最新快照。",
    paths: ["game/src/presentation/view.ts"],
    risk: "low" as const,
  };

  const done = await finish({ task, store: value.store, stage: "probe" }, {
    status: "diagnosed",
    summary: "已定位展示故障。",
    risk: "仅影响展示层。",
    checks: [],
    diagnosis,
  });

  assert.deepEqual(done.details.diagnosis, diagnosis);
  assert.deepEqual(task.diagnosis, diagnosis);
  assert.equal(task.state, "diagnosing");
  assert.deepEqual(task.changedPaths, []);

  await assert.rejects(finish({ task, store: value.store, stage: "probe" }, {
    status: "diagnosed",
    summary: "非法诊断。",
    risk: "低。",
    checks: [],
    diagnosis: { ...diagnosis, issue: "<script>bad</script>" },
  }), /纯文本/u);

  await assert.rejects(finish({ task, store: value.store, stage: "probe" }, {
    status: "diagnosed",
    summary: "非法诊断。",
    risk: "低。",
    checks: [],
    diagnosis: { ...diagnosis, evidence: ["SELECT secret FROM hidden"] },
  }), /不得包含 SQL/u);
});
