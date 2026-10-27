// §60 (2026-10-26 ruling): goal_wait is an ASYNC wait primitive. The default
// (background=false) BLOCKS the calling turn: the handler hangs on a promise
// that resolves from an EVENT — the clock shell (host-side `sleep`) exits,
// another session shell ends, a user message arrives, or the wait is killed —
// or from the JS fallback timer. The persisted waitUntil (§57) stays the
// reload fallback; the tick SKIPS its deadline delivery while a blocking wait
// is in flight (the tool return is the wake) and backfills it after a reload.
import { test, expect } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const OPTS = resolveOptions({ checkInDelaySec: 1 });
const S = "ses_wait60";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(): Promise<{ h: Harness; ctrl: GoalController; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop = await ctrl.start();
  return { h, ctrl, stop };
}

async function armGoal(h: Harness): Promise<void> {
  await h.commandExecutor(S, "/goal set B");
  h.setSession(S, { location: { directory: "/w" } });
}

function goalOf(h: Harness): GoalRecord {
  const g = h.storage.get(goalStorageKey(S)) as GoalRecord | undefined;
  if (g === undefined) throw new Error("no goal record");
  return g;
}

/** The first fired clock shell's id (the harness shellFire stub names it
 * `sh_wait_<n>` in call order). */
function clockShell(h: Harness): string {
  expect(h.shellFireCalls.length).toBeGreaterThanOrEqual(1);
  return `sh_wait_${h.shellFireCalls.length}`;
}

/** Fire the BLOCKING goal_wait (default — no `background`): the returned
 * promise hangs until an event resolves the wait. */
function fireWait(h: Harness): Promise<string> {
  return h.toolExecutor("goal_wait", { minutes: 1 }, S);
}

test("B1: deadline — the clock shell's natural exit returns 'wait complete' and CONSUMES the tick's deadline delivery (waitWakeSent persists; no double wake)", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100); // armed: clock shell fired, pendingWaits set
  expect(h.shellFireCalls[0].command).toBe("sleep 60"); // the clock is a host `sleep`
  expect(goalOf(h).waitUntil).toBeTypeOf("number"); // persisted reload fallback
  await h.emit({ type: "shell.exited", id: "b1a", properties: { id: clockShell(h), exit: 0, status: "exited" } });
  const reply = await p;
  expect(reply).toContain("wait complete");
  expect(reply).toContain("1 min elapsed");
  expect(goalOf(h).waitWakeSent).toBe(true); // the tick must not deliver at the deadline
  await sleep(400);
  expect(h.prompts.length).toBe(0); // no tick wake (the tool return was the stimulus)
  expect(h.shellKillCalls).toEqual([]); // deadline: the sleep already ran out — never killed
  await stop();
});

