import { expect, test } from "bun:test";
import { resolveOptions, parseModelRef, selectJudgeModel, type Options } from "../src/options.ts";

const EXPECTED_DEFAULTS: Options = {
  stallLimit: 3,
  judgeEnabled: false,
  judgeMaxPerGoal: 1,
  watchdogTickMs: 30000,
  checkInDelaySec: 300,
  timeoutWrap: false,
  providerFailLimit: 2,
  providerPauseMs: 30 * 60 * 1000,
  foregroundShellBackgroundMs: 10 * 60 * 1000, // §52 (0 = disabled is a valid value); 2026-10-27: 30 → 10 min
  foregroundNoticeCommandChars: 300, // §54 (0 = no command text is a valid value)
  livenessMs: 5 * 60_000, // §54: §50 windows option ized
  livenessCheckMs: 30_000,
  wakeText: undefined,
};

test("empty input yields every default exactly", () => {
  const o = resolveOptions({});
  expect(o.stallLimit).toBe(3);
  expect(o.judgeEnabled).toBe(false);
  expect(o.judgeMaxPerGoal).toBe(1);
  expect(o.watchdogTickMs).toBe(30000);
  expect(o.checkInDelaySec).toBe(300);
  expect(o.timeoutWrap).toBe(false);
  expect(o.providerFailLimit).toBe(2);
  expect(o.providerPauseMs).toBe(30 * 60 * 1000);
  expect(o.foregroundShellBackgroundMs).toBe(10 * 60 * 1000); // §52: 10 min default (2026-10-27)
  expect(o.foregroundNoticeCommandChars).toBe(300); // §54
  expect(o.livenessMs).toBe(5 * 60 * 1000); // §54
  expect(o.livenessCheckMs).toBe(30_000); // §54
  expect(o.wakeText).toBeUndefined();
  expect(o).toEqual(EXPECTED_DEFAULTS);
});

test("§52: foregroundShellBackgroundMs — 0 is a valid value (disabled); non-integers fall back", () => {
  expect(resolveOptions({ foregroundShellBackgroundMs: 0 }).foregroundShellBackgroundMs).toBe(0);
  expect(resolveOptions({ foregroundShellBackgroundMs: 5000 }).foregroundShellBackgroundMs).toBe(5000);
  expect(resolveOptions({ foregroundShellBackgroundMs: -1 }).foregroundShellBackgroundMs).toBe(10 * 60 * 1000);
  expect(resolveOptions({ foregroundShellBackgroundMs: 1.5 }).foregroundShellBackgroundMs).toBe(10 * 60 * 1000);
  expect(resolveOptions({ foregroundShellBackgroundMs: "30000" }).foregroundShellBackgroundMs).toBe(10 * 60 * 1000);
});

test("§54: foregroundNoticeCommandChars — 0 is valid (no command text); non-integers fall back", () => {
  expect(resolveOptions({ foregroundNoticeCommandChars: 0 }).foregroundNoticeCommandChars).toBe(0);
  expect(resolveOptions({ foregroundNoticeCommandChars: 50 }).foregroundNoticeCommandChars).toBe(50);
  expect(resolveOptions({ foregroundNoticeCommandChars: -1 }).foregroundNoticeCommandChars).toBe(300);
  expect(resolveOptions({ foregroundNoticeCommandChars: "300" }).foregroundNoticeCommandChars).toBe(300);
});

test("§54: livenessMs / livenessCheckMs — positive integers take effect, invalid fall back", () => {
  expect(resolveOptions({ livenessMs: 15_000 }).livenessMs).toBe(15_000);
  expect(resolveOptions({ livenessCheckMs: 5_000 }).livenessCheckMs).toBe(5_000);
  expect(resolveOptions({ livenessMs: 0 }).livenessMs).toBe(5 * 60 * 1000); // 0 is NOT valid here
  expect(resolveOptions({ livenessCheckMs: -3 }).livenessCheckMs).toBe(30_000);
  expect(resolveOptions({ livenessMs: "300000" }).livenessMs).toBe(5 * 60 * 1000);
  expect(resolveOptions({ livenessCheckMs: 1.5 }).livenessCheckMs).toBe(30_000);
});

test("partial overrides take effect, the rest stay default", () => {
  const o = resolveOptions({
    stallLimit: 5,
    judgeEnabled: false,
    judgeMaxPerGoal: 2,
    watchdogTickMs: 15000,
    timeoutWrap: true,
    wakeText: "continue the goal",
  });
  expect(o.stallLimit).toBe(5);
  expect(o.judgeEnabled).toBe(false);
  expect(o.judgeMaxPerGoal).toBe(2);
  expect(o.watchdogTickMs).toBe(15000);
  expect(o.timeoutWrap).toBe(true);
  expect(o.wakeText).toBe("continue the goal");
});

test("non-number / invalid numeric input falls back to defaults", () => {
  const o = resolveOptions({
    stallLimit: "3",
    judgeMaxPerGoal: 0,
    watchdogTickMs: -1,
  });
  expect(o.stallLimit).toBe(3);
  expect(o.judgeMaxPerGoal).toBe(1);
  expect(o.watchdogTickMs).toBe(30000);
});

test("2026-10-27 ruling: legacy defaultCapTurns/defaultCapTokens config keys are IGNORED — goal creation is unbounded by default (cap only via explicit --turns/--tokens)", () => {
  // 129 incident: a configured defaultCapTurns: 10 silently ended a long
  // unattended goal at turn 10. The options no longer exist; stale config
  // keys are inert (same discipline as the removed wakeDetail key).
  expect(resolveOptions({ defaultCapTurns: 10, defaultCapTokens: 100000 })).toEqual(EXPECTED_DEFAULTS);
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
