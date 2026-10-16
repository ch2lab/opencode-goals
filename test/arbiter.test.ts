// Task 8: boundary arbiter + wake loop (spec §6 / §11 / §15-9), driven
// through the deterministic harness (test/harness.ts). `await h.emit(e)`
// resolves only after the controller's consumer loop has PROCESSED e —
// tests are linear, no races.
//
// Event property assumptions pinned by this file (brief ruling: code the
// current assumption, pin it here, mark TODO(task13) where genuinely open):
//  - every consumed session.* payload carries `sessionID`
//    (schema/dist/session-event.d.ts, schema/dist/event-manifest.d.ts);
//  - session.execution.interrupted: data.reason ∈ { user, shutdown,
//    superseded, inactivity } — "superseded" (the 4th .d.ts value the brief
//    three-way does not cover) is treated record-only like "user"
//    (TODO(task13));
//  - session.usage.updated: data.tokens = { input, output, reasoning,
//    cache: { read, write } } — total = sum of all five fields (cumulative
//    value, direct assignment per spec §11);
//  - session.inbox.enqueued: data = { item: { type, payload, delivery },
//    inboxID, sessionID };
//  - session.idle: data = { sessionID } (ephemeral) → treated as a valid
//    terminal boundary (ruling fallback "only succeeded/failed/interrupted"
//    applies only when the payload lacks sessionID — here it does not);
//  - a lastInbox that is neither user, nor our wake, nor a goalControl
//    synthetic (compaction / move / unmarked synthetic / untracked) counts
//    as a stall (fail toward stall counting, never miss the main pain);
//  - "stalls exact N before the wake" is asserted post-event: the stall
//    bump and the wake injection happen inside one handleEvent, so the
//    stored value after `await h.emit(boundary)` is the value the wake saw.
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { archivedGoalKey, createGoal, goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import type { HostEvent } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Boot {
  h: Harness;
  ctrl: GoalController;
  stop: () => Promise<void>;
  judgeCalls: Array<{ goalID: string; texts: string[] }>;
}

async function boot(existing?: Harness): Promise<Boot> {
  const h = existing ?? (await createHarness());
  const judgeCalls: Boot["judgeCalls"] = [];
  const ctrl = new GoalController(h.probe, resolveOptions({}), {
    judge: {
      judge: async (goal, texts) => {
        judgeCalls.push({ goalID: goal.id, texts: [...texts] });
        return { verdict: "continue", reason: "x" };
      },
    },
  });
  const stop = await ctrl.start();
  return { h, ctrl, stop, judgeCalls };
}

function goalOf(h: Harness, sessionID = S): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(sessionID)) as GoalRecord | undefined;
}

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}

// schema/dist/session-event.d.ts: data = { sessionID }.
function succeeded(id: string, sessionID = S): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID });
}

function started(id: string, sessionID = S): HostEvent {
  return ev("session.execution.started", id, { sessionID });
}

// schema/dist/session-event.d.ts: data = { reason, sessionID }.
function interrupted(id: string, reason: string, sessionID = S): HostEvent {
  return ev("session.execution.interrupted", id, { reason, sessionID });
}

// schema/dist/session-event.d.ts: data = { input, executed, assistantMessageID, id, sessionID }.
function toolCalled(id: string, sessionID = S): HostEvent {
  return ev("session.tool.called", id, {
    input: {},
    executed: true,
    assistantMessageID: "am1",
    id: "tc1",
    sessionID,
  });
}

// schema/dist/session-event.d.ts (UsageUpdated): data = { cost, tokens, sessionID }.
function usage(id: string, tokens: Record<string, unknown>, sessionID = S): HostEvent {
  return ev("session.usage.updated", id, { tokens, sessionID });
}

// schema/dist/session-event.d.ts (InboxEnqueued): data = { item, inboxID, sessionID }.
function enqueuedUser(inboxID: string, sessionID = S): HostEvent {
  return ev("session.inbox.enqueued", `q_${inboxID}`, {
    inboxID,
    sessionID,
    item: { type: "user", payload: { text: "keep going" }, delivery: "queue" },
  });
}

/** A goal written straight to storage (no /goal set → no control lastInbox). */
async function setGoalDirect(h: Harness, sessionID = S): Promise<GoalRecord> {
  const g = createGoal({ sessionID, objective: "Direct" });
  await h.probe.storageSet(goalStorageKey(sessionID), g);
  return g;
}

// ---------------------------------------------------------------------------
// 1. boundary wake
// ---------------------------------------------------------------------------

