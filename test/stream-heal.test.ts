// §50 stream self-heal (2026-10-21 129 incident: the host's event stream ended
// cleanly mid-session; the event loop returned — the DONE path silently — and
// the goal froze for ~4.5h while the host kept emitting; 7 hot reloads did not
// help because subscribe() starts from the live head, never from the cursor).
//
// Covered here (harness killStream() simulates host-side stream death):
//   T1 a dead stream is re-subscribed and the new pipe receives events;
//   T2 a LOST turn terminal (sm70 shape: started seen, terminal lost) is
//      recovered by the global liveness scan — resubscribe + boundary
//      re-arbitration → the wake that was never injected gets injected;
//   T3 a parked goal (no active turn) is NOT re-woken by the liveness scan —
//      self-heal must not resurrect the parked loop (no new auto-wakes);
//   T4 §49-rev: /goal view kicks the model's (visible) reply turn, and that
//      kick turn's boundary does not chain another wake (control semantics).

import { test, expect } from "bun:test";
import { createHarness, type Harness } from "./harness";
import { GoalController } from "../src/controller";
import { resolveOptions } from "../src/options";
import { goalStorageKey } from "../src/state";
import type { GoalRecord } from "../src/state";
import type { HostEvent } from "../src/types";

const S = "ses_test_heal";

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}
function started(id: string, sessionID = S): HostEvent {
  return ev("session.execution.started", id, { sessionID });
}
function succeeded(id: string, sessionID = S): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID });
}
function enqueuedUser(inboxID: string, sessionID = S): HostEvent {
  // schema InBoxEnqueued: data = { item, inboxID, sessionID }
  return ev("session.inbox.enqueued", `q_${inboxID}`, {
    inboxID,
    sessionID,
    item: { type: "user", payload: { text: "keep going" }, delivery: "queue" },
  });
}

async function boot(): Promise<{ h: Harness; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {
    tickMs: 1,
    contWindowMs: 50,
    livenessMs: 300,
    livenessCheckMs: 20,
  });
  const stop = await ctrl.start();
  return { h, stop };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

function goalOf(h: Harness): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(S)) as GoalRecord | undefined;
}

test("T1: a dead stream is re-subscribed; the new pipe receives events", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Heal");
  expect(h.streamSubscribes()).toBe(1);

  h.killStream();
  expect(await until(() => h.streamSubscribes() >= 2)).toBe(true); // re-subscribed

  // the FRESH pipe works: a full turn is processed end to end.
  h.setSession(S, { location: { directory: "/w" } });
  await h.emit(started("s1"));
  await h.emit(succeeded("e1"));
  // the boundary was handled by the new subscription: the goal records it.
  expect(await until(() => goalOf(h)?.lastHandledEventID === "e1")).toBe(true);
  await stop();
});

test("T2: a lost turn terminal is recovered — liveness recheck re-arbitrates and wakes (sm70 shape)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Heal2");
  h.setSession(S, { location: { directory: "/w" } });

  // A user message drives one normal wake (lastInbox becomes "wake").
  await h.emit(enqueuedUser("u1"));
  await h.emit(started("a1"));
  await h.emit(succeeded("e1"));
  expect(h.prompts.length).toBe(1); // the boundary woke

  // The wake's own turn starts, then the stream DIES (its terminal is lost).
  h.killStream();
  expect(await until(() => h.streamSubscribes() >= 2)).toBe(true); // pipe back
  await h.emit(started("w1")); // the re-piped stream sees the wake turn start

  // Silence now: no terminal will ever come on this subscription. The global
  // liveness scan (no turn terminal + stream silent for livenessMs) must
  // re-subscribe and re-arbitrate — injecting the wake that was missed.
  const before = h.prompts.length;
  expect(await until(() => h.prompts.length > before)).toBe(true);
  await stop();
});

test("T3: a parked goal (no active turn) is NOT re-woken by the liveness scan", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Heal3");
  const wakes = h.wakes.length; // the set's kick turn
  const prompts = h.prompts.length; // 0

  await sleep(900); // well past livenessMs, many scan periods

  expect(h.prompts.length).toBe(prompts); // no check-in / no re-wake
  expect(h.wakes.length).toBe(wakes);
  await stop();
});

test("T4: /goal view kicks the visible-reply turn and does not chain another wake (§49-rev)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set ViewKick");
  const wakes = h.wakes.length; // 1 = the set's kick turn

  await h.commandExecutor(S, "/goal view");
  expect(h.wakes.length).toBe(wakes + 1); // the view result line kicks
  // that kick turn's terminal already ran (harness awaits the auto-turn):
  // boundary saw a control lastInbox → no chained wake.
  expect(h.prompts.length).toBe(0);
  expect(goalOf(h)?.status).toBe("active");
  await stop();
});