test("B2: cancellation — the clock shell killed (the user's escape hatch) returns 'wait cancelled' and closes the window (waitUntil cleared)", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  const cs = clockShell(h);
  await h.emit({ type: "shell.exited", id: "b2a", properties: { id: cs, exit: -1, status: "killed" } });
  const reply = await p;
  expect(reply).toContain("wait cancelled");
  expect(goalOf(h).waitUntil).toBeUndefined(); // early exit: no ghost deadline
  expect(goalOf(h).waitWakeSent).toBeUndefined();
  await sleep(400);
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("B3: another session shell ends during the wait — early 'shell' return (the event path for server-fired shells); the clock shell is killed", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  // A second server-fired shell appears in the session (shell.created carries
  // the session on info.metadata.sessionID — the ONLY shell path that emits
  // these events on the real host).
  await h.emit({
    type: "shell.created",
    id: "b3a",
    properties: {
      info: { id: "sh_other_1", metadata: { sessionID: S, background: true }, time: { started: Date.now() } },
    },
  });
  await h.emit({ type: "shell.exited", id: "b3b", properties: { id: "sh_other_1", exit: 0, status: "exited" } });
  const reply = await p;
  expect(reply).toContain("wait interrupted");
  expect(reply).toContain("sh_other_1");
  expect(goalOf(h).waitUntil).toBeUndefined(); // early exit closes the window
  expect(h.shellKillCalls).toContain(clockShell(h)); // the clock shell does not outlive the wait
  await sleep(400);
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("B4: a USER message during the wait returns early ('respond to it now') — and only a real user message: our own injected wake does NOT interrupt", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  // Our own loop wake (goalControl marker) arrives first: no interruption.
  await h.emit({
    type: "session.inbox.enqueued",
    id: "b4a",
    properties: {
      sessionID: S,
      inboxID: "inbox_b4_wake",
      item: {
        type: "synthetic",
        payload: { text: "wake", metadata: { goalControl: true } },
        delivery: "now",
      },
    },
  });
  await sleep(150);
  expect(h.shellKillCalls).toEqual([]); // the control item did NOT resolve the wait (the clock shell is alive)
  // …then a real user message: early return.
  await h.emit({
    type: "session.inbox.enqueued",
    id: "b4b",
    properties: {
      sessionID: S,
      inboxID: "inbox_b4_user",
      item: { type: "user", payload: { text: "stop waiting" }, delivery: "now" },
    },
  });
  const reply = await p;
  expect(reply).toContain("user message");
  expect(goalOf(h).waitUntil).toBeUndefined();
  expect(h.shellKillCalls).toContain(clockShell(h));
  await stop();
});

test("B5: degradation — the clock fire FAILS (store unavailable): the wait is timer-only yet a user message still resolves it (no hang, no crash)", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  h.failShellList(true); // the claim's before-snapshot throws → timer-only
  const p = fireWait(h);
  await sleep(100);
  expect(h.shellFireCalls.length).toBe(0); // fire was never reached (snapshot first)
  await h.emit({
    type: "session.inbox.enqueued",
    id: "b5a",
    properties: {
      sessionID: S,
      inboxID: "inbox_b5",
      item: { type: "user", payload: { text: "hi" }, delivery: "now" },
    },
  });
  const reply = await p;
  expect(reply).toContain("user message");
  expect(h.shellKillCalls).toEqual([]); // no clock shell to kill
  await stop();
});

test("B6: resolution is ONE-SHOT — a user message and the clock exit racing: exactly one return, no hang", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  const cs = clockShell(h);
  await h.emit({
    type: "session.inbox.enqueued",
    id: "b6a",
    properties: {
      sessionID: S,
      inboxID: "inbox_b6",
      item: { type: "user", payload: { text: "now" }, delivery: "now" },
    },
  });
  await h.emit({ type: "shell.exited", id: "b6b", properties: { id: cs, exit: 0, status: "exited" } });
  const reply = await p;
  expect(reply).toContain("user message"); // the user event won the race (emitted first, stream-ordered)
  expect(goalOf(h).waitUntil).toBeUndefined();
  await stop();
});

test("B7: the tick SKIPS its deadline delivery while a blocking wait is in flight (tool return = the wake), and does NOT backfill after the deadline resolution", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  // Shift the PERSISTED deadline into the past (test-scale): the tick would
  // deliver "Goal wait period ended" at this moment — unless the in-flight
  // blocking wait is registered (the avoidance).
  const g = goalOf(h);
  g.waitUntil = Date.now() - 1000;
  h.storage.set(goalStorageKey(S), g);
  await sleep(500);
  expect(h.prompts.length).toBe(0); // AVOIDED — the tool return will be the wake
  // The clock shell "naturally exits" (the sleep ran out — past due).
  await h.emit({ type: "shell.exited", id: "b7a", properties: { id: clockShell(h), exit: 0, status: "exited" } });
  const reply = await p;
  expect(reply).toContain("wait complete");
  expect(goalOf(h).waitWakeSent).toBe(true);
  await sleep(400);
  expect(h.prompts.length).toBe(0); // consumed — the tick still must not double-fire
  await stop();
});

test("B8: a NON-inactivity interrupt (user Esc) ABANDONS the wait — killed, window closed", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  await h.emit({ type: "session.execution.interrupted", id: "b8a", properties: { sessionID: S, reason: "user" } });
  const reply = await p;
  expect(reply).toContain("wait cancelled");
  expect(goalOf(h).waitUntil).toBeUndefined();
  expect(h.shellKillCalls).toContain(clockShell(h));
  await stop();
});