test("1: boundary wake — succeeded with sessionID + event id injects a queue wake", async () => {
  const { h, stop } = await boot();
  const g = await setGoalDirect(h);
  await h.emit(succeeded("e1"));
  expect(h.prompts.length).toBe(1);
  const p = h.prompts[0].input;
  expect(p.sessionID).toBe(S);
  expect(p.delivery).toBe("queue");
  expect(p.metadata?.goalWake).toBe(true);
  expect(p.metadata?.goalID).toBe(g.id);
  expect(p.metadata?.goalTurn).toBe(1);
  expect(p.text).toContain(g.id);
  const after = goalOf(h)!;
  expect(after.used.turns).toBe(1);
  expect(after.continuations).toBe(1);
  expect(after.lastHandledEventID).toBe("e1");
  await stop();
});

// ---------------------------------------------------------------------------
// 2. dedup (same eventID / continuationPending window / started re-arms)
// ---------------------------------------------------------------------------

test("2: dedup — same eventID once; pending window ignores; started re-arms", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Dedup");
  await h.emit(enqueuedUser("i1"));
  await h.emit(succeeded("e1"));
  await h.emit(succeeded("e1")); // same id → deduped
  // continuationPending (no started yet): boundary ignored, not continued
  await h.emit(succeeded("e2"));
  expect(h.prompts.length).toBe(1);
  expect(goalOf(h)!.lastHandledEventID).toBe("e2"); // recorded, no continuation
  await h.emit(started("s1"));
  await h.emit(succeeded("e3"));
  expect(h.prompts.length).toBe(2);
  expect(goalOf(h)!.lastHandledEventID).toBe("e3");
  await stop();
});

test("2b: pending window is bounded — at most one boundary is skipped (ruling I1)", async () => {
  const { h, stop } = await boot();
  await setGoalDirect(h);
  await h.emit(succeeded("e1")); // wake W1 injected → window opens
  expect(h.prompts.length).toBe(1);
  await h.emit(succeeded("e2")); // first distinct boundary in window → skipped (recorded)
  expect(h.prompts.length).toBe(1);
  expect(goalOf(h)!.lastHandledEventID).toBe("e2");
  await h.emit(succeeded("e3")); // second distinct → window closes, e3 proceeds → wake W2
  expect(h.prompts.length).toBe(2);
  expect(goalOf(h)!.lastHandledEventID).toBe("e3");
  await stop();
});

// ---------------------------------------------------------------------------
// 3. tool.called zeroes the stall count
// ---------------------------------------------------------------------------

test("3: tool.called zeroes the stall count (1 → 0)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Act");
  await h.emit(enqueuedUser("i1"));
  await h.emit(succeeded("e1")); // wake W1 (user → stalls 0)
  await h.emit(started("s1"));
  await h.emit(succeeded("e2")); // wake, no action → stalls 1
  expect(goalOf(h)!.stalls).toBe(1);
  await h.emit(started("s2"));
  await h.emit(toolCalled("t1"));
  await h.emit(succeeded("e3")); // toolCalled → wake with stalls 0
  expect(h.prompts.length).toBe(3);
  expect(goalOf(h)!.stalls).toBe(0);
  await stop();
});

// ---------------------------------------------------------------------------
// 4. attribution three-ways
// ---------------------------------------------------------------------------

test("4a: wake-originated no-action boundaries count stalls 1 → 2", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Stall");
  await h.emit(enqueuedUser("i1"));
  await h.emit(succeeded("e1")); // wake W1: user boundary → stalls 0
  expect(goalOf(h)!.stalls).toBe(0);
  await h.emit(started("s1"));
  await h.emit(succeeded("e2")); // lastInbox = our wake, no tool → stalls 1
  expect(goalOf(h)!.stalls).toBe(1);
  expect(h.prompts.length).toBe(2);
  await h.emit(started("s2"));
  await h.emit(succeeded("e3")); // again → stalls 2
  expect(goalOf(h)!.stalls).toBe(2);
  expect(h.prompts.length).toBe(3);
  await stop();
});

test("4b: a user inbox item before the boundary resets stalls (person present is not a stall)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Reset");
  await h.emit(enqueuedUser("i1"));
  await h.emit(succeeded("e1")); // wake W1 (stalls 0)
  await h.emit(started("s1"));
  await h.emit(succeeded("e2")); // wake, no action → stalls 1
  expect(goalOf(h)!.stalls).toBe(1);
  await h.emit(started("s2"));
  await h.emit(enqueuedUser("i2")); // user present again
  await h.emit(succeeded("e3")); // no tool.called, user boundary → wake with stalls 0
  expect(h.prompts.length).toBe(3);
  expect(goalOf(h)!.stalls).toBe(0);
  await stop();
});

