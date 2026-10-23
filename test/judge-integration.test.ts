// Task 9: the side-channel judge in the stall ladder (spec §8), driven
// through the deterministic harness. Every case starts from an active goal
// and drives three "plugin wake + no tool.called" boundaries (stalls 0 → 3,
// stallLimit = 3) to hit the ladder — the same linear pattern as
// test/arbiter.test.ts (`await h.emit(e)` resolves only after the
// controller's consumer loop has PROCESSED e, so there are no races).
//
// The fake judge is injected via deps.judge (same shape as Task 8's fake):
// it counts calls, captures the noActionTexts argument, and returns a
// scripted verdict per case (or rejects, per controller ruling).
//
// Controller rulings pinned here:
//  - a REJECTING judge = give_up semantics (stalled), never continue;
//  - `continue` with no instruction → the wake carries NO judge paragraph
//    (buildWakeMessage contract);
//  - judge-unavailable at the limit (disabled / already used) → directly
//    stalled with a stallReport explaining why the judge did not rule.
import * as fs from "node:fs";
import { expect, test } from "bun:test";
import { decisionLogPath } from "../src/decisionlog.ts";
import { resolveOptions } from "../src/options.ts";
import { archivedGoalKey, goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import type { Judge, JudgeVerdict } from "../src/judge.ts";
import type { HostEvent } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Scriptable fake judge: counts calls, captures noActionTexts, one scripted verdict. */
interface FakeJudge {
  judge: Judge;
  readonly calls: number;
  readonly lastTexts: string[] | undefined;
  readonly lastGoalID: string | undefined;
  script(verdict: JudgeVerdict): void;
  reject(): void;
}

function fakeJudge(): FakeJudge {
  let calls = 0;
  let lastTexts: string[] | undefined;
  let lastGoalID: string | undefined;
  let scripted: JudgeVerdict | undefined;
  let willReject = false;
  const judge: Judge = {
    judge: async (goal, texts) => {
      calls += 1;
      lastTexts = [...texts];
      lastGoalID = goal.id;
      if (willReject) throw new Error("judge backend exploded");
      if (scripted === undefined) throw new Error("fake judge: no verdict scripted");
      return { ...scripted };
    },
  };
  return {
    judge,
    get calls() {
      return calls;
    },
    get lastTexts() {
      return lastTexts;
    },
    get lastGoalID() {
      return lastGoalID;
    },
    script: (v) => {
      scripted = v;
      willReject = false;
    },
    reject: () => {
      willReject = true;
    },
  };
}

interface Boot {
  h: Harness;
  stop: () => Promise<void>;
  fake: FakeJudge;
}

async function boot(options: Record<string, unknown> = {}): Promise<Boot> {
  const h = await createHarness();
  const fake = fakeJudge();
  // These tests exercise the judge itself → enable it explicitly (the default
  // flipped to false on 2026-10-17; test 7 opts back out with an explicit false).
  const ctrl = new GoalController(h.probe, resolveOptions({ judgeEnabled: true, ...options }), { judge: fake.judge });
  const stop = await ctrl.start();
  return { h, stop, fake };
}

function goalOf(h: Harness, sessionID = S): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(sessionID)) as GoalRecord | undefined;
}

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}

// schema/dist/session-event.d.ts: data = { sessionID }.
function succeeded(id: string, sessionID = S): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID });
}

function started(id: string, sessionID = S): HostEvent {
  return ev("session.execution.started", id, { sessionID });
}

// schema/dist/session-event.d.ts (InboxEnqueued): data = { item, inboxID, sessionID }.
function enqueuedUser(inboxID: string, sessionID = S): HostEvent {
  return ev("session.inbox.enqueued", `q_${inboxID}`, {
    inboxID,
    sessionID,
    item: { type: "user", payload: { text: "keep going" }, delivery: "queue" },
  });
}

/**
 * Drives `n` "plugin wake + no tool.called" boundaries after a user inbox
 * item: e0 (user boundary → stalls 0, wake W1), then started + succeeded
 * pairs (each boundary → stalls k, wake Wk+1). The started events clear the
 * continuationPending window so every boundary is arbitrated normally.
 */
async function runStalls(h: Harness, n: number, tag: string): Promise<void> {
  await h.emit(enqueuedUser(`i_${tag}`));
  await h.emit(succeeded(`e${tag}0`)); // W1 — user boundary, stalls 0
  for (let k = 1; k <= n; k++) {
    await h.emit(started(`s${tag}${k}`));
    await h.emit(succeeded(`e${tag}${k + 1}`)); // no tool.called → stalls k
  }
}

// ---------------------------------------------------------------------------
// 1. continue
// ---------------------------------------------------------------------------