test("B9: an INACTIVITY interrupt (explicit evict) keeps the reload fallback — window + host clock shell ALIVE (the reloaded instance's tick backfills), only the in-memory wait is dropped", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  void p; // the host settles the in-flight tool — the plugin must not resolve it
  await sleep(100);
  await h.emit({ type: "session.execution.interrupted", id: "b9a", properties: { sessionID: S, reason: "inactivity" } });
  await sleep(150);
  expect(goalOf(h).waitUntil).toBeTypeOf("number"); // the window SURVIVES for the reload backfill
  expect(h.shellKillCalls).toEqual([]); // the host-side clock keeps ticking
  // The in-memory wait is dropped: the watchdog stays armed (the persisted
  // window keeps its heartbeat — the §57 invariant).
  await stop();
});

test("B10: incident regression — an OWN injectWake enqueued mid-wait (the wakeInbox slot already overwritten by a newer wake) must NOT resolve the wait as a user message (payload goalWake marker is authoritative, §50 discipline)", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100);
  // A stale own-wake: its id no longer sits in the single wakeInbox slot
  // (a newer wake overwrote it) — but its payload carries goalWake: true.
  // Pre-fix this was classified kind "user" and killed the wait (the 2026-10-26
  // verify incident: a countdown wake storm resolved a 1-min wait in 15s).
  await h.emit({
    type: "session.inbox.enqueued",
    id: "b10a",
    properties: {
      sessionID: S,
      inboxID: "inbox_stale_wake",
      item: {
        type: "user",
        payload: { text: "wake", metadata: { goalWake: true, goalID: "g_x", goalTurn: 3 } },
        delivery: "queue",
      },
    },
  });
  await sleep(150);
  expect(h.shellKillCalls).toEqual([]); // still hanging — the own-wake did NOT interrupt it
  // A REAL user message still interrupts.
  await h.emit({
    type: "session.inbox.enqueued",
    id: "b10b",
    properties: {
      sessionID: S,
      inboxID: "inbox_b10_user",
      item: { type: "user", payload: { text: "real user" }, delivery: "now" },
    },
  });
  const reply = await p;
  expect(reply).toContain("user message");
  await stop();
});

test("B11: §64 a snapshotted subtask session goes terminal mid-wait — its event returns the wait EARLY ('subtask … ended'); the deadline timer stops, the clock shell is killed, the window closes", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  // A subtask in flight AT ARM (parentID chain + active map — the §51 query).
  h.setSession("ses_subtask", { location: { directory: "/w" }, parentID: S });
  h.setActiveSessions({ [S]: "running", ses_subtask: "running" });
  const p = fireWait(h);
  await sleep(100); // armed: the snapshot contains ses_subtask
  // The subtask's turn ends — the host emits its terminal boundary.
  await h.emit({ type: "session.idle", id: "b11a", properties: { sessionID: "ses_subtask" } });
  const reply = await p;
  expect(reply).toContain("subtask");
  expect(reply).toContain("ses_subtask");
  expect(reply).toContain("ended");
  expect(goalOf(h).waitUntil).toBeUndefined(); // early exit closes the window (no ghost deadline)
  expect(h.shellKillCalls).toContain(clockShell(h)); // the clock does not outlive the wait
  await sleep(400);
  expect(h.prompts.length).toBe(0); // no loop wake — the tool return is the wake
  await stop();
});

test("B12: §64 snapshot semantics — a subtask started AFTER the arm is invisible to the wait (no spurious wake); the clock's natural exit still owns the deadline return", async () => {
  const { h, stop } = await boot();
  await armGoal(h);
  const p = fireWait(h);
  await sleep(100); // armed: the snapshot is EMPTY (no subtask at arm)
  // A subtask appears mid-wait, then ends — it must NOT wake the wait.
  h.setSession("ses_late", { location: { directory: "/w" }, parentID: S });
  h.setActiveSessions({ [S]: "running", ses_late: "running" });
  await h.emit({ type: "session.idle", id: "b12a", properties: { sessionID: "ses_late" } });
  await sleep(150);
  expect(h.shellKillCalls).toEqual([]); // still hanging — the late subtask is not in the snapshot
  // The clock shell's natural exit returns the deadline as before.
  await h.emit({ type: "shell.exited", id: "b12b", properties: { id: clockShell(h), exit: 0, status: "exited" } });
  const reply = await p;
  expect(reply).toContain("wait complete");
  expect(goalOf(h).waitWakeSent).toBe(true);
  await stop();
});
