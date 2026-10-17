import { expect, test } from "bun:test";
import { createGoal, type GoalRecord, type GoalTask } from "../src/state.ts";
import {
  buildJudgePrompt,
  parseJudgeOutput,
  SessionGenerateJudge,
  type JudgeGenerator,
} from "../src/judge.ts";

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
  objective?: string;
  cap?: GoalRecord["cap"];
  used?: { turns: number; tokens: number };
  tasks?: GoalTask[];
} = {}): GoalRecord {
  const goal = createGoal(
    {
      sessionID: "ses_test",
      objective: opts.objective ?? "ship the judge",
    },
    NOW,
  );
  goal.id = "g_abc";
  goal.cap = opts.cap ?? { turns: 10, tokens: 100_000 };
  goal.used = opts.used ?? { turns: 3, tokens: 42_000 };
  goal.tasks = opts.tasks ?? [];
  return goal;
}

// --- parseJudgeOutput: valid JSON, all four verdicts ---

test("parse: continue — exact object, optional fields passed through", () => {
  const raw = JSON.stringify({
    verdict: "continue",
    reason: "tests still red",
    instruction: "run bun test and fix the failing suite",
  });
  expect(parseJudgeOutput(raw)).toEqual({
    verdict: "continue",
    reason: "tests still red",
    instruction: "run bun test and fix the failing suite",
  });
});

test("parse: complete with evidence — exact object", () => {
  const raw = JSON.stringify({
    verdict: "complete",
    reason: "all criteria met",
    evidence: "bun test: 103 pass, 0 fail",
  });
  expect(parseJudgeOutput(raw)).toEqual({
    verdict: "complete",
    reason: "all criteria met",
    evidence: "bun test: 103 pass, 0 fail",
  });
});

test("parse: needs_human — exact object", () => {
  const raw = JSON.stringify({
    verdict: "needs_human",
    reason: "requires a paid API key",
  });
  expect(parseJudgeOutput(raw)).toEqual({
    verdict: "needs_human",
    reason: "requires a paid API key",
  });
});

test("parse: give_up — exact object", () => {
  const raw = JSON.stringify({
    verdict: "give_up",
    reason: "environment lacks the required toolchain",
  });
  expect(parseJudgeOutput(raw)).toEqual({
    verdict: "give_up",
    reason: "environment lacks the required toolchain",
  });
});

test("parse: continue without instruction is allowed", () => {
  const raw = JSON.stringify({ verdict: "continue", reason: "keep going" });
  expect(parseJudgeOutput(raw)).toEqual({
    verdict: "continue",
    reason: "keep going",
  });
});

test("parse: extra fields are ignored, not rejected", () => {
  const raw = JSON.stringify({
    verdict: "give_up",
    reason: "stuck",
    confidence: 0.9,
    extra: [1, 2, 3],
  });
  expect(parseJudgeOutput(raw)).toEqual({ verdict: "give_up", reason: "stuck" });
});

// --- parseJudgeOutput: every failure mode is undefined (fail-closed) ---

test("parse: truncated JSON is undefined", () => {
  expect(
    parseJudgeOutput('{"verdict": "complete", "reason": "a'),
  ).toBeUndefined();
});

test("parse: prose before the JSON is undefined (whole trimmed string must be JSON)", () => {
  expect(
    parseJudgeOutput(
      'Here is the result: {"verdict": "give_up", "reason": "no"}',
    ),
  ).toBeUndefined();
});

test("parse: prose after the JSON is undefined", () => {
  expect(
    parseJudgeOutput(
      '{"verdict": "continue", "reason": "go"} — that was my answer',
    ),
  ).toBeUndefined();
});

test("parse: markdown ```json fence counts as prose → undefined", () => {
  const fenced =
    "```json\n" +
    '{"verdict": "give_up", "reason": "x"}' +
    "\n```";
  expect(parseJudgeOutput(fenced)).toBeUndefined();
});

test("parse: verdict outside the enum (\"finished\") is undefined", () => {
  expect(
    parseJudgeOutput(
      JSON.stringify({ verdict: "finished", reason: "done" }),
    ),
  ).toBeUndefined();
});

test("parse: complete without evidence is undefined", () => {
  expect(
    parseJudgeOutput(
      JSON.stringify({ verdict: "complete", reason: "looks fine" }),
    ),
  ).toBeUndefined();
});

test("parse: complete with non-string evidence is undefined", () => {
  expect(
    parseJudgeOutput(
      JSON.stringify({
        verdict: "complete",
        reason: "looks fine",
        evidence: 42,
      }),
    ),
  ).toBeUndefined();
});

test("parse: missing reason is undefined", () => {
  expect(
    parseJudgeOutput(JSON.stringify({ verdict: "continue" })),
  ).toBeUndefined();
});

test("parse: non-string reason is undefined", () => {
  expect(
    parseJudgeOutput(JSON.stringify({ verdict: "continue", reason: 7 })),
  ).toBeUndefined();
});