test("1: continue — stalls zeroed, judgeUsed persisted, instruction rides the next wake", async () => {
  const { h, stop, fake } = await boot();
  fake.script({ verdict: "continue", reason: "r", instruction: "next step" });
  await h.commandExecutor(S, "/goal set JudgeContinue");
  const g0 = goalOf(h)!;
  // executionTail rule: last user/synthetic message is the bound; take the
  // assistant text parts AFTER it (≤3 most recent).
  h.setMessages(S, [
    { id: "m1", type: "user", text: "start the work" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "tail-one" }] },
    { id: "m3", type: "assistant", content: [{ type: "text", text: "tail-two" }] },
    { id: "m4", type: "assistant", content: [{ type: "text", text: "tail-three" }] },
    { id: "m5", type: "assistant", content: [{ type: "text", text: "tail-four" }] },
  ]);
  await runStalls(h, 3, "c");
  const g = goalOf(h)!;
  expect(g.id).toBe(g0.id);
  expect(g.status).toBe("active");
  expect(g.stalls).toBe(0); // continue zeros the stall count
  expect(g.judgeUsed).toBe(true); // persistent gate, saved to storage
  expect(fake.calls).toBe(1);
  expect(fake.lastGoalID).toBe(g0.id);
  expect(fake.lastTexts).toEqual(["tail-two", "tail-three", "tail-four"]); // bound + ≤3
  const wake = h.prompts[h.prompts.length - 1].input;
  expect(wake.text).toContain("next step"); // judge instruction paragraph
  expect(wake.text).toContain("Judge note");
  await stop();
});

// ---------------------------------------------------------------------------
// 2. complete (valid)
// ---------------------------------------------------------------------------

test("2: complete with valid evidence — completed + archived (evidence gate passes)", async () => {
  const { h, stop, fake } = await boot();
  const evidence = "tests passed for parser.ts — 12/12 green";
  fake.script({ verdict: "complete", reason: "done", evidence });
  await h.commandExecutor(S, "/goal set JudgeComplete");
  const g0 = goalOf(h)!;
  h.setMessages(S, [
    { id: "m1", type: "user", text: "implement parser.ts and pass the tests" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "working on parser.ts" }] },
  ]);
  await runStalls(h, 3, "p");
  const g = goalOf(h)!;
  expect(g.status).toBe("completed");
  expect(g.evidence).toBe(evidence);
  const archived = h.storage.get(archivedGoalKey(S, g.id));
  expect(archived).toBeDefined();
  expect((archived as GoalRecord).status).toBe("completed");
  const notice = h.synthetics[h.synthetics.length - 1].input;
  expect(notice.text).toContain("completed");
  expect(notice.resume).toBe(false); // §48: terminal notice = record, not a host auto-wake
  expect(fake.calls).toBe(1);
  await stop();
});

// ---------------------------------------------------------------------------
// 3. complete (invalid evidence → demoted to continue)
// ---------------------------------------------------------------------------

test("3: complete with ungrounded evidence — demoted to continue (no complete, no judge paragraph)", async () => {
  const { h, stop, fake } = await boot();
  // ≥24 chars, anchored ("verified"), but zero token overlap with the
  // transcript → validateEvidence fails → the verdict is demoted.
  fake.script({ verdict: "complete", reason: "fabricated", evidence: "everything is verified and the final result is green" });
  await h.commandExecutor(S, "/goal set JudgeDemote");
  h.setMessages(S, [
    { id: "m1", type: "user", text: "do it" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "on it" }] },
  ]);
  await runStalls(h, 3, "d");
  const g = goalOf(h)!;
  expect(g.status).toBe("active"); // NOT completed
  expect(g.stalls).toBe(0); // continue semantics
  expect(g.judgeUsed).toBe(true);
  expect(g.evidence).toBeUndefined();
  const wake = h.prompts[h.prompts.length - 1].input;
  expect(wake.text).not.toContain("Judge note"); // no instruction → no judge paragraph
  expect(fake.calls).toBe(1);
  await stop();
});

// ---------------------------------------------------------------------------
// 4. needs_human
// ---------------------------------------------------------------------------

