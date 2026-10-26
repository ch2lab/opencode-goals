// Task 2 (plan 2026-10-17-background-checkin-gate): background in-flight gate.
//
// In-flight = the goal session's OWN running shells in the host shell store
// (shell.list — the host does not emit session.shell.* events for model-
// originated background shells, so the store is the count's source).
//
// 2026-10-18 ruling (129 incident, then refined): "other" active sessions NO
// LONGER gate as a blanket — different sessions are DIFFERENT tasks, and the
// old blanket count let the user's interactive session hold the campaign
// goal's loop. Instead, `other` is now ATTRIBUTED via the host's
// Session.Info.parentID chain: only a sibling session that is a SUBTASK of
// THIS session (its ancestors include this sessionID) is counted. A foreign
// session (no parent link to us) is invisible to the gate.
//
// 2026-10-20 reference-UI ruling (the 1.1.3 zombie-lock fix): an attributed
// subtask is in-flight only while the host's ACTIVE MAP (GET
// /api/session/active — the same sessionID→status signal the host UI reads)
// says "running". The 1.1.3 time-field guess (time.idle absent /
// idle < updated) is gone: dead sessions' time fields go stale and counted
// them in-flight forever (16 zombies on 129 held the gate, no wakes).
// Absent entry = idle = not in flight; "question" (waiting on the user) is
// not "running" and does not count (the host's own subagent-counter parity).
//
// A terminal boundary with in-flight (own shells + attributed subtask
// sessions) > 0 does NOT wake immediately (the session is already "waiting");
// its entire action is arming the one-shot progress check (fires in Task 3).
// Any session activity cancels the timer; each in-flight boundary re-arms it
// (the clock only runs while quiescent).
//
// Time control follows the house pattern (watchdog.test.ts): real timers with
// small option values (checkInDelaySec 1s = the 1-second minimum) + STATE
// polling, never exact wall-clock moments.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { decisionLogPath } from "../src/decisionlog.ts";
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
function shellStarted(id: string, shellID: string, sid = S, background?: boolean): HostEvent {
  return ev("session.shell.started", id, {
    sessionID: sid,
    shell: {
      id: shellID,
      status: "running",
      command: "cmdA",
      cwd: "/w",
      shell: "bash",
      file: "script.sh",
      // §54: unflagged = FOREGROUND shell; these tests model BACKGROUND work.
      metadata: background ? { background: true } : {},
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
  h.setSession(S, { location: { directory: "/w" } }); // the store query needs the session's location
  await h.emit(shellStarted("e1", "sh1", S, true)); // §54: background shell
  await h.emit(succeeded("b1", S)); // boundary while in flight → no wake
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("2: 2026-10-18 ruling — an active FOREIGN session (no parent link to us) does NOT gate → immediate wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set ChildGate");
  h.setSession(CHILD, { projectID: "other" }); // a real session, but no parent link to us
  h.setActiveSessions({ [CHILD]: "running" }); // even a RUNNING foreign session never gates
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight = 0 (own shells 0, subtasks 0) → ordinary wake
  expect(h.prompts.length).toBe(1);
  await stop();
});

test("2c: a SUBTASK session (parentID = us) IS counted → gate holds, like the original intent", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set SubtaskGate");
  h.setSession(S, { location: { directory: "/w" } }); // the subtask query is location-scoped
  h.setSession(CHILD, { parentID: S }); // host session list: CHILD is OUR subtask
  h.setActiveSessions({ [CHILD]: "running" }); // active map: executing now → in flight
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight = 1 (our subtask) → no wake
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

test("4: another project's active session does not gate (cross-project, observability only)", async () => {
  const { h, stop } = await boot({ projectID: "prj" });
  h.setSession(S, { projectID: "prj" });
  h.setSession(CHILD, { projectID: "other" });
  await h.commandExecutor(S, "/goal set CrossProj");
  await h.emit(started("c1", CHILD)); // a different project's session — never gates
  await modelWorked(h, "b");
  await h.emit(succeeded("b1", S)); // own in-flight = 0 → immediate wake
  expect(h.prompts.length).toBe(1);
  await stop();
});

test("5: real session activity (a new turn starting) cancels the timer (no check-in after the deadline)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Cancel");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own-in-flight boundary → timer armed (1s)
  await h.emit(started("c2", S)); // the session goes active again → cancel
  await sleep(1500); // past the deadline: a cancelled timer never fires
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("6: boundary storm while in flight — every boundary re-arms, no immediate wakes", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Storm");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await h.emit(ev("session.inbox.enqueued", "i1", {
    sessionID: S,
    inboxID: "inbox_6",
    item: { type: "user", payload: { text: "storm" }, delivery: "queue" },
  })); // keep lastInbox = user so every boundary takes the hold path
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own-in-flight boundary → arm
  await modelWorked(h, "b"); // a full working turn in between (cancels, re-arms below)
  await h.emit(succeeded("b2", S)); // re-arm
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("7: goal_wait quiet — in-flight boundary arms nothing (no wake, no timer)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Quiet");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  const reply = await h.toolExecutor("goal_wait", { minutes: 1, background: true }, S);
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
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own-in-flight boundary → arm (1s)
  await sleep(1500); // past due: the 1ms tick fires the one-shot
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1, ["shX (bg)"])); // §51: roster rides along (§54: kind label)
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
  expect(h.prompts[1].input.text).toBe(backgroundCheckInText(1, 1, ["shX (bg)"])); // §51: re-arm fires with the roster too
  await stop();
});