test("parse: empty string is undefined", () => {
  expect(parseJudgeOutput("")).toBeUndefined();
});

// --- buildJudgePrompt: contract assertions ---

function judgeGoal(): GoalRecord {
  return goalWith({
    objective: "ship the judge",
    cap: { turns: 10, tokens: 100_000 },
    used: { turns: 3, tokens: 42_000 },
    tasks: [
      makeTask("搭骨架", "done", 1),
      makeTask("写测试", "doing", 2),
      makeTask("提交", "todo", 3),
    ],
  });
}

const NO_ACTION_TEXTS = ["first stall note", "second stall note"];
const BUDGET_TEXT = "3/10 turns, 42000/100000 tokens";

test("prompt: contains the verbatim objective", () => {
  expect(buildJudgePrompt(judgeGoal(), NO_ACTION_TEXTS, BUDGET_TEXT)).toContain(
    "ship the judge",
  );
});

test("prompt: contains each task status line", () => {
  const p = buildJudgePrompt(judgeGoal(), NO_ACTION_TEXTS, BUDGET_TEXT);
  expect(p).toContain("1. [done] 搭骨架");
  expect(p).toContain("2. [doing] 写测试");
  expect(p).toContain("3. [todo] 提交");
});

test("prompt: contains every no-action text verbatim, in order", () => {
  const p = buildJudgePrompt(judgeGoal(), NO_ACTION_TEXTS, BUDGET_TEXT);
  expect(p.indexOf("first stall note")).toBeGreaterThan(-1);
  expect(
    p.indexOf("second stall note"),
  ).toBeGreaterThan(p.indexOf("first stall note"));
});

test("prompt: contains budgetText verbatim", () => {
  expect(buildJudgePrompt(judgeGoal(), NO_ACTION_TEXTS, BUDGET_TEXT)).toContain(
    BUDGET_TEXT,
  );
});

test("prompt: requires JSON-only output, names all four verdicts and field rules", () => {
  const p = buildJudgePrompt(judgeGoal(), NO_ACTION_TEXTS, BUDGET_TEXT);
  expect(p).toContain("output ONLY JSON");
  for (const v of ["continue", "complete", "needs_human", "give_up"]) {
    expect(p).toContain(v);
  }
  expect(p).toContain("reason is required");
  expect(p).toContain("evidence is required only when verdict=complete");
  // instruction is OPTIONAL on continue — the prompt must not claim it 必填.
  expect(p).toContain("instruction: optional when verdict=continue");
  expect(p).not.toContain("instruction is required");
});

// --- SessionGenerateJudge: injected generator, fail-closed ---

test("judge: generator returns valid JSON → parsed verdict is returned", async () => {
  const text = JSON.stringify({
    verdict: "continue",
    reason: "keep going",
    instruction: "next step",
  });
  const gen: JudgeGenerator = async () => ({ text });
  const judge = new SessionGenerateJudge(gen);
  expect(await judge.judge(goalWith({}), [])).toEqual({
    verdict: "continue",
    reason: "keep going",
    instruction: "next step",
  });
});

test("judge: generator returns garbage → fail-closed give_up with exact reason", async () => {
  const gen: JudgeGenerator = async () => ({
    text: "I think the goal should be finished because...",
  });
  const judge = new SessionGenerateJudge(gen);
  expect(await judge.judge(goalWith({}), NO_ACTION_TEXTS)).toEqual({
    verdict: "give_up",
    reason: "judge output unparseable",
  });
});

test("judge: generator throws → fail-closed give_up with exact reason", async () => {
  const gen: JudgeGenerator = async () => {
    throw new Error("session generation exploded");
  };
  const judge = new SessionGenerateJudge(gen);
  expect(await judge.judge(goalWith({}), NO_ACTION_TEXTS)).toEqual({
    verdict: "give_up",
    reason: "judge output unparseable",
  });
});

test("judge: generator resolves with non-string text → RESOLVES fail-closed give_up", async () => {
  const gen: JudgeGenerator = async () => ({ text: 42 as unknown as string });
  const judge = new SessionGenerateJudge(gen);
  // Must RESOLVE (not reject) with the exact fail-closed verdict.
  expect(await judge.judge(goalWith({}), NO_ACTION_TEXTS)).toEqual({
    verdict: "give_up",
    reason: "judge output unparseable",
  });
});

test("judge: generates with goal.sessionID and a prompt carrying objective + budget", async () => {
  const seen: Array<{ sessionID: string; prompt: string }> = [];
  const gen: JudgeGenerator = async (input) => {
    seen.push(input);
    return {
      text: JSON.stringify({ verdict: "give_up", reason: "x" }),
    };
  };
  const judge = new SessionGenerateJudge(gen);
  await judge.judge(goalWith({ objective: "ship the judge" }), []);
  expect(seen).toHaveLength(1);
  expect(seen[0].sessionID).toBe("ses_test");
  expect(seen[0].prompt).toContain("ship the judge");
  expect(seen[0].prompt).toContain("3/10 turns, 42000/100000 tokens");
});