test("4: needs_human — blocked with the judge's reason; a user inbox message resumes", async () => {
  const { h, stop, fake } = await boot();
  fake.script({ verdict: "needs_human", reason: "需要生产库凭据" });
  await h.commandExecutor(S, "/goal set JudgeHuman");
  const g0 = goalOf(h)!;
  h.setMessages(S, [
    { id: "m1", type: "user", text: "go" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "stalling" }] },
  ]);
  await runStalls(h, 3, "h");
  const g = goalOf(h)!;
  expect(g.id).toBe(g0.id);
  expect(g.status).toBe("blocked");
  expect(g.blocker).toContain("需要生产库凭据"); // judge's reason verbatim
  const notice = h.synthetics[h.synthetics.length - 1].input;
  expect(notice.text).toContain("blocked");
  expect(notice.resume).toBe(false); // §48: blocked notice = record, not a host auto-wake
  expect(fake.calls).toBe(1);
  // blocked-resume path (Task 8, spec §15-9, §55 2026-10-24 ruling: user inbox
  // → active again — but NO immediate injected wake; the user message's own
  // turn is the stimulus, the loop resumes at the next boundary).
  const promptsBeforeResume = h.prompts.length;
  await h.emit(enqueuedUser("i_resume"));
  const after = goalOf(h)!;
  expect(after.status).toBe("active");
  expect(after.stalls).toBe(0);
  expect(h.prompts.length).toBe(promptsBeforeResume); // §55: no immediate wake injection
  // §49/§55: the resume is logged (previously "有消息无日志"; §55 relabels the
  // line "resume" — no message is in the queue, so "wake" would break the
  // decision-log invariant).
  const resumeLines = fs
    .readFileSync(decisionLogPath(process.pid), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.sessionID === S && l.goalID === after.id && String(l.reason).includes("§15-9"));
  expect(resumeLines.length).toBeGreaterThanOrEqual(1);
  expect(resumeLines[resumeLines.length - 1]!.decision).toBe("resume");
  await stop();
});

// ---------------------------------------------------------------------------
// 5. give_up
// ---------------------------------------------------------------------------

test("5: give_up — stalled with stallReport (objective, tasks, no-action tails, judge reason) + synthetic notice", async () => {
  const { h, stop, fake } = await boot();
  fake.script({ verdict: "give_up", reason: "no viable path remains" });
  await h.commandExecutor(S, "/goal set JudgeGiveUp");
  expect(await h.toolExecutor("goal_add_task", { title: "write the parser" }, S)).toContain("added");
  expect(await h.toolExecutor("goal_add_task", { title: "run the suite" }, S)).toContain("added");
  expect(await h.toolExecutor("goal_update_task", { ref: "1", status: "doing" }, S)).toContain("doing");
  h.setMessages(S, [
    { id: "m1", type: "user", text: "keep going" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "stall-text-one" }] },
    { id: "m3", type: "assistant", content: [{ type: "text", text: "stall-text-two" }] },
  ]);
  await runStalls(h, 3, "g");
  const g = goalOf(h)!;
  expect(g.status).toBe("stalled");
  const report = g.stallReport!;
  expect(report).toContain("JudgeGiveUp"); // objective verbatim
  expect(report).toContain("1. [doing] write the parser"); // task snapshot: index + status + title
  expect(report).toContain("2. [todo] run the suite");
  expect(report).toContain("stall-text-one"); // last ≤3 no-action texts verbatim
  expect(report).toContain("stall-text-two");
  expect(report).toContain("no viable path remains"); // judge reason
  const notice = h.synthetics[h.synthetics.length - 1].input;
  expect(notice.metadata?.goalControl).toBe(true);
  expect(notice.text).toContain("JudgeGiveUp"); // the synthetic carries the report
  expect(notice.text).toContain("no viable path remains");
  expect(notice.resume).toBe(false); // §48: stall notice = record, not a host auto-wake
  expect(h.storage.get(archivedGoalKey(S, g.id))).toBeDefined(); // archived
  await stop();
});

// ---------------------------------------------------------------------------
// 6. judgeMaxPerGoal (persistent gate = judgeUsed)
// ---------------------------------------------------------------------------

test("6: one judge per goal — after continue, three more no-action boundaries stall directly (no re-judge)", async () => {
  const { h, stop, fake } = await boot();
  fake.script({ verdict: "continue", reason: "r" }); // no instruction
  await h.commandExecutor(S, "/goal set JudgeOnce");
  const g0 = goalOf(h)!;
  h.setMessages(S, [
    { id: "m1", type: "user", text: "start" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "no action" }] },
  ]);
  await runStalls(h, 3, "a"); // judge called once → continue
  expect(fake.calls).toBe(1);
  expect(goalOf(h)!.judgeUsed).toBe(true);
  for (let k = 1; k <= 3; k++) {
    await h.emit(started(`s2_${k}`));
    await h.emit(succeeded(`e2_${k}`));
  }
  expect(fake.calls).toBe(1); // EXACTLY — the judge is never called a second time
  const g = goalOf(h)!;
  expect(g.id).toBe(g0.id);
  expect(g.status).toBe("stalled");
  expect(g.stallReport).toContain("Judge already used"); // fixed wording: judge already used
  expect(h.storage.get(archivedGoalKey(S, g.id))).toBeDefined();
  await stop();
});

// ---------------------------------------------------------------------------
// 7. judgeEnabled = false
// ---------------------------------------------------------------------------

