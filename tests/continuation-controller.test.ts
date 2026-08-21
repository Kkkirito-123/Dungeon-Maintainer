/**
 * 自动续跑 Controller 的纯状态机回归。
 *
 * 测试只验证 revision、幂等和失效行为，不启动 Pi、模型、浏览器或文件系统，确保消息
 * 队列语义与任务调度语义可以独立审计。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ContinuationController } from "../src/pi/continuation-controller.js";

describe("ContinuationController", () => {
  it("同一请求和进展版本只允许一条相同自动续跑", () => {
    const controller = new ContinuationController("task-controller");
    controller.beginRequest(false);
    const first = controller.reserve({
      kind: "repair",
      phase: "diagnose",
      nextAction: "inspect-source",
    });
    assert.ok(first.ticket);
    assert.equal(controller.reserve({
      kind: "repair",
      phase: "diagnose",
      nextAction: "inspect-source",
    }).suppressed, "outstanding");
    assert.equal(controller.admitQueued()?.status, "admitted");
    assert.equal(controller.completeActive()?.status, "completed");
    assert.equal(controller.reserve({
      kind: "repair",
      phase: "diagnose",
      nextAction: "inspect-source",
    }).suppressed, "duplicate");
  });

  it("客观进展允许下一阶段续跑并废弃旧排队消息", () => {
    const controller = new ContinuationController("task-progress");
    controller.beginRequest(false);
    assert.ok(controller.reserve({
      kind: "repair",
      phase: "reproduce",
      nextAction: "save-reproduction",
    }).ticket);
    const stale = controller.advanceProgress("reproduction-saved");
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.status, "stale");
    const next = controller.reserve({
      kind: "repair",
      phase: "diagnose",
      nextAction: "inspect-source",
    });
    assert.equal(next.ticket?.progressRevision, 1);
  });

  it("新用户请求使旧 Ticket 失效，继续请求保留进展版本", () => {
    const controller = new ContinuationController("task-request");
    controller.beginRequest(false);
    controller.advanceProgress("evidence-added");
    assert.ok(controller.reserve({
      kind: "budget",
      phase: "propose",
      nextAction: "finish-proposed",
    }).ticket);
    const stale = controller.beginRequest(true);
    assert.equal(stale[0]?.reason, "new-user-request");
    assert.equal(controller.snapshot().requestRevision, 2);
    assert.equal(controller.snapshot().progressRevision, 1);
  });

  it("运行中的普通回合或自动回合在新用户请求到达后都会失效", () => {
    const controller = new ContinuationController("task-running-revision");
    controller.beginRequest(false);
    assert.equal(controller.admitQueued(), null);
    assert.equal(controller.activeRunIsCurrent(), true);
    controller.beginRequest(false);
    assert.equal(controller.activeRunIsCurrent(), false);
    assert.equal(controller.completeActive(), null);

    assert.ok(controller.reserve({
      kind: "repair",
      phase: "reproduce",
      nextAction: "reproduce-visible-failure",
    }).ticket);
    assert.equal(controller.admitQueued()?.status, "admitted");
    controller.beginRequest(true);
    assert.equal(controller.activeRunIsCurrent(), false);
  });

  it("每个自然语言请求遵守自动续跑总上限", () => {
    const controller = new ContinuationController("task-limit", 2);
    controller.beginRequest(false);
    for (const nextAction of ["one", "two"]) {
      assert.ok(controller.reserve({
        kind: "repair",
        phase: "diagnose",
        nextAction,
      }).ticket);
      controller.admitQueued();
      controller.completeActive();
    }
    assert.equal(controller.reserve({
      kind: "repair",
      phase: "diagnose",
      nextAction: "three",
    }).suppressed, "attempt-limit");
  });
});