test("4c: goalControl synthetic (via /goal command) before the boundary → record only, no wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Control"); // its synthetic carries goalControl
  await h.emit(succeeded("e1"));
  expect(h.prompts.length).toBe(0); // no self-triggered double wake
  expect(goalOf(h)!.lastHandledEventID).toBe("e1");
  await stop();
});

// ---------------------------------------------------------------------------
// 5. stall ladder → judge entry point
// ---------------------------------------------------------------------------

test("5: three consecutive no-action boundaries hit the stall ladder → judge called exactly once", async () => {
  const { h, stop, judgeCalls } = await boot();
  await h.commandExecutor(S, "/goal set Judge");
  const g = goalOf(h)!;
  // transcript: user boundary at the head, then four assistant no-action texts
  h.setMessages(S, [
    { id: "m1", type: "user", text: "start" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "no action one" }] },
    { id: "m3", type: "assistant", content: [{ type: "text", text: "no action two" }] },
    { id: "m4", type: "assistant", content: [{ type: "text", text: "no action three" }] },
    { id: "m5", type: "assistant", content: [{ type: "text", text: "no action four" }] },
  ]);
  await h.emit(enqueuedUser("i1"));
  await h.emit(succeeded("e1")); // wake W1 (user → stalls 0)
  await h.emit(started("s1"));
  await h.emit(succeeded("e2")); // stalls 1 → wake W2
  expect(goalOf(h)!.stalls).toBe(1);
  await h.emit(started("s2"));
  await h.emit(succeeded("e3")); // stalls 2 → wake W3
  expect(goalOf(h)!.stalls).toBe(2);
  expect(judgeCalls.length).toBe(0); // threshold (3) not reached yet
  await h.emit(started("s3"));
  await h.emit(succeeded("e4")); // stalls 3 >= stallLimit → judge → continue
  expect(goalOf(h)!.stalls).toBe(0); // Task 9 disposition: continue zeros stalls
  expect(goalOf(h)!.judgeUsed).toBe(true); // gate closed (one judge per goal)
  expect(h.prompts.length).toBe(4);
  expect(judgeCalls.length).toBe(1); // exactly once
  expect(judgeCalls[0].goalID).toBe(g.id);
  expect(judgeCalls[0].texts.length).toBeLessThanOrEqual(3);
  expect(judgeCalls[0].texts).toContain("no action four"); // includes the latest
  expect(judgeCalls[0].texts[0]).toBe("no action two"); // max 3: oldest trimmed
  // judge result disposed inline (Task 9): this verdict carries no
  // instruction → the wake carries no judge paragraph.
  expect(h.prompts[3].input.text).not.toContain("裁判提示");
  await stop();
});

test("5b: id-less boundary still persists usage increments (unconditional saveGoal)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set NoID");
  await h.emit(enqueuedUser("i1"));
  // A terminal boundary WITHOUT an event id (id-less envelope).
  await h.emit({ type: "session.execution.succeeded", properties: { sessionID: S } });
  const after = goalOf(h)!;
  expect(after.used.turns).toBe(1); // wake increments persist even with no id
  expect(after.continuations).toBe(1);
  expect(after.lastHandledEventID).toBeUndefined(); // id-less: nothing to record
  await stop();
});

// ---------------------------------------------------------------------------
// 6. budget double path
// ---------------------------------------------------------------------------

test("6: budget — tokens path (usage.updated cumulative + boundary) and turns path", async () => {
  // tokens path: cumulative total reaches the cap at the next boundary
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Budget --tokens 100000");
  const g = goalOf(h)!;
  await h.emit(usage("u1", {
    input: 60000,
    output: 20000,
    reasoning: 5000,
    cache: { read: 15000, write: 0 },
  }));
  expect(goalOf(h)!.used.tokens).toBe(100000); // direct assignment, not accumulated
  await h.emit(started("s1"));
  await h.emit(succeeded("e1")); // budget check precedes attribution → terminal, no wake
  expect(goalOf(h)!.status).toBe("budget_limited");
  expect(h.prompts.length).toBe(0);
  expect(h.synthetics[h.synthetics.length - 1].input.text).toContain("budget_limited");
  expect(h.storage.get(archivedGoalKey(S, g.id))).toBeDefined(); // archive readable

  // turns path (isolated session s2): cap.turns = 3
  const S2 = "s2";
  await h.commandExecutor(S2, "/goal set Turns --turns 3");
  await h.emit(enqueuedUser("i2", S2));
  for (let i = 1; i <= 3; i++) {
    await h.emit(started(`s${i}`, S2));
    await h.emit(succeeded(`t${i}`, S2));
  }
  expect(goalOf(h, S2)!.used.turns).toBe(3);
  expect(goalOf(h, S2)!.status).toBe("active");
  await h.emit(started("s4", S2));
  await h.emit(succeeded("t4", S2));
  expect(goalOf(h, S2)!.status).toBe("budget_limited");
  expect(h.prompts.filter((p) => p.input.sessionID === S2).length).toBe(3);
  expect(h.storage.get(archivedGoalKey(S2, goalOf(h, S2)!.id))).toBeDefined();
  await stop();
});

