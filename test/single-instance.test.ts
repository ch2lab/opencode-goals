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