test("7: judgeEnabled=false — the fake is never called, directly stalled at the limit", async () => {
  const { h, stop, fake } = await boot({ judgeEnabled: false });
  fake.script({ verdict: "give_up", reason: "never" }); // must never be called
  await h.commandExecutor(S, "/goal set NoJudge");
  h.setMessages(S, [
    { id: "m1", type: "user", text: "start" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "stalling hard" }] },
  ]);
  await runStalls(h, 3, "n");
  expect(fake.calls).toBe(0);
  const g = goalOf(h)!;
  expect(g.status).toBe("stalled");
  expect(g.stallReport).toContain("NoJudge"); // objective verbatim in the report
  expect(g.stallReport).toContain("stalling hard"); // no-action tails
  expect(g.stallReport).toContain("Judge not enabled"); // fixed wording: judge disabled
  expect(h.synthetics[h.synthetics.length - 1].input.metadata?.goalControl).toBe(true);
  await stop();
});

// ---------------------------------------------------------------------------
// 14. Task 14 Fix 1 (async face): a verdict that lands on a STALE record is
// dropped silently — no archive copy, no user-visible terminal claim, loop
// keeps processing.
// ---------------------------------------------------------------------------

test("14: judge complete verdict on a stale record — silent drop, no terminal claim, loop survives", async () => {
  const h = await createHarness();
  let judgeCalls = 0;
  let resolveVerdict: (v: JudgeVerdict) => void = () => {};
  const pending = new Promise<JudgeVerdict>((r) => {
    resolveVerdict = r;
  });
  const judge: Judge = {
    judge: async () => {
      judgeCalls += 1;
      return pending; // LONG judge await — spans the /goal pause below
    },
  };
  const ctrl = new GoalController(h.probe, resolveOptions({ judgeEnabled: true }), { judge });
  const stop = await ctrl.start();
  const evidence = "bun test passed: all 12 tests green in goal-loop.test.ts";
  await h.commandExecutor(S, "/goal set JudgeStale");
  h.setMessages(S, [
    { id: "m1", type: "user", text: "run the tests, the tests passed for goal-loop.test.ts" },
  ]);
  // Drive 3 stalls; the 4th boundary calls the (pending) judge
  await h.emit(enqueuedUser("i14"));
  await h.emit(succeeded("ej0")); // W1 — user boundary, stalls 0
  await h.emit(started("sj1"));
  await h.emit(succeeded("ej1")); // W2 — stalls 1
  await h.emit(started("sj2"));
  await h.emit(succeeded("ej2")); // W3 — stalls 2
  await h.emit(started("sj3"));
  const third = h.emit(succeeded("ej3")); // stalls 3 → judge call, PENDING
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (judgeCalls >= 1) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - t0 > 2000) {
        clearInterval(t);
        reject(new Error("judge was never called"));
      }
    }, 5);
  });
  // During the judge's await: /goal pause writes the NEWER record
  await h.commandExecutor(S, "/goal pause");
  const pausedAt = goalOf(h)!.updatedAt;
  resolveVerdict({ verdict: "complete", reason: "done", evidence });
  await third; // verdict disposed (the drop path)
  const g = goalOf(h)!;
  expect(g.status).toBe("paused"); // NOT completed — the stale write was dropped
  expect(g.updatedAt).toBe(pausedAt);
  expect(h.storage.get(archivedGoalKey(S, g.id))).toBeUndefined(); // no archive copy
  expect(h.prompts.length).toBe(3); // W1..W3 — the verdict injected no wake
  for (const c of h.synthetics) {
    expect(c.input.text).not.toContain("completed"); // no user-visible terminal claim
  }
  // The event loop survived the drop: a further boundary is still processed
  const promptsBefore = h.prompts.length;
  await h.emit(succeeded("ej4")); // paused goal → record-only, no wake
  expect(h.prompts.length).toBe(promptsBefore);
  expect(goalOf(h)!.lastHandledEventID).toBe("ej4");
  await stop();
});

// ---------------------------------------------------------------------------
// 8. judge rejects (fail-closed wiring)
// ---------------------------------------------------------------------------

test("8: judge rejects — fail-closed stalled, the event loop survives and keeps processing", async () => {
  const { h, stop, fake } = await boot();
  fake.reject();
  await h.commandExecutor(S, "/goal set JudgeCrash");
  h.setMessages(S, [
    { id: "m1", type: "user", text: "start" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "still here" }] },
  ]);
  await runStalls(h, 3, "x");
  expect(goalOf(h)!.status).toBe("stalled"); // ruling: reject = give_up semantics
  expect(goalOf(h)!.stallReport).toContain("Judge call failed"); // fixed wording
  const promptsBefore = h.prompts.length;
  // A subsequent boundary must still be handled normally (record-only, no wake).
  await h.emit(succeeded("e_after"));
  expect(h.prompts.length).toBe(promptsBefore);
  expect(goalOf(h)!.status).toBe("stalled");
  await stop();
});
