// Task 2 (plan 2026-10-17-background-checkin-gate): background in-flight gate.
//
// In-flight = goal.waitingShells.length + every OTHER active session of this
// project (subtask sessions — no names, no parent links, COUNT ONLY: ruling
// "拿不到子任务或者shell名称不重要，我们只需要全程跟踪…数量 > 0").
//
// A terminal boundary with in-flight > 0 does NOT wake immediately (the
// session is already "waiting"); its entire action is arming the one-shot
// progress check (fires in Task 3). Any session activity cancels the timer;
// each in-flight boundary re-arms it (the clock only runs while quiescent).
//
// Time control follows the house pattern (watchdog.test.ts): real timers with
// small option values (checkInDelaySec 1s = the 1-second minimum) + STATE
// polling, never exact wall-clock moments.
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { goalStorageKey, type GoalRecord } from "../src/state.ts";
import { backgroundCheckInText } from "../src/wake.ts";
import type { HostEvent } from "../src/types.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";
const CHILD = "s2";

function goalOf(h: Harness, sessionID = S): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(sessionID)) as GoalRecord | undefined;
}

// 1s clock (checkInDelaySec: integer seconds >= 1)
const OPTS = resolveOptions({ checkInDelaySec: 1 });

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}

function started(id: string, sid: string): HostEvent {
  return ev("session.execution.started", id, { sessionID: sid });
}

function succeeded(id: string, sid: string): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID: sid });
}

function toolCalled(id: string, sid: string): HostEvent {
  return ev("session.tool.called", id, {
    input: {},
    executed: true,
    assistantMessageID: "am1",
    id: "tc1",
    sessionID: sid,
  });
}

function usageUpdated(id: string, sid: string): HostEvent {
  return ev("session.usage.updated", id, {
    sessionID: sid,
    tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
  });
}

// schema pinned in watchdog.test.ts (session-event.d.ts Shell.Started)
function shellStarted(id: string, shellID: string, sid = S): HostEvent {
  return ev("session.shell.started", id, {
    sessionID: sid,
    shell: {
      id: shellID,
      status: "running",
      command: "cmdA",
      cwd: "/w",
      shell: "bash",
      file: "script.sh",
      metadata: {},
      time: { started: Date.now() },
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Boot {
  h: Harness;
  ctrl: GoalController;
  stop: () => Promise<void>;
}

async function boot(overrides?: Record<string, unknown>): Promise<Boot> {
  const h = await createHarness(overrides);
  const ctrl = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop = await ctrl.start();
  return { h, ctrl, stop };
}

test("1: regression — boundary with a waiting shell does not wake immediately (gate via the new count)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set ShellGate");
  await h.emit(shellStarted("e1", "sh1"));
  await h.emit(succeeded("b1", S)); // boundary while in flight → no wake
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("2: NEW gate — boundary with an active subtask session (no shells) does not wake immediately", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set ChildGate");
  await h.emit(started("c1", CHILD)); // subtask session goes active
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // goal-session boundary, in flight = 1 → no wake
  expect(h.prompts.length).toBe(0);
  await stop();
});

/** The model works a turn on S (started + tool action): the boundary after it
 * is a genuine "turn ended, goal not done" boundary that WOULD wake under the
 * current semantics (toolCalled → stalls 0 → wake) — the gate's real job. */
async function modelWorked(h: Harness, tag: string): Promise<void> {
  await h.emit(started(`${tag}s`, S));
  await h.emit(toolCalled(`${tag}t`, S));
}

test("3: regression — nothing in flight → the immediate wake is unchanged", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set NoInFlight");
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S));
  expect(h.prompts.length).toBe(1);
  await stop();
});

test("4: another project's active session is not counted (sessionBelongs gate)", async () => {
  const { h, stop } = await boot({ projectID: "prj" });
  h.setSession(S, { projectID: "prj" });
  h.setSession(CHILD, { projectID: "other" });
  await h.commandExecutor(S, "/goal set CrossProj");
  await h.emit(started("c1", CHILD)); // gated out: different project
  await modelWorked(h, "b");
  await h.emit(succeeded("b1", S)); // in flight = 0 → immediate wake
  expect(h.prompts.length).toBe(1);
  await stop();
});

test("5: any session activity cancels the timer (no check-in after the deadline)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Cancel");
  await h.emit(started("c1", CHILD));
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight boundary → timer armed (1s)
  await h.emit(usageUpdated("u1", S)); // activity → cancel
  await sleep(1500); // past the deadline: a cancelled timer never fires
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("6: boundary storm while in flight — every boundary re-arms, no immediate wakes", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Storm");
  await h.emit(started("c1", CHILD));
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // arm
  await modelWorked(h, "b"); // a full working turn in between (cancels, re-arms below)
  await h.emit(succeeded("b2", S)); // re-arm
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("7: goal_wait quiet — in-flight boundary arms nothing (no wake, no timer)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Quiet");
  await h.emit(started("c1", CHILD));
  const reply = await h.toolExecutor("goal_wait", { minutes: 1 }, S);
  expect(reply).toContain("will not be woken");
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight boundary inside the waitUntil window
  await sleep(1500);
  expect(h.prompts.length).toBe(0);
  await stop();
});

