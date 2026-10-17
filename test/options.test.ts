import { expect, test } from "bun:test";
import { resolveOptions, parseModelRef, selectJudgeModel, type Options } from "../src/options.ts";

const EXPECTED_DEFAULTS: Options = {
  stallLimit: 3,
  defaultCapTurns: 10,
  defaultCapTokens: undefined,
  judgeEnabled: true,
  judgeMaxPerGoal: 1,
  watchdogTickMs: 30000,
  shellStallMs: 300000,
  waitCheckInMs: 300000,
  timeoutWrap: false,
  wakeDetail: "slim",
  wakeText: undefined,
};

test("empty input yields every default exactly", () => {
  const o = resolveOptions({});
  expect(o.stallLimit).toBe(3);
  expect(o.defaultCapTurns).toBe(10);
  expect(o.defaultCapTokens).toBeUndefined();
  expect(o.judgeEnabled).toBe(true);
  expect(o.judgeMaxPerGoal).toBe(1);
  expect(o.watchdogTickMs).toBe(30000);
  expect(o.shellStallMs).toBe(300000);
  expect(o.waitCheckInMs).toBe(300000);
  expect(o.timeoutWrap).toBe(false);
  expect(o.wakeDetail).toBe("slim");
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
    shellStallMs: 600000,
    waitCheckInMs: 60000,
    timeoutWrap: true,
    wakeText: "continue the goal",
  });
  expect(o.stallLimit).toBe(5);
  expect(o.defaultCapTurns).toBe(20);
  expect(o.defaultCapTokens).toBe(250000);
  expect(o.judgeEnabled).toBe(false);
  expect(o.judgeMaxPerGoal).toBe(2);
  expect(o.watchdogTickMs).toBe(15000);
  expect(o.shellStallMs).toBe(600000);
  expect(o.waitCheckInMs).toBe(60000);
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
    shellStallMs: NaN,
    waitCheckInMs: Infinity,
  });
  expect(o.stallLimit).toBe(3);
  expect(o.defaultCapTurns).toBe(10);
  expect(o.defaultCapTokens).toBeUndefined();
  expect(o.judgeMaxPerGoal).toBe(1);
  expect(o.watchdogTickMs).toBe(30000);
  expect(o.shellStallMs).toBe(300000);
  expect(o.waitCheckInMs).toBe(300000);
});

test("stallLimit accepts integers >= 1 only", () => {
  expect(resolveOptions({ stallLimit: 1 }).stallLimit).toBe(1);
  expect(resolveOptions({ stallLimit: 0 }).stallLimit).toBe(3);
  expect(resolveOptions({ stallLimit: 2.5 }).stallLimit).toBe(3);
});

test("booleans accept only boolean literals", () => {
  expect(resolveOptions({ judgeEnabled: "false" }).judgeEnabled).toBe(true);
  expect(resolveOptions({ judgeEnabled: "true" }).judgeEnabled).toBe(true);
  expect(resolveOptions({ judgeEnabled: 0 }).judgeEnabled).toBe(true);
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

// --- wakeDetail (2026-10-17: wake transcript footprint; default "slim") ---

test("wakeDetail: default 'slim'; 'full' is the explicit opt-in; anything else falls back to 'slim'", () => {
  expect(resolveOptions({}).wakeDetail).toBe("slim");
  expect(resolveOptions({ wakeDetail: "slim" }).wakeDetail).toBe("slim");
  expect(resolveOptions({ wakeDetail: "full" }).wakeDetail).toBe("full");
  // invalid / wrong-type values fall back to the default
  expect(resolveOptions({ wakeDetail: "FULL" }).wakeDetail).toBe("slim");
  expect(resolveOptions({ wakeDetail: "minimal" }).wakeDetail).toBe("slim");
  expect(resolveOptions({ wakeDetail: 1 }).wakeDetail).toBe("slim");
  expect(resolveOptions({ wakeDetail: null }).wakeDetail).toBe("slim");
});

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
