import { expect, test } from "bun:test";
import { createGoal, type GoalNextStep, type GoalRecord, type GoalTask } from "../src/state.ts";
import { backgroundCheckInText, buildWakeMessage, providerPauseRetryText } from "../src/wake.ts";

const NOW = 1_700_000_000_000;

function makeTask(title: string, status: GoalTask["status"], i: number): GoalTask {
  return {
    id: `t_${i}`,
    title,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function goalWith(opts: {
  id?: string;
  objective?: string;
  cap?: GoalRecord["cap"];
  used?: { turns: number; tokens: number };
  tasks?: GoalTask[];
  nextStep?: GoalNextStep;
} = {}): GoalRecord {
  const goal = createGoal(
    {
      sessionID: "ses_test",
      objective: opts.objective ?? "ship the wake builders",
    },
    NOW,
  );
  goal.id = opts.id ?? "g_abc";
  goal.cap = opts.cap ?? { turns: 10 };
  goal.used = opts.used ?? { turns: 3, tokens: 1200 };
  goal.tasks = opts.tasks ?? [];
  goal.nextStep = opts.nextStep;
  return goal;
}

const RECORD_FIRST_LINE =
  "No recorded next step yet — first record one: goal_next_step(<what is done, the ONE next concrete step, how you will judge it>), then execute it.";

// --- header: goal id, objective, turns usage ---

test("wake message carries the [goal] turn-N: speaker tag, re-states no goal content, and no goal id (de-id / single-format rulings)", () => {
  const g = goalWith({ objective: "ship the wake builders" });
  const msg = buildWakeMessage(g);
  expect(msg).toContain("[goal] turn-3: You advance this goal unattended");
  expect(msg).not.toContain("ship the wake builders");
  expect(msg).not.toContain("Objective:");
  expect(msg).not.toContain("g_abc");
});

test("no cap in the wake message (2026-10-20 de-cap ruling) — bare counter, no denominator, no Budget line", () => {
  const g = goalWith({});
  const msg = buildWakeMessage(g);
  expect(msg).not.toMatch(/turn \d+\/.+/);
  expect(msg).not.toContain("Budget:");
});

test("header shows the bare wake counter with any cap (de-cap ruling)", () => {
  const g = goalWith({ cap: {}, used: { turns: 2, tokens: 5 } });
  const msg = buildWakeMessage(g);
  expect(msg).toContain("turn-2");
  expect(msg).not.toContain("(unbounded)");
});

test("reactivated goals carry one reactivation context line (from-status + prior phase evidence) (2026-10-20 ruling)", () => {
  const g = goalWith({ nextStep: { text: "phase-2 step", turn: 0, ts: NOW }, used: { turns: 0, tokens: 0 } });
  g.reactivation = { from: "completed", at: NOW };
  g.evidenceHistory = [{ evidence: "bun test passed: all 12 tests green", at: NOW }];
  const msg = buildWakeMessage(g);
  expect(msg).toContain("Reactivated from completed");
  expect(msg).toContain("bun test passed: all 12 tests green");
  expect(msg).toContain("phase-2 step"); // the recorded step still replays
  // no reactivation -> the line is absent (plain wake unchanged)
  const plain = buildWakeMessage(goalWith({ nextStep: { text: "phase-2 step", turn: 0, ts: NOW } }));
  expect(plain).not.toContain("Reactivated");
});

test("multi-line recorded step text stays verbatim (user content, any language)", () => {
  const g = goalWith({ nextStep: { text: "line1\nline2", turn: 2, ts: NOW } });
  const msg = buildWakeMessage(g);
  expect(msg).toContain("Resume — your last recorded next step (turn 2): line1\nline2");
});

// --- terminal-tool keywords ---

test("wake message steers to goal_complete and goal_block", () => {
  const msg = buildWakeMessage(goalWith({}));
  expect(msg).toContain("goal_complete");
  expect(msg).toContain("goal_block");
});

// --- i18n ruling (2026-10-17): all plugin-generated text is English ---
// (user-provided content — objective/task titles/wakeText — may be any language;
// the plugin's OWN template wording must be CJK-free)

test("wake template wording is CJK-free (i18n ruling)", () => {
  const g = goalWith({
    objective: "an english objective",
    tasks: [makeTask("an english task", "doing", 1)],
  });
  const msg = buildWakeMessage(g, "judge wording", "extra wording");
  expect(/[一-鿿]/.test(msg)).toBe(false);
});

// --- judge instruction: both directions ---

test("judge instruction appears as its own section when provided", () => {
  const instruction = "evidence must be a re-runnable command output";
  const msg = buildWakeMessage(goalWith({}), instruction);
  expect(msg).toContain(`Judge note: ${instruction}`);
});

// --- wakeText (Task 14 Fix 3a): appended as the final Extra instruction line ---

test("wakeText appends an Extra instruction line at the end (after the judge section)", () => {
  const instruction = "evidence must be a re-runnable command output";
  const msg = buildWakeMessage(goalWith({}), instruction, "check the CI logs first");
  expect(msg).toContain(`Judge note: ${instruction}`);
  expect(msg.endsWith("Extra instruction: check the CI logs first")).toBe(true);
  expect(msg.indexOf("Judge note")).toBeLessThan(msg.indexOf("Extra instruction"));
});

test("wakeText without a judge section lands directly after the main body", () => {
  const msg = buildWakeMessage(goalWith({}), undefined, "check the CI logs first");
  expect(msg.endsWith("Extra instruction: check the CI logs first")).toBe(true);
  expect(msg).not.toContain("Judge note");
});

test("default (no wakeText) message is byte-identical to the pinned template", () => {
  // Pinned byte-for-byte: the wake = tag + autonomy line + next-step section.
  const g = goalWith({});
  const expected = [
    "[goal] turn-3: You advance this goal unattended. Don't ask the user questions and wait — follow the goal's discipline and take the next safe step. The only stops are goal_complete(evidence, a concrete verifiable anchor ≥24 chars) when the goal is done and goal_block(concrete reason) when you are genuinely blocked. A user message always overrides this reminder.",
    RECORD_FIRST_LINE,
  ].join("\n");
  expect(buildWakeMessage(g)).toBe(expected);
  expect(buildWakeMessage(g, undefined, undefined)).toBe(expected);
});

test("judge section is absent when no instruction is provided", () => {
  const msg = buildWakeMessage(goalWith({}));
  expect(msg).not.toContain("Judge note");
});

// --- the wake is ONE format (2026-10-20: wakeDetail removed) ---
// The wake re-states no goal content: the goal tools are already exposed in
// the model's system prompt (no per-turn re-teaching), the objective rides the
// conversation context, and after compaction the summary's [GOAL STATE] block
// carries objective + task status. The body line grants goal-mode autonomy
// (2026-10-18 reframe): advance unattended per the goal's discipline, don't
// stall on questions to the user; the ONLY two stops are goal_complete (done)
// and goal_block (genuinely blocked). A live user message always overrides.
// judge / wakeText channels unchanged.

test("the wake is the speaker tag + the autonomous goal-mode line ONLY (no goal content re-stated)", () => {
  const g = goalWith({
    tasks: [
      makeTask("first task", "done", 1),
      makeTask("second task", "doing", 2),
    ],
  });
  const msg = buildWakeMessage(g, undefined, undefined);
  expect(msg).toBe(
    [
      "[goal] turn-3: You advance this goal unattended. Don't ask the user questions and wait — follow the goal's discipline and take the next safe step. The only stops are goal_complete(evidence, a concrete verifiable anchor ≥24 chars) when the goal is done and goal_block(concrete reason) when you are genuinely blocked. A user message always overrides this reminder.",
      RECORD_FIRST_LINE,
    ].join("\n"),
  );
  // no budget / objective / task detail in slim — context carries the goal
  expect(msg).not.toContain("Budget:");
  expect(msg).not.toContain("Progress:");
  expect(msg).not.toContain("first task");
  // the two-stops contract survives
  expect(msg).toContain("goal_complete");
  expect(msg).toContain("goal_block");
  // autonomy ruling: no imperative forced-tool-call phrasing
  expect(msg).not.toContain("End this turn");
});

test("slim detail: judge + wakeText channels still append in the same order", () => {
  const msg = buildWakeMessage(goalWith({}), "check CI", "run tests first");
  expect(msg).toContain("Judge note: check CI");
  expect(msg.endsWith("Extra instruction: run tests first")).toBe(true);
  expect(msg.indexOf("Judge note")).toBeLessThan(msg.indexOf("Extra instruction"));
});

test("no judge section means the record-first line is the last body line", () => {
  const msg = buildWakeMessage(goalWith({}), undefined, undefined);
  expect(msg).not.toContain("Judge note");
  expect(msg).not.toContain("Extra instruction");
  expect(msg.split("\n").length).toBe(2);
  expect(msg.split("\n")[1]).toBe(RECORD_FIRST_LINE);
});

// --- backgroundCheckInText (2026-10-17 ruling: one-shot progress check after
// checkInDelaySec of silence while background work is in flight — a pure
// reminder; the plugin does no liveness checking of the background work) ---

test("backgroundCheckInText: byte-pinned reminder (in-flight count + wait, English)", () => {
  const t1 = backgroundCheckInText(1, 300);
  expect(t1).toBe(
    "Background check-in: 1 background item(s) in flight, no session activity for 300s. Goal mode: keep working unattended — check what finished, then take the next safe step per the goal's discipline (verify the background result, or make independent progress); don't stall on a question to the user. A user message always overrides this reminder.",
  );
  const t3 = backgroundCheckInText(3, 90);
  expect(t3).toBe(
    "Background check-in: 3 background item(s) in flight, no session activity for 90s. Goal mode: keep working unattended — check what finished, then take the next safe step per the goal's discipline (verify the background result, or make independent progress); don't stall on a question to the user. A user message always overrides this reminder.",
  );
  // i18n ruling: plugin-generated text is CJK-free
  expect(/[一-鿿]/.test(t1)).toBe(false);
  expect(/[一-鿿]/.test(t3)).toBe(false);
  // autonomy ruling (2026-10-18): no imperative forced-tool-call phrasing
  expect(t1).not.toContain("end this turn");
});

test("providerPauseRetryText: byte-pinned retry wake (2026-10-18 reframe: report-and-stop, the loop auto-retries)", () => {
  const t = providerPauseRetryText("g_abc");
  expect(t).toBe(
    "Provider pause retry: model requests were failing with a provider error (quota/funds) — retrying goal g_abc. If a request still fails, note it in your reply — the loop auto-pauses and retries at the next deadline; a clean turn resumes. A user message always overrides this reminder.",
  );
  expect(t).not.toContain("end this turn");
});

// --- P0-2 (2026-10-16 A/B) superseded (2026-10-17 minimal ruling, 2026-10-20
// single format): the original A/B evidence (the reference plugin's model
// actively used goal_add_task/goal_update_task; ours never did) motivated the
// opt-in "full" re-grounding — with the single wake format that opt-in is
// gone too; the wake teaches nothing (the tools ride the system prompt).

test("the wake does NOT re-teach the goal tools (they are exposed in the system prompt)", () => {
  const msg = buildWakeMessage(goalWith({}));
  expect(msg).not.toContain("goal_add_task");
  expect(msg).not.toContain("goal_update_task");
});

// --- next-step resume (2026-10-20 ruling — goal_next_step) ---
// Case 1 (the session ended its turn per the rules — nextStep recorded):
// replay the model's own last synthesis + verify-then-execute.
// Case 2 (the session stopped abruptly — no record): the wake commands a
// record-first, then-execute. The record rides the wake (a guaranteed moment),
// not the model's spontaneous discipline.

test("recorded nextStep replays as a Resume section and suppresses the record-first line", () => {
  const ns: GoalNextStep = {
    text: "re-test radix-4 three-leg transfer, judge: n>=9 and Xid 154 stays 0",
    turn: 3,
    ts: NOW,
  };
  const msg = buildWakeMessage(goalWith({ nextStep: ns }));
  expect(msg).toContain("Resume — your last recorded next step (turn 3): re-test radix-4 three-leg transfer, judge: n>=9 and Xid 154 stays 0");
  expect(msg).toContain("Verify it is still valid (update it with goal_next_step if the situation changed), then execute it.");
  expect(msg).not.toContain("No recorded next step yet");
});

test("absent nextStep carries the record-first line", () => {
  const msg = buildWakeMessage(goalWith({}));
  expect(msg).toContain(RECORD_FIRST_LINE);
  expect(msg).not.toContain("Resume —");
});

test("next-step section lands after the body, before the judge/wakeText channels (both branches)", () => {
  const withNote = buildWakeMessage(
    goalWith({ nextStep: { text: "ship it", turn: 2, ts: NOW } }),
    "judge wording",
    "extra wording",
  );
  const iBody = withNote.indexOf("A user message always overrides this reminder.");
  const iNext = withNote.indexOf("Resume —");
  const iJudge = withNote.indexOf("Judge note:");
  const iExtra = withNote.indexOf("Extra instruction:");
  expect(iBody).toBeLessThan(iNext);
  expect(iNext).toBeLessThan(iJudge);
  expect(iJudge).toBeLessThan(iExtra);

  const noNote = buildWakeMessage(goalWith({}), "judge wording", "extra wording");
  expect(noNote.indexOf(RECORD_FIRST_LINE)).toBeGreaterThan(noNote.indexOf("A user message always overrides this reminder."));
  expect(noNote.indexOf(RECORD_FIRST_LINE)).toBeLessThan(noNote.indexOf("Judge note:"));
});

test("stale record (more than one turn behind) is NOT replayed — the record-first line forces a fresh synthesis", () => {
  // recorded at turn 1, now at turn 3 → the last turn never updated it
  const g = goalWith({ nextStep: { text: "ancient plan", turn: 1, ts: NOW } });
  {
    const msg = buildWakeMessage(g);
    expect(msg).toContain(RECORD_FIRST_LINE);
    expect(msg).not.toContain("ancient plan");
    expect(msg).not.toContain("Resume —");
  }
  // one turn behind (the normal wake-to-wake cadence) is still fresh
  const h = goalWith({ nextStep: { text: "last turn's plan", turn: 2, ts: NOW } });
  const msg = buildWakeMessage(h);
  expect(msg).toContain("Resume — your last recorded next step (turn 2): last turn's plan");
});

test("next-step wording is CJK-free (i18n ruling) even when the recorded text is not", () => {
  const ns: GoalNextStep = { text: "继续 RD 复测（中文内容原样回放）", turn: 2, ts: NOW };
  const msg = buildWakeMessage(goalWith({ nextStep: ns }));
  expect(msg).toContain("继续 RD 复测（中文内容原样回放）");
  // strip the user-content replay line; the plugin's OWN wording stays CJK-free
  const pluginOnly = msg.replace(ns.text, "");
  expect(/[一-鿿]/.test(pluginOnly)).toBe(false);
});

// --- the wake re-states no goal content (2026-10-17 minimal ruling,
// 2026-10-20 single format) — the conversation context carries the goal;
// the wake carries the tag + terminal trigger only ---

test("the wake carries no objective/budget/task detail — tag + trigger only", () => {
  const g = goalWith({
    objective: "slim objective",
    tasks: [
      makeTask("搭骨架", "done", 1),
      makeTask("写测试", "doing", 2),
    ],
  });
  const msg = buildWakeMessage(g, undefined, undefined);
  expect(msg).toContain("[goal] turn-3:");
  expect(msg).not.toContain("g_abc");
  expect(msg).not.toContain("slim objective");
  expect(msg).not.toContain("Budget:");
  expect(msg).not.toContain("1. [");
  expect(msg).not.toContain("2. [doing] 写测试");
});
