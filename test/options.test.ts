import { expect, test } from "bun:test";
import { resolveOptions, parseModelRef, selectJudgeModel, type Options } from "../src/options.ts";

const EXPECTED_DEFAULTS: Options = {
  stallLimit: 3,
  defaultCapTurns: undefined, // 2026-10-20 ruling: unbounded by default (explicit opt-in only)
  defaultCapTokens: undefined,
  judgeEnabled: false,
  judgeMaxPerGoal: 1,
  watchdogTickMs: 30000,
  checkInDelaySec: 300,
  timeoutWrap: false,
  providerFailLimit: 2,
  providerPauseMs: 30 * 60 * 1000,
  wakeText: undefined,
};

test("empty input yields every default exactly", () => {
  const o = resolveOptions({});
  expect(o.stallLimit).toBe(3);
  expect(o.defaultCapTurns).toBeUndefined(); // unbounded by default
  expect(o.defaultCapTokens).toBeUndefined();
  expect(o.judgeEnabled).toBe(false);
  expect(o.judgeMaxPerGoal).toBe(1);
  expect(o.watchdogTickMs).toBe(30000);
  expect(o.checkInDelaySec).toBe(300);
  expect(o.timeoutWrap).toBe(false);
  expect(o.providerFailLimit).toBe(2);
  expect(o.providerPauseMs).toBe(30 * 60 * 1000);
  expect(o.wakeText).toBeUndefined();
  expect(o).toEqual(EXPECTED_DEFAULTS);
});

test("partial overrides take effect, the rest stay default", () => {
  const o = resolveOptions({
    stallLimit: 5,
    defaultCapTurns: 20,
    defaultCapTokens: 250000,
    judgeEnabled: false,
    judgeMaxPerGoal: 2,
    watchdogTickMs: 15000,
    timeoutWrap: true,
    wakeText: "continue the goal",
  });
  expect(o.stallLimit).toBe(5);
  expect(o.defaultCapTurns).toBe(20);
  expect(o.defaultCapTokens).toBe(250000);
  expect(o.judgeEnabled).toBe(false);
  expect(o.judgeMaxPerGoal).toBe(2);
  expect(o.watchdogTickMs).toBe(15000);
  expect(o.timeoutWrap).toBe(true);
  expect(o.wakeText).toBe("continue the goal");
});

test("non-number / invalid numeric input falls back to defaults", () => {
  const o = resolveOptions({
    stallLimit: "3",
    defaultCapTurns: 10.5,
    defaultCapTokens: null,
    judgeMaxPerGoal: 0,
    watchdogTickMs: -1,
  });
  expect(o.stallLimit).toBe(3);
  expect(o.defaultCapTurns).toBeUndefined(); // invalid input -> no cap (unbounded), not a fallback
  expect(o.defaultCapTokens).toBeUndefined();
  expect(o.judgeMaxPerGoal).toBe(1);
  expect(o.watchdogTickMs).toBe(30000);
});

test("stallLimit accepts integers >= 1 only", () => {
  expect(resolveOptions({ stallLimit: 1 }).stallLimit).toBe(1);
  expect(resolveOptions({ stallLimit: 0 }).stallLimit).toBe(3);
  expect(resolveOptions({ stallLimit: 2.5 }).stallLimit).toBe(3);
});

// --- checkInDelaySec (2026-10-17 ruling: background in-flight gate — the
// session stays quiet checkInDelaySec seconds, then gets a one-shot progress
// check. Unit = SECONDS (ruling), default 300 = 5 minutes) ---

test("checkInDelaySec: integer seconds >= 1 only, default 300", () => {
  expect(resolveOptions({}).checkInDelaySec).toBe(300);
  expect(resolveOptions({ checkInDelaySec: 1 }).checkInDelaySec).toBe(1);
  expect(resolveOptions({ checkInDelaySec: 60 }).checkInDelaySec).toBe(60);
  expect(resolveOptions({ checkInDelaySec: 0 }).checkInDelaySec).toBe(300);
  expect(resolveOptions({ checkInDelaySec: -5 }).checkInDelaySec).toBe(300);
  expect(resolveOptions({ checkInDelaySec: 0.5 }).checkInDelaySec).toBe(300);
  expect(resolveOptions({ checkInDelaySec: "300" }).checkInDelaySec).toBe(300);
});

test("booleans accept only boolean literals", () => {
  expect(resolveOptions({ judgeEnabled: "false" }).judgeEnabled).toBe(false);
  expect(resolveOptions({ judgeEnabled: "true" }).judgeEnabled).toBe(false);
  expect(resolveOptions({ judgeEnabled: 0 }).judgeEnabled).toBe(false);
  expect(resolveOptions({ timeoutWrap: 1 }).timeoutWrap).toBe(false);
  expect(resolveOptions({ timeoutWrap: "false" }).timeoutWrap).toBe(false);
  expect(resolveOptions({ judgeEnabled: false }).judgeEnabled).toBe(false);
  expect(resolveOptions({ timeoutWrap: true }).timeoutWrap).toBe(true);
});

test("wakeText accepts only non-empty strings", () => {
  expect(resolveOptions({ wakeText: "" }).wakeText).toBeUndefined();
  expect(resolveOptions({ wakeText: 42 }).wakeText).toBeUndefined();
  expect(resolveOptions({ wakeText: null }).wakeText).toBeUndefined();
  expect(resolveOptions({ wakeText: "  " }).wakeText).toBe("  ");
  expect(resolveOptions({ wakeText: "go" }).wakeText).toBe("go");
});

// --- wakeDetail was REMOVED (2026-10-20 single wake format): unknown option
// keys are simply ignored by resolveOptions ---

// --- model (2026-10-16: side-channel model for judge / compaction) ---
// Default (unset) must mean "the SESSION'S OWN model" (per-session, not the
// global default) — enforced in the index.ts adapter; here: parse + priority.

test("parseModelRef accepts exactly 'providerID/modelID'", () => {
  expect(parseModelRef("ch2lab/Qwen3.8-27B")).toEqual({ providerID: "ch2lab", id: "Qwen3.8-27B" });
  expect(parseModelRef("p/a-b_c.1")).toEqual({ providerID: "p", id: "a-b_c.1" });
});

test("parseModelRef rejects malformed refs (strict two segments)", () => {
  for (const bad of ["", "noslash", "/x", "x/", "a/b/c", " a/b", "a/b ", null, 42, { p: 1 }, undefined]) {
    expect(parseModelRef(bad)).toBeUndefined();
  }
});

test("resolveOptions: model parsed into a ref; malformed/absent falls back to undefined", () => {
  expect(resolveOptions({ model: "ch2lab/Qwen3.8-27B" }).model).toEqual({ providerID: "ch2lab", id: "Qwen3.8-27B" });
  expect(resolveOptions({ model: "bad" }).model).toBeUndefined();
  expect(resolveOptions({ model: 42 }).model).toBeUndefined();
  expect(resolveOptions({}).model).toBeUndefined();
});

test("selectJudgeModel priority: explicit option > session's own model > host default (undefined)", () => {
  const explicit = { providerID: "p", id: "m1" };
  const session = { providerID: "p", id: "m2" };
  expect(selectJudgeModel(explicit, session)).toBe(explicit);
  expect(selectJudgeModel(explicit, undefined)).toBe(explicit);
  expect(selectJudgeModel(undefined, session)).toBe(session);
  expect(selectJudgeModel(undefined, undefined)).toBeUndefined();
});