// (test 10 dropped, 2026-10-18: it exercised the now-removed "other session
// is in flight, forever" premise — other sessions no longer gate, so no
// overcount scenario exists. The stale-OWN-shell case is test 14.)

test("11: due passes while the session is ACTIVE (lost-started belt) - held; once idle the pending deadline fires", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set Hold11");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own-in-flight boundary → arm (1s)
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
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await h.toolExecutor("goal_wait", { minutes: 1, background: true }, S); // waitUntil in force
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight boundary inside the window → armed nothing
  await sleep(1500); // the due moment passes inside the quiet window
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("13: terminal guard - goal cleared after arming: no ghost reminder, checkinDue cleared, tick disarmed", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set Guard13");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own-in-flight boundary → arm (1s)
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
  h.setSession(S, { location: { directory: "/w" } }); // the store query needs the session's location
  await h.emit(shellStarted("e1", "sh1", S, true)); // the shell never reports its end (§54: background)
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in flight (the stale shell) → arm
  await sleep(1500);
  expect(h.prompts.length).toBe(1); // a reminder — never a fabricated "lost"
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1, ["sh1 (bg)"])); // §51: the stale shell is listed (§54: kind label)
  expect(h.prompts[0].input.text).not.toContain("lost");
  await stop();
});

// --- 2026-10-17 shell-store gate: the in-flight count comes from the host
// shell store (shell.list), not from session.shell.* events (the host does
// not emit them for model-originated background shells — root cause #12138). ---

test("15: store-only shell (no events — the model's background shell) holds the boundary", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Store15");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground // store truth, no events
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own running shell in the store → hold (no wake)
  expect(h.prompts.length).toBe(0);
  await stop();
});

test("16: another session's shell in the same location is not counted → immediate wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Other16");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shY", status: "running", sessionID: "someone-else" }]);
  await modelWorked(h, "b");
  await h.emit(succeeded("b1", S)); // no shell of ours in flight → ordinary wake
  expect(h.prompts.length).toBe(1);
  await stop();
});

// 2026-10-17 ruling: a failed shell query means the host context is dead —
// log it and SKIP (no wake, no check-in arm); reviving a dead session is not
// the plugin's job. "The query must succeed when the API is healthy" is
// guaranteed by the one-shot host verification, not by failure fallbacks.

test("17: query failure = host context dead → skip (no wake, no check-in arm, no throw)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Fail17");
  h.setSession(S, { location: { directory: "/w" } });
  h.failShellList(true);
  await modelWorked(h, "c");
  await h.emit(succeeded("b1", S)); // query throws → skip: nothing armed, no wake
  expect(h.prompts.length).toBe(0);
  await sleep(1500); // nothing armed → still silent
  expect(h.prompts.length).toBe(0);
  await stop();
});

// Decision log assertions: the gate writes one JSON line per decision to
// <tempdir>/opencode-goal/decisions-<pid>.jsonl (this process' file).

function lastDecision(sessionID: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(decisionLogPath(process.pid), "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mine = lines.filter((l) => l.sessionID === sessionID);
    return mine[mine.length - 1];
  } catch {
    return undefined;
  }
}

test("18: in-flight boundary logs a hold decision (real counts, ownKnown)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Log18");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground // store truth, no events
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own running shell → hold
  expect(h.prompts.length).toBe(0);
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.own).toBe(1);
  expect(line?.other).toBe(0);
  expect(line?.ownKnown).toBe(true);
  await stop();
});

test("19: skipped boundary logs skip (ownKnown false) and warns once per session", async () => {
  const { h, stop } = await boot();
  const warns: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  try {
    await h.commandExecutor(S, "/goal set Log19");
    h.setSession(S, { location: { directory: "/w" } });
    h.failShellList(true);
    await modelWorked(h, "c");
    await h.emit(succeeded("b1", S)); // skip
    await h.emit(succeeded("b2", S)); // skip again — the warn stays at one
    const line = lastDecision(S);
    expect(line?.decision).toBe("skip");
    expect(line?.ownKnown).toBe(false);
    const shellWarns = warns.filter((w) => String(w[0] ?? "").includes("in-flight signal query failed"));
    expect(shellWarns).toHaveLength(1);
  } finally {
    console.warn = origWarn;
    await stop();
  }
});

