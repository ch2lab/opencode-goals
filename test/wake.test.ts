import { expect, test } from "bun:test";
import { createGoal, type GoalRecord, type GoalTask } from "../src/state.ts";
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
  return goal;
}

// --- header: goal id, objective, turns usage ---

test("wake message carries [GOAL <id>], the verbatim objective, and turns usage", () => {
  const g = goalWith({ objective: "ship the wake builders" });
  const msg = buildWakeMessage(g, "10 turns / 100k tokens");
  expect(msg).toContain("[GOAL g_abc");
  expect(msg).toContain("ship the wake builders");
  expect(msg).toContain("3/10");
});

test("caps string is embedded verbatim in the wake message", () => {
  const g = goalWith({});
  const caps = "10 turns / 100k tokens";
  expect(buildWakeMessage(g, caps)).toContain(caps);
});

test("undefined cap.turns renders the usage as (unbounded)", () => {
  const g = goalWith({ cap: {}, used: { turns: 2, tokens: 5 } });
  const msg = buildWakeMessage(g, "unbounded");
  expect(msg).toContain("(unbounded)");
});

// --- task lines: "N. [status] title" ---

test("each task renders as 'N. [status] title' with 1-based index", () => {
  const g = goalWith({
    tasks: [
      makeTask("搭骨架", "done", 1),
      makeTask("写测试", "doing", 2),
      makeTask("提交", "todo", 3),
    ],
  });
  const msg = buildWakeMessage(g, "10 turns");
  expect(msg).toContain("1. [done] 搭骨架");
  expect(msg).toContain("2. [doing] 写测试");
  expect(msg).toContain("3. [todo] 提交");
});

// --- terminal-tool keywords ---

test("wake message steers to goal_complete and goal_block", () => {
  const msg = buildWakeMessage(goalWith({}), "unbounded");
  expect(msg).toContain("goal_complete");
  expect(msg).toContain("goal_block");
});

// --- i18n ruling (2026-10-17): all plugin-generated text is English ---
// (user-provided content — objective/task titles/wakeText — may be any language;
// the plugin's OWN template wording must be CJK-free)

test("wake template wording is CJK-free (i18n ruling), both details", () => {
  const g = goalWith({
    objective: "an english objective",
    tasks: [makeTask("an english task", "doing", 1)],
  });
  const full = buildWakeMessage(g, "10 turns", "judge wording", "extra wording", "full");
  const slim = buildWakeMessage(g, "10 turns", "judge wording", "extra wording", "slim");
  expect(/[一-鿿]/.test(full)).toBe(false);
  expect(/[一-鿿]/.test(slim)).toBe(false);
});

// --- judge instruction: both directions ---

test("judge instruction appears as its own section when provided", () => {
  const instruction = "evidence must be a re-runnable command output";
  const msg = buildWakeMessage(goalWith({}), "10 turns", instruction);
  expect(msg).toContain(`Judge note: ${instruction}`);
});

// --- wakeText (Task 14 Fix 3a): appended as the final Extra instruction line ---

test("wakeText appends an Extra instruction line at the end (after the judge section)", () => {
  const instruction = "evidence must be a re-runnable command output";
  const msg = buildWakeMessage(goalWith({}), "10 turns", instruction, "check the CI logs first");
  expect(msg).toContain(`Judge note: ${instruction}`);
  expect(msg.endsWith("Extra instruction: check the CI logs first")).toBe(true);
  expect(msg.indexOf("Judge note")).toBeLessThan(msg.indexOf("Extra instruction"));
});

test("wakeText without a judge section lands directly after the main body", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns", undefined, "check the CI logs first");
  expect(msg.endsWith("Extra instruction: check the CI logs first")).toBe(true);
  expect(msg).not.toContain("Judge note");
});

test("default (no wakeText) message is byte-identical to the pinned template", () => {
  // Pinned byte-for-byte: the 4th parameter must be a pure no-op when unset.
  const g = goalWith({});
  const expected = [
    "[GOAL g_abc | turn 3/10]",
    "Budget: 10 turns",
    "Objective: ship the wake builders",
    "Progress:",
    "  (no tasks)",
    "Goal mode: you advance this goal unattended — don't stall on questions to the user. Review the progress above, then:",
    "- done → goal_complete(evidence): completion criteria met (evidence must be a concrete verifiable anchor: file/test/output, ≥24 chars);",
    "- genuinely blocked → goal_block(reason), with a concrete reason;",
    "- otherwise → advance with the next concrete tool per the goal's discipline: if there are no tasks yet, plan first with goal_add_task(title); sync with goal_update_task(ref, status) as you go.",
    "A user message always overrides this reminder.",
  ].join("\n");
  expect(buildWakeMessage(g, "10 turns")).toBe(expected);
  expect(buildWakeMessage(g, "10 turns", undefined, undefined)).toBe(expected);
});

