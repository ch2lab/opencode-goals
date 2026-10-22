// 2026-10-18 audit ruling A: per-goal decision telemetry. The controller
// counts every boundary decision into GoalRecord.decisions (wake/hold/skip/
// paused) so a TERMINAL ARCHIVE answers "how did the loop behave during this
// goal's life" without the volatile /tmp decision log (a host restart wipes
// it). One bucket per logged decision; `paused` = the provider-pause incident
// (itself logged as a skip with its own reason) — the four buckets partition
// every decision-log line of the goal.
import { expect, test } from "bun:test";
import {
  archivedGoalKey,
  bumpGoalDecision,
  createGoal,
  goalStorageKey,
  type GoalDecisions,
  type GoalRecord,
} from "../src/state.ts";
import { resolveOptions } from "../src/options.ts";
import { GoalController } from "../src/controller.ts";
import type { HostEvent, SessionMessage } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

// ---------------------------------------------------------------------------
// Unit: the state helper
// ---------------------------------------------------------------------------

test("createGoal initializes decisions to all-zero", () => {
  const g = createGoal({ sessionID: S, objective: "x" });
  expect(g.decisions).toEqual({ wake: 0, hold: 0, skip: 0, paused: 0 });
});

test("bumpGoalDecision increments the bucket", () => {
  const g = createGoal({ sessionID: S, objective: "x" });
  bumpGoalDecision(g, "wake");
  bumpGoalDecision(g, "wake");
  bumpGoalDecision(g, "hold");
  expect(g.decisions).toEqual({ wake: 2, hold: 1, skip: 0, paused: 0 });
});

test("bumpGoalDecision lazily initializes a legacy record (no decisions field, pre-2026-10-18 shape)", () => {
  const g = createGoal({ sessionID: S, objective: "x" });
  delete (g as { decisions?: GoalDecisions }).decisions; // simulate a record persisted before the field existed
  bumpGoalDecision(g, "skip");
  expect((g as GoalRecord).decisions).toEqual({ wake: 0, hold: 0, skip: 1, paused: 0 });
});

// ---------------------------------------------------------------------------
// Controller: one bucket per decision path
// ---------------------------------------------------------------------------

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}

function succeeded(id: string, sessionID = S): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID });
}

function started(id: string, sessionID = S): HostEvent {
  return ev("session.execution.started", id, { sessionID });
}

async function setGoalDirect(h: Harness): Promise<GoalRecord> {
  const g = createGoal({ sessionID: S, objective: "Direct" });
  await h.probe.storageSet(goalStorageKey(S), g);
  return g;
}

/** Errored assistant message in the 129 provider.* contract shape. */
function providerErr(): SessionMessage {
  return {
    id: "err",
    type: "assistant",
    error: { type: "provider.quota", message: "Upstream request failed: provider.quota" },
  };
}

test("wake boundary counts decisions.wake", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  await setGoalDirect(h);
  await h.emit(succeeded("e1")); // boundary, no in-flight → wake
  expect(h.prompts.length).toBe(1);
  expect(goalDecisions(h)).toEqual({ wake: 1, hold: 0, skip: 0, paused: 0 });
  await stop();
});

test("in-flight own shell boundary counts decisions.hold (no wake)", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  await setGoalDirect(h);
  h.setSession(S, { location: { directory: "/work" } }); // shellList needs the directory
  h.setShells([{ id: "sh1", status: "running", sessionID: S, background: true }]); // own in-flight shell (§54: unflagged = foreground)
  await h.emit(succeeded("e1")); // boundary with in-flight 1 → hold
  expect(h.prompts.length).toBe(0);
  expect(goalDecisions(h)).toEqual({ wake: 0, hold: 1, skip: 0, paused: 0 });
  await stop();
});

test("dead host context (shell query failure) counts decisions.skip", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  await setGoalDirect(h);
  h.setSession(S, { location: { directory: "/work" } });
  h.failShellList(true); // the query fails → ownKnown false → skip
  await h.emit(succeeded("e1"));
  expect(h.prompts.length).toBe(0);
  expect(goalDecisions(h)).toEqual({ wake: 0, hold: 0, skip: 1, paused: 0 });
  await stop();
});

test("provider failure streak pause counts decisions.paused", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  await setGoalDirect(h);
  h.setMessages(S, [{ id: "u1", type: "user" }, providerErr()]);
  await h.emit(succeeded("e1")); // first errored boundary → one doomed wake attempt
  expect(h.prompts.length).toBe(1);
  expect(goalDecisions(h)!.paused).toBe(0); // hiccup tolerance: not paused yet
  await h.emit(started("e2")); // the doomed turn starts
  await h.emit(succeeded("e3")); // second consecutive errored boundary → paused
  expect(goalDecisions(h)).toEqual({ wake: 1, hold: 0, skip: 0, paused: 1 });
  await stop();
});

test("a goal's terminal archive carries its decision counts", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  const g = await setGoalDirect(h);
  await h.emit(succeeded("e1")); // wake
  expect(goalDecisions(h)!.wake).toBe(1);
  await h.commandExecutor(S, "/goal complete bun test passed: all 12 tests green in goal-loop.test.ts");
  // completed → finishGoal: archive copy = the record with its counts
  const archived = h.storage.get(archivedGoalKey(S, g.id)) as GoalRecord | undefined;
  expect(archived?.status).toBe("completed");
  expect(archived?.decisions).toEqual({ wake: 1, hold: 0, skip: 0, paused: 0 });
  await stop();
});

function goalDecisions(h: Harness): GoalDecisions {
  return (h.storage.get(goalStorageKey(S)) as GoalRecord).decisions!;
}