// 2026-10-17 incident (verify run 1792232697727): the host reports a turn's
// token usage (session.usage.updated) AFTER its terminal boundary event. The
// late straggler is NOT activity — the session is idle. Cancelling on it killed
// the freshly armed one-shot check-in and left the goal silent for 150s.
test("21: late usage.updated / tool.called after a terminal boundary do NOT cancel the armed check-in", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Straggler21");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // own-in-flight boundary → arm (1s)
  // the just-ended turn's bookkeeping events arrive AFTER the boundary
  // (turns[S].active is false now — the session is idle)
  await h.emit(usageUpdated("u1", S));
  await h.emit(toolCalled("t1", S));
  await sleep(1500); // past the deadline: the uncancelled check-in fires
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1, ["shX (bg)"]));
  await stop();
});

test("22: 2026-10-18 ruling — a foreign session is not counted at all: wake with own=0, other=0", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ruling22");
  h.setSession(S, { location: { directory: "/w" } });
  h.setSession(CHILD, { projectID: "other" }); // a real session, no parent link → not counted
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight = 0 → wake (not hold)
  expect(h.prompts.length).toBe(1);
  const line = lastDecision(S);
  expect(line?.decision).toBe("wake");
  expect(line?.own).toBe(0);
  expect(line?.other).toBe(0); // only attributed subtasks count
  await stop();
});

test("22b: a subtask session (parentID = us) IS logged as other=1 and gates: hold, no wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set SubtaskLog22b");
  h.setSession(S, { location: { directory: "/w" } });
  h.setSession(CHILD, { parentID: S });
  h.setActiveSessions({ [CHILD]: "running" });
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight = 1 (our subtask) → hold
  expect(h.prompts.length).toBe(0);
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.own).toBe(0);
  expect(line?.other).toBe(1); // attributed subtask
  await stop();
});

test("23: a ZOMBIE subtask (1.1.3 lock case — parent link + stale time, no active entry) is NOT in flight → wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set DoneSubtask23");
  h.setSession(S, { location: { directory: "/w" } });
  // 1.1.3's in-flight pattern (updated after idle) — but the host's active map
  // has NO entry: the session is dead (129's 16 zombies). Not counted.
  h.setSession(CHILD, { parentID: S, time: { updated: 200, idle: 100 } });
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight = 0 (subtask not running) → wake
  expect(h.prompts.length).toBe(1);
  const line = lastDecision(S);
  expect(line?.decision).toBe("wake");
  expect(line?.other).toBe(0); // zombie subtask not counted (the 1.1.3 bug, pinned)
  await stop();
});

test("24: a RUNNING subtask (active map says running) IS counted → hold", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set InFlightSubtask24");
  h.setSession(S, { location: { directory: "/w" } });
  h.setSession(CHILD, { parentID: S });
  h.setActiveSessions({ [CHILD]: "running" }); // executing now (LLM turn or long tool wait)
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight = 1 → hold
  expect(h.prompts.length).toBe(0);
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.other).toBe(1);
  await stop();
});

test("25: a subtask in \"question\" state (waiting on the user, not executing) is NOT counted → wake", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Question25");
  h.setSession(S, { location: { directory: "/w" } });
  h.setSession(CHILD, { parentID: S });
  h.setActiveSessions({ [CHILD]: "question" });
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // only "running" counts (the host's own subagent-counter parity)
  expect(h.prompts.length).toBe(1);
  const line = lastDecision(S);
  expect(line?.decision).toBe("wake");
  expect(line?.other).toBe(0);
  await stop();
});

test("26: active-map query failure fails OPEN (wake with other=0 — not skip: the shell query succeeded)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Fail26");
  h.setSession(S, { location: { directory: "/w" } });
  h.setSession(CHILD, { parentID: S });
  h.setActiveSessions({ [CHILD]: "running" });
  h.failActiveSessions(true);
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // list ok + active map failed → fail open (0 subtasks) → wake
  expect(h.prompts.length).toBe(1);
  const line = lastDecision(S);
  expect(line?.decision).toBe("wake");
  expect(line?.other).toBe(0);
  expect(line?.ownKnown).toBe(true);
  await stop();
});

test("20: an ordinary wake boundary logs wake (ownKnown, in-flight 0)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Log20");
  h.setSession(S, { location: { directory: "/w" } });
  await modelWorked(h, "d");
  await h.emit(succeeded("b1", S)); // nothing in flight → wake
  expect(h.prompts.length).toBe(1);
  const line = lastDecision(S);
  expect(line?.decision).toBe("wake");
  expect(line?.ownKnown).toBe(true);
  await stop();
});