test("judge section is absent when no instruction is provided", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns");
  expect(msg).not.toContain("Judge note");
});

// --- wakeDetail "slim" (2026-10-17, then minimized) ---
// Minimal ruling: the goal tools are already exposed in the model's system
// prompt (no per-turn re-teaching) and the objective rides the conversation
// context — so the slim wake is the header + ONE body line only.
// 2026-10-18 ruling (autonomy reframe): the body line is NO LONGER the
// imperative forced-tool-call menu — it grants goal-mode autonomy (advance
// unattended per the goal's discipline, don't stall on questions to the user)
// and names the ONLY two stops: goal_complete (done) and goal_block
// (genuinely blocked). A live user message always overrides.
// judge / wakeText channels unchanged.

test("slim detail: header + the autonomous goal-mode line ONLY (2026-10-18 reframe)", () => {
  const g = goalWith({
    tasks: [
      makeTask("first task", "done", 1),
      makeTask("second task", "doing", 2),
    ],
  });
  const msg = buildWakeMessage(g, "10 turns", undefined, undefined, "slim");
  expect(msg).toBe(
    [
      "[GOAL g_abc | turn 3/10]",
      "Goal mode: you advance this goal unattended. Don't ask the user questions and wait — follow the goal's discipline and take the next safe step. The only stops are goal_complete(evidence, a concrete verifiable anchor ≥24 chars) when the goal is done and goal_block(concrete reason) when you are genuinely blocked. A user message always overrides this reminder.",
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
  const msg = buildWakeMessage(goalWith({}), "10 turns", "check CI", "run tests first", "slim");
  expect(msg).toContain("Judge note: check CI");
  expect(msg.endsWith("Extra instruction: run tests first")).toBe(true);
  expect(msg.indexOf("Judge note")).toBeLessThan(msg.indexOf("Extra instruction"));
});

test("slim detail: no judge section means the trigger line is the last body line", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns", undefined, undefined, "slim");
  expect(msg).not.toContain("Judge note");
  expect(msg).not.toContain("Extra instruction");
  expect(msg.split("\n").length).toBe(2);
});

test("full detail is the explicit opt-out (5th arg, same as the default)", () => {
  const g = goalWith({});
  const full = buildWakeMessage(g, "10 turns", undefined, undefined, "full");
  expect(full).toBe(buildWakeMessage(g, "10 turns"));
  expect(full).toContain("Objective:");
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

// --- empty tasks ---

test("goal with no tasks: no-todo marker, no task lines, rest of contract holds", () => {
  const g = goalWith({ objective: "no tasks goal" });
  const msg = buildWakeMessage(g, "unbounded");
  expect(msg).toContain("(no tasks)");
  expect(msg).not.toContain("1. [");
  expect(msg).toContain("[GOAL g_abc");
  expect(msg).toContain("no tasks goal");
  expect(msg).toContain("goal_complete");
  expect(msg).toContain("goal_block");
});

// --- P0-2 (2026-10-16 A/B) superseded for "slim" (2026-10-17 minimal ruling) ---
// Original evidence: live A/B — the reference plugin's model actively used
// goal_add_task/goal_update_task; ours never did. The tools are exposed in
// the model's system prompt, so the slim wake no longer re-teaches them; the
// "full" detail keeps the imperative instruction (opt-in re-grounding).

test("slim wake does NOT re-teach the goal tools (they are exposed in the system prompt)", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns", undefined, undefined, "slim");
  expect(msg).not.toContain("goal_add_task");
  expect(msg).not.toContain("goal_update_task");
});

test("full wake message carries the imperative task-maintenance instruction (goal_add_task + goal_update_task)", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns");
  expect(msg).toContain("goal_add_task");
  expect(msg).toContain("goal_update_task");
});

// --- slim wake: minimal (2026-10-17) — the conversation context carries the
// goal; the wake re-states nothing but the turn header + terminal trigger ---

test("slim wake carries no objective/budget/task detail — header + trigger only", () => {
  const g = goalWith({
    objective: "slim objective",
    tasks: [
      makeTask("搭骨架", "done", 1),
      makeTask("写测试", "doing", 2),
    ],
  });
  const msg = buildWakeMessage(g, "10 turns", undefined, undefined, "slim");
  expect(msg).toContain("[GOAL g_abc");
  expect(msg).not.toContain("slim objective");
  expect(msg).not.toContain("Budget:");
  expect(msg).not.toContain("1. [");
  expect(msg).not.toContain("2. [doing] 写测试");
});
