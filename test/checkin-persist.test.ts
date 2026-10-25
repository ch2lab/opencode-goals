// §58 (2026-10-25 — overnight incident): the armed check-in deadline is
// PERSISTED with the goal record and RESTORED on reload; a parked goal with
// in-flight work but no live watchdog is self-healed by the orphan sweep.
// The incident: 00:26:36 armed a one-shot check-in (due 00:31:36) → machine
// sleep → 01:03 location evict/reboot killed the in-memory deadline → nothing
// else could wake the loop → parked all night.
import { test, expect } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { goalStorageKey, type GoalRecord } from "../src/state.ts";
import { backgroundCheckInText } from "../src/wake.ts";
import type { HostEvent } from "../src/types.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const OPTS = resolveOptions({ checkInDelaySec: 30 }); // the armed deadline stays in the future during setup
const S = "ses_c58";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}
const started = (id: string): HostEvent => ev("session.execution.started", id, { sessionID: S });
const succeeded = (id: string): HostEvent => ev("session.execution.succeeded", id, { sessionID: S });

async function boot(livenessCheckMs = 400): Promise<{ h: Harness; ctrl: GoalController; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, OPTS, { tickMs: 1, livenessCheckMs });
  const stop = await ctrl.start();
  return { h, ctrl, stop };
}
function goalOf(h: Harness): GoalRecord {
  const g = h.storage.get(goalStorageKey(S)) as GoalRecord | undefined;
  if (g === undefined) throw new Error("no goal record");
  return g;
}
const checkins = (h: Harness): string[] =>
  h.prompts.filter((p) => String(p.input.text).startsWith("Background check-in")).map((p) => String(p.input.text));
/** In-flight boundary → arm (memory + record). */
async function arm(h: Harness): Promise<void> {
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]);
  await h.emit(started("a1"));
  await h.emit(succeeded("b1"));
}

test("C1: the in-flight boundary persists the armed check-in deadline into the goal record", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set C1");
  await arm(h);
  const g = goalOf(h);
  expect(g.checkinDue).toBeDefined(); // the arm mirrored into the record
  expect(g.checkinDue!.inFlight).toBe(1);
  expect(g.checkinDue!.due).toBeGreaterThan(Date.now());
  expect(checkins(h).length).toBe(0); // not due yet (30s)
  await stop();
});

test("C2: the overnight incident — a past-due persisted deadline SURVIVES a full instance reload and fires (the work died in the sleep: no live in-flight, the persisted deadline is all that remains)", async () => {
  const h = await createHarness();
  const c1 = new GoalController(h.probe, OPTS, { tickMs: 1, livenessCheckMs: 400 });
  const stop1 = await c1.start();
  await h.commandExecutor(S, "/goal set C2");
  await arm(h);
  const g = goalOf(h);
  expect(g.checkinDue).toBeDefined();
  g.checkinDue = { due: Date.now() - 1000, inFlight: g.checkinDue!.inFlight }; // the machine slept past the deadline
  h.setShells([]); // the background work died during the sleep
  h.storage.set(goalStorageKey(S), g);
  expect(h.prompts.length).toBe(0);
  await stop1(); // the 01:03 reboot: instance 1 dies with its timers
  const c2 = new GoalController(h.probe, OPTS, { tickMs: 1, livenessCheckMs: 400 });
  const stop2 = await c2.start(); // initRearm restores the persisted deadline
  await sleep(300);
  expect(h.prompts.length).toBe(1); // the late check-in lands
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 30)); // live roster: empty (the work is gone)
  expect(goalOf(h).checkinDue).toBeUndefined(); // consumed → persisted clear
  await stop2();
});

test("C3: no double-fire — after consumption the cleared deadline does not re-fire on a further reload (no visible work to self-heal)", async () => {
  const h = await createHarness();
  const c1 = new GoalController(h.probe, OPTS, { tickMs: 1, livenessCheckMs: 400 });
  const stop1 = await c1.start();
  await h.commandExecutor(S, "/goal set C3");
  await arm(h);
  const g = goalOf(h);
  g.checkinDue = { due: Date.now() - 1000, inFlight: 1 };
  h.storage.set(goalStorageKey(S), g);
  await stop1();
  const c2 = new GoalController(h.probe, OPTS, { tickMs: 1, livenessCheckMs: 400 });
  const stop2 = await c2.start();
  let fired = 0;
  while (fired < 300 && h.prompts.length === 0) {
    await sleep(10);
    fired += 10;
  }
  expect(h.prompts.length).toBe(1); // fired once in instance 2
  h.setShells([]); // the work is gone — before the next sweep pass
  await stop2();
  const c3 = new GoalController(h.probe, OPTS, { tickMs: 1, livenessCheckMs: 400 });
  const stop3 = await c3.start(); // a further reload (the ~hourly one)
  await sleep(600); // several sweep passes
  expect(h.prompts.length).toBe(1); // the cleared deadline did NOT re-fire
  await stop3();
});

test("C4: orphan sweep self-heal — an active goal with in-flight work and no live watchdog gets an IMMEDIATE check-in (the persisted mirror was lost entirely)", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set C4");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]);
  const g = goalOf(h);
  g.checkinDue = undefined; // no persisted deadline (the mirror was never written / was lost)
  h.storage.set(goalStorageKey(S), g);
  // No boundary emitted → no arm, no tick. The orphan sweep (400ms clock)
  // finds the parked active goal with in-flight work and re-arms immediately.
  let waited = 0;
  while (waited < 1500 && checkins(h).length === 0) {
    await sleep(10);
    waited += 10;
  }
  expect(checkins(h).length).toBe(1);
  h.setShells([]); // the work finishes — the sweep must not re-arm after
  await sleep(300);
  expect(checkins(h).length).toBe(1);
  expect(goalOf(h).checkinDue).toBeUndefined(); // fired → consumed
  expect((ctrl as unknown as { wdTimers: Map<string, unknown> }).wdTimers.has(S)).toBe(false);
  await stop();
});

test("C5: quiet windows suppress the sweep — a goal_wait window with in-flight work gets NO check-in (the waitUntil deadline wake owns that moment)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set C5");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "shX", status: "running", sessionID: S, background: true }]);
  await h.toolExecutor("goal_wait", { minutes: 1 }, S); // future waitUntil window
  await sleep(700); // several sweep passes inside the window
  expect(checkins(h).length).toBe(0); // suppressed (the expiry wake is a different text family)
  await stop();
});
