// Single-instance guard (2026-10-16 field incident, aiserver5/129): the
// host's plugin hot-reload re-runs setup() WITHOUT disposing the previous
// instance (host log: 3x "loading plugin @ch2lab/opencode-goals" within one
// second on the config swap, zero unload lines) → several live
// GoalControllers on the SAME event stream + shared storage → every terminal
// boundary was arbitrated N times → N duplicate boundary wakes (identical
// goalTurn stamp, e.g. three "1/10" and two "3/10" in one session), which
// piled up in the session inbox queue during long busy scripts (host only
// delivers queued items when idle) and flooded the model at once.
//
// The guard: starting a controller whose location key already has a live
// owner STOPS the previous owner before arming. The registry lives on
// globalThis (NOT module state) because a host hot-reload can re-import the
// plugin module, which would reset module-level variables.
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { createGoal, goalStorageKey } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "ses_single_instance";

function boundary(id: string) {
  return { type: "session.execution.succeeded", id, properties: { sessionID: S } };
}

function wakeCount(h: Harness): number {
  return h.prompts.filter((p) => p.input.metadata?.goalWake === true).length;
}

async function setGoal(h: Harness): Promise<void> {
  const g = createGoal({ sessionID: S, objective: "single instance guard" });
  await h.probe.storageSet(goalStorageKey(S), g);
}

test("1: a second controller for the same location stops the previous owner — one boundary yields exactly one wake", async () => {
  // Unique location key: isolates this test's registry slot from every
  // other test file (they use the default "global" key).
  const h = await createHarness({ locationDirectory: "/tmp/ocg-guard-1" });
  const a = new GoalController(h.probe, resolveOptions({}), {});
  const stopA = await a.start();
  const b = new GoalController(h.probe, resolveOptions({}), {});
  const stopB = await b.start(); // guard: must stop a's loop before arming

  await setGoal(h);
  await h.emit(boundary("b1"));
  // Pre-fix: 2 (both loops arbitrate b1, each injects a wake with the same
  // turn stamp — the exact field signature).
  expect(wakeCount(h)).toBe(1);
  await h.emit(boundary("b2")); // continuationPending window: skipped, still 1
  expect(wakeCount(h)).toBe(1);

  await stopB();
  await stopA(); // displaced owner's cleanup: must be idempotent, no resurrection
});

test("3: CONCURRENT starts (raced hot-reload loads) converge to one live consumer", async () => {
  // Field follow-up 2026-10-17: after the 129 serve restart the host loaded
  // the plugin 7 times in 52s (pairs ~110-210ms apart). The v1 guard claimed
  // its slot at the END of start() (after `await reconcile()`), so two starts
  // whose gaps overlapped both read an empty registry and both armed →
  // 2-3 live consumers (duplicate wakes, inflated used.turns, burned budget).
  // Reproduce the overlap deterministically: widen reconcile's storage gap so
  // the second start lands INSIDE the first start's gap.
  const h = await createHarness({ locationDirectory: "/tmp/ocg-guard-3" });
  const origScan = h.probe.storageScan;
  h.probe.storageScan = async (prefix) => {
    await new Promise((r) => setTimeout(r, 150));
    return origScan(prefix);
  };
  const a = new GoalController(h.probe, resolveOptions({}), {});
  const b = new GoalController(h.probe, resolveOptions({}), {});
  // Both starts interleave: b's start runs while a is inside its storage gap.
  const [stopA, stopB] = await Promise.all([a.start(), b.start()]);

  await setGoal(h);
  await h.emit(boundary("b1"));
  // Pre-fix: 2 (both loops armed — the exact field signature). Post-fix: 1.
  expect(wakeCount(h)).toBe(1);
  await h.emit(boundary("b2")); // continuationPending window: still 1
  expect(wakeCount(h)).toBe(1);

  await stopA(); // the displaced one: idempotent, no resurrection
  await stopB();
});

// 2026-10-17 129 incident: the host dropped the wake turn's execution.started
// from the plugin's event stream. The wake turn then completed a REAL
// boundary, which the still-open continuationPending window SKIPPED — and
// with the session dormant, no second boundary ever came, so the goal sat
// silent (no decision-log line, no wake) until a human woke it manually. The
// window is now time-bounded: far beyond it, a boundary is the wake turn's
// own terminal and MUST be arbitrated.
test("4: a lost execution.started cannot kill the wake loop (time-bounded window)", async () => {
  const h = await createHarness({ locationDirectory: "/tmp/ocg-guard-4" });
  const c = new GoalController(h.probe, resolveOptions({}), { contWindowMs: 100 });
  const stop = await c.start();

  await setGoal(h);
  await h.emit(boundary("b1")); // → wake #1, window armed
  expect(wakeCount(h)).toBe(1);
  // NO execution.started emitted (lost in the host event stream); the window
  // expires while the wake turn runs.
  await new Promise((r) => setTimeout(r, 200));
  await h.emit(boundary("b2")); // the wake turn's real terminal boundary
  // Pre-fix: b2 is skipped (first boundary in the open window) and never
  // re-tried → wakeCount stays 1 — the field signature of a dead goal loop.
  expect(wakeCount(h)).toBe(2);

  await stop();
});

test("2: stopping a displaced instance does not deregister the live successor", async () => {
  const h = await createHarness({ locationDirectory: "/tmp/ocg-guard-2" });
  const a = new GoalController(h.probe, resolveOptions({}), {});
  const stopA = await a.start();
  const b = new GoalController(h.probe, resolveOptions({}), {});
  const stopB = await b.start(); // displaces a

  await setGoal(h);
  await stopA(); // a is no longer the owner: its cleanup must NOT delete b's registry entry
  await h.emit(boundary("b1"));
  expect(wakeCount(h)).toBe(1); // b is still alive and woke

  await stopB();
});