// ── 2026-10-20 queued-input ruling (129 incident: a [GOAL] wake observed
// queued behind the user's own message — a wake must NEVER appear in the
// queue; undelivered inbox items gate the wake like in-flight work). ──

test("27: queued undelivered user input at the boundary → HOLD (no wake — a wake would land in the queue)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Queued27");
  h.setSession(S, { location: { directory: "/w" } });
  // The user's message was sent while the turn below was running → the host
  // parked it in the inbox (undelivered). The boundary must not wake: the
  // queued turn is guaranteed to run next and produce its own boundary.
  h.inbox.set(S, [{ id: "inb_q1", sessionID: S, type: "user", delivery: "queue" }]);
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // queued = 1 → hold
  expect(h.prompts.length).toBe(0);
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.queued).toBe(1);
  expect(line?.own).toBe(0);
  expect(line?.other).toBe(0);
  await stop();
});

test("28: queued input is DELIVERED (inbox empty) at the boundary → wake as usual", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Queued28");
  h.setSession(S, { location: { directory: "/w" } });
  h.inbox.set(S, []); // nothing pending
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // queued = 0 → wake
  expect(h.prompts.length).toBe(1);
  const line = lastDecision(S);
  expect(line?.decision).toBe("wake");
  expect(line?.queued).toBe(0);
  await stop();
});

test("29: a pending NON-user item (synthetic shell result) also gates → hold", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Queued29");
  h.setSession(S, { location: { directory: "/w" } });
  // Any undelivered kind (user/synthetic/compaction/move) means the next
  // execution is coming — the wake would queue behind it either way.
  h.inbox.set(S, [{ id: "inb_q2", sessionID: S, type: "synthetic", delivery: "queue" }]);
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S));
  expect(h.prompts.length).toBe(0);
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.queued).toBe(1);
  await stop();
});

test("30: inbox query failure fails CLOSED (skip — an invisible queue must not open the wake path)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Fail30");
  h.setSession(S, { location: { directory: "/w" } });
  h.failInboxList(true);
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // gate signal unavailable → skip
  expect(h.prompts.length).toBe(0);
  const line = lastDecision(S);
  expect(line?.decision).toBe("skip");
  expect(line?.ownKnown).toBe(false);
  await stop();
});

test("31: reply to OUR check-in wake while user input is queued → HOLD (the §7.1 (a) exception yields to the queued gate)", async () => {
  // Review finding C1 (2026-10-20): the (a) exception sent a reply to our own
  // watchdog wake straight to normal arbitration — ignoring `queued`. When
  // the user's message had landed in the final window (parked in the inbox,
  // its enqueued ECHO lost → lastInbox still our check-in wake), the boundary
  // injected a WAKE with queued > 0 — the wake queued behind the user's own
  // message (the 129 invariant this release exists to fix).
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Queued31");
  h.setSession(S, { location: { directory: "/w" } });
  // Arm the check-in (in-flight boundary) and let the 1ms tick fire it —
  // lastInbox is now our watchdog wake.
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in-flight → hold, check-in armed (1s)
  await sleep(1500); // past due: the tick fires the check-in
  expect(h.prompts.length).toBe(1);
  // The user's message landed in the final window (after the last model call)
  // → parked in the inbox, and its enqueued ECHO was lost — lastInbox still
  // points at our check-in wake (the exact 129 shape, spec §42).
  h.setShells([]);
  h.inbox.set(S, [{ id: "inb_q31", sessionID: S, type: "user", delivery: "queue" }]);
  await modelWorked(h, "b");
  await h.emit(succeeded("b2", S)); // boundary: queued=1, last=our watchdog wake
  expect(h.prompts.length).toBe(1); // NO new wake — it would queue behind the user's message
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.queued).toBe(1);
  expect(line?.own).toBe(0);
  await stop();
});

// 2026-10-20 (129 forensics): a watchdog-injected message (check-in) left NO
// decision log line — a queued wake the user saw and removed was
// unexplainable from the server side. Every watchdog wake must now log one
// line, so "message present, log absent" can never happen again.
test("32: a fired check-in logs a decision line (the watchdog path is observable)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set LogWatchdog32");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]); // §54: unflagged = foreground
  await modelWorked(h, "a");
  await h.emit(succeeded("b1", S)); // in flight → hold (logged), check-in armed (1s)
  await sleep(1500); // past due: the 1ms tick fires the one-shot
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1, ["shX (bg)"]));
  const line = lastDecision(S);
  expect(line?.decision).toBe("watchdog");
  expect(String(line?.reason)).toContain("check-in");
  await stop();
});