// ---------------------------------------------------------------------------
// 7. interrupt three-way
// ---------------------------------------------------------------------------

test("7: interrupt — user no wake / inactivity wakes (normal boundary) / shutdown no wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Interrupt");
  await h.emit(enqueuedUser("i1"));
  await h.emit(interrupted("e1", "user"));
  expect(h.prompts.length).toBe(0);
  expect(goalOf(h)!.lastHandledEventID).toBe("e1");
  await h.emit(interrupted("e2", "inactivity")); // silent stall: wake
  expect(h.prompts.length).toBe(1);
  expect(goalOf(h)!.lastHandledEventID).toBe("e2");
  await h.emit(started("s1"));
  await h.emit(interrupted("e3", "shutdown"));
  expect(h.prompts.length).toBe(1);
  expect(goalOf(h)!.lastHandledEventID).toBe("e3");
  await stop();
});

// ---------------------------------------------------------------------------
// 8. blocked resume
// ---------------------------------------------------------------------------

test("8: blocked + user inbox resumes (active, stalls 0, wake); same inboxID never resumes twice", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Blocked");
  const reply = await h.toolExecutor("goal_block", { reason: "external dependency down" }, S);
  expect(reply).toContain("blocked");
  const g = goalOf(h)!;
  await h.emit(enqueuedUser("i1"));
  const after = goalOf(h)!;
  expect(after.id).toBe(g.id);
  expect(after.status).toBe("active");
  expect(after.stalls).toBe(0);
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.metadata?.goalWake).toBe(true);
  expect(h.prompts[0].input.metadata?.goalID).toBe(g.id);
  expect(after.used.turns).toBe(1);
  expect(after.continuations).toBe(1);
  await h.emit(enqueuedUser("i1")); // same inboxID → no second resume
  expect(h.prompts.length).toBe(1);
  expect(goalOf(h)!.status).toBe("active");
  await stop();
});

// ---------------------------------------------------------------------------
// 9. restart replay
// ---------------------------------------------------------------------------

test("9: restart replay — a new controller on the same storage does not re-wake handled eventIDs", async () => {
  const b1 = await boot();
  await b1.h.commandExecutor(S, "/goal set Replay");
  await b1.h.emit(enqueuedUser("i1"));
  await b1.h.emit(succeeded("e1"));
  expect(b1.h.prompts.length).toBe(1);
  expect(goalOf(b1.h)!.lastHandledEventID).toBe("e1");
  await b1.stop();

  const b2 = await boot(b1.h); // same harness (stream) + same storage
  await b2.h.emit(succeeded("e1")); // replayed → deduped by persisted lastHandledEventID
  expect(b2.h.prompts.length).toBe(1);
  await b2.h.emit(succeeded("e2")); // new id → wakes
  expect(b2.h.prompts.length).toBe(2);
  expect(goalOf(b2.h)!.lastHandledEventID).toBe("e2");
  await b2.stop();
});

// ---------------------------------------------------------------------------
// 14. Task 14 Fix 3a: options.wakeText rides the boundary wake (controller
// wiring — buildWakeMessage path). wake.test.ts pins the builder itself,
// including the byte-identical default.
// ---------------------------------------------------------------------------

test("14: options.wakeText appends 补充指示 to the boundary wake prompt", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({ wakeText: "务必先看 CI 日志" }), {});
  const stop = await ctrl.start();
  const g = await setGoalDirect(h);
  await h.emit(succeeded("e14")); // boundary → wake injection
  expect(h.prompts.length).toBe(1);
  const p = h.prompts[0].input;
  expect(p.metadata?.goalWake).toBe(true);
  expect(p.metadata?.goalID).toBe(g.id);
  expect(p.text).toContain(`[GOAL ${g.id}`); // the normal wake body is intact
  expect(p.text).toContain("补充指示: 务必先看 CI 日志"); // options.wakeText landed
  expect(p.text.endsWith("补充指示: 务必先看 CI 日志")).toBe(true); // final line
  await stop();
});