/** Whitebox access to the in-memory turn flags (house pattern: test 14 of
 * test/watchdog.test.ts reaches private state through a cast). */
function turnsOf(ctrl: GoalController): Map<string, { active: boolean; toolCalled: boolean }> {
  return (ctrl as unknown as { turns: Map<string, { active: boolean; toolCalled: boolean }> }).turns;
}

// --- Task 3: the one-shot progress check (watchdog tick fires it) ---

test("9: due fires exactly once - pinned reminder text + goalControl metadata; a re-arm after activity fires again", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Fire9");
  await h.emit(started("c1", CHILD));
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight boundary → arm (1s)
  await sleep(1500); // past due: the 1ms tick fires the one-shot
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1));
  expect(h.prompts[0].input.metadata?.goalControl).toBe(true);
  await sleep(300); // one-shot: no recurrence before a re-arm
  expect(h.prompts.length).toBe(1);
  // a user message refreshes lastInbox (otherwise the boundary would take the
  // §7.1 (a) exception: a reply to OUR watchdog wake is arbitrated normally);
  // then a working turn + another in-flight boundary → re-arm → fires again
  await h.emit(ev("session.inbox.enqueued", "i1", {
    sessionID: S,
    inboxID: "inbox_9",
    item: { type: "user", payload: { text: "keep going" }, delivery: "queue" },
  }));
  await modelWorked(h, "b");
  await h.emit(succeeded("b2", S));
  await sleep(1500);
  expect(h.prompts.length).toBe(2);
  expect(h.prompts[1].input.text).toBe(backgroundCheckInText(1, 1));
  await stop();
});

test("10: child terminal event LOST (overcount persists) - the reminder still fires; no silent deadlock", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Lost10");
  await h.emit(started("c1", CHILD)); // the child NEVER reports a terminal boundary
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in flight = 1, forever
  await sleep(1500);
  expect(h.prompts.length).toBe(1); // the reminder fires despite the stale count
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1));
  await stop();
});

test("11: due passes while the session is ACTIVE (lost-started belt) - held; once idle the pending deadline fires", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set Hold11");
  await h.emit(started("c1", CHILD));
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // arm (1s)
  // simulate a lost execution.started: the host is active but we never saw it
  turnsOf(ctrl).set(S, { active: true, toolCalled: false });
  await sleep(1500); // due passes while active: the tick holds, the deadline stays pending
  expect(h.prompts.length).toBe(0);
  turnsOf(ctrl).get(S)!.active = false; // the turn ends (its boundary lost too)
  await sleep(500); // next tick: idle now → the pending deadline fires
  expect(h.prompts.length).toBe(1);
  await stop();
});

test("12: quiet (goal_wait window) covers the deadline - no reminder is injected", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Quiet12");
  await h.emit(started("c1", CHILD));
  await h.toolExecutor("goal_wait", { minutes: 1 }, S); // waitUntil in force
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight boundary inside the window → armed nothing
  await sleep(1500); // the due moment passes inside the quiet window
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("13: terminal guard - goal cleared after arming: no ghost reminder, checkinDue cleared, tick disarmed", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set Guard13");
  await h.emit(started("c1", CHILD));
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // arm (1s)
  // /goal clear is fail-closed: it needs a user clear request in the transcript
  h.setMessages(S, [{ id: "m1", type: "user", text: "please discard the branch and stop the work" }]);
  await h.commandExecutor(S, "/goal clear");
  expect(goalOf(h)!.status).toBe("cleared");
  await sleep(1500); // the deadline passes: the ghost rule must hold it back
  expect(h.prompts.length).toBe(0);
  const any = ctrl as unknown as { checkinDue: Map<string, unknown>; wdTimers: Map<string, unknown> };
  expect(any.checkinDue.has(S)).toBe(false);
  expect(any.wdTimers.has(S)).toBe(false);
  await stop();
});

test("14: stale shell (started, no ended) - no self-heal, no permanent silence: the reminder rhythm keeps the session alive", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Stale14");
  await h.emit(shellStarted("e1", "sh1")); // the shell never reports its end
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in flight (the stale shell) → arm
  await sleep(1500);
  expect(h.prompts.length).toBe(1); // a reminder — never a fabricated "lost"
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1));
  expect(h.prompts[0].input.text).not.toContain("lost");
  await stop();
});
