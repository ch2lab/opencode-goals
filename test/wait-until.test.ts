// §57 (2026-10-24 ruling — the local 1.1.9 incident): the goal_wait DEADLINE
// is a wake source. The watchdog fires ONE unconditional "Goal wait period
// ended" wake at waitUntil (no idle/quiet gate — a fully-idle session is
// exactly the parked case it must rescue); the one-shot is persisted (a
// plugin reload neither double-fires nor loses it); a fresh goal_wait
// resets the marker; and the pending window keeps its tick alive — the
// goal_wait call arms its own heartbeat, and start() re-arms persisted
// deadlines after a host reload (initRearm).
import { test, expect } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { goalStorageKey, type GoalRecord } from "../src/state.ts";
import { goalWaitExpiryText } from "../src/wake.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const OPTS = resolveOptions({ checkInDelaySec: 1 });
const S = "ses_wait57";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(): Promise<{ h: Harness; ctrl: GoalController; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop = await ctrl.start();
  return { h, ctrl, stop };
}

function goalOf(h: Harness): GoalRecord {
  const g = h.storage.get(goalStorageKey(S)) as GoalRecord | undefined;
  if (g === undefined) throw new Error("no goal record");
  return g;
}

/** The real tool call waits in minutes (1..60) — too slow for a stub. Shift
 * the PERSISTED waitUntil to a test-scale offset (the record is the single
 * source of truth; the tick re-reads it on every pass). */
function shiftWait(h: Harness, offsetMs: number): void {
  const g = goalOf(h);
  g.waitUntil = Date.now() + offsetMs;
  h.storage.set(goalStorageKey(S), g);
}

function wdArmed(ctrl: GoalController, sessionID: string): boolean {
  return (ctrl as unknown as { wdTimers: Map<string, unknown> }).wdTimers.has(sessionID);
}

test("W1: goal_wait arms its OWN deadline wake — at the expiry the tick fires ONE unconditional 'Goal wait period ended' (session fully idle, nothing in flight — the incident shape)", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set W1");
  const reply = await h.toolExecutor("goal_wait", { minutes: 1 }, S);
  expect(reply).toContain("will not be woken for 1 minutes"); // the silence window is still promised
  expect(reply).toContain("Goal wait period ended"); // ...and so is the deadline wake
  expect(goalOf(h).waitWakeSent).toBe(false);
  expect(wdArmed(ctrl, S)).toBe(true); // §57: the call owns its heartbeat (no boundary needed)
  shiftWait(h, 30); // test-scale deadline
  await sleep(400);
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toBe(goalWaitExpiryText(goalOf(h).id, 1));
  expect(h.prompts[0].input.metadata?.goalControl).toBe(true);
  expect(goalOf(h).waitWakeSent).toBe(true);
  await sleep(400); // one-shot: no recurrence
  expect(h.prompts.length).toBe(1);
  expect(wdArmed(ctrl, S)).toBe(false); // nothing pending anymore → tick disarmed
  await stop();
});

test("W2: reload — an EXPIRED but undelivered waitUntil still wakes (the 2026-10-24 incident: the host re-instantiated the plugin and killed the only running timer)", async () => {
  const h = await createHarness();
  const c1 = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop1 = await c1.start();
  await h.commandExecutor(S, "/goal set W2");
  await h.toolExecutor("goal_wait", { minutes: 1 }, S);
  shiftWait(h, -1000); // the deadline has passed; instance 1 never got to fire it
  expect(h.prompts.length).toBe(0);
  await stop1(); // the reload: instance 1 dies with its timers
  const c2 = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop2 = await c2.start(); // §57 init re-arm: the persisted expired waitUntil is found
  await sleep(400);
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toContain("Goal wait period ended");
  expect(goalOf(h).waitWakeSent).toBe(true);
  await sleep(400);
  expect(h.prompts.length).toBe(1); // the re-arm did not double-fire
  await stop2();
});

test("W3: reload — a PENDING (not yet expired) window is re-armed and fires at its own deadline (no early fire)", async () => {
  const h = await createHarness();
  const c1 = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop1 = await c1.start();
  await h.commandExecutor(S, "/goal set W3");
  await h.toolExecutor("goal_wait", { minutes: 1 }, S);
  shiftWait(h, 500); // still 0.5s in the future
  await stop1();
  const c2 = new GoalController(h.probe, OPTS, { tickMs: 1 });
  const stop2 = await c2.start(); // re-arms (future waitUntil, flag unset)
  await sleep(100);
  expect(h.prompts.length).toBe(0); // not yet due — no early fire
  await sleep(900); // past the re-armed deadline
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toContain("Goal wait period ended");
  await stop2();
});

test("W4: a fresh goal_wait RESETS the one-shot — a second window fires its own wake", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set W4");
  await h.toolExecutor("goal_wait", { minutes: 1 }, S);
  shiftWait(h, 30);
  await sleep(400);
  expect(h.prompts.length).toBe(1); // the first window fired
  expect(goalOf(h).waitWakeSent).toBe(true);
  await h.toolExecutor("goal_wait", { minutes: 1 }, S); // the model waits again
  expect(goalOf(h).waitWakeSent).toBe(false); // the marker is reset with the window
  shiftWait(h, 30);
  await sleep(400);
  expect(h.prompts.length).toBe(2); // the second window fired its own wake
  expect(wdArmed(ctrl, S)).toBe(false);
  await stop();
});
