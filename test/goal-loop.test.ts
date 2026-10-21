// Task 7: goal-loop controller — lifecycle + commands + tools, driven
// through the REAL GoalController.start() against the deterministic harness
// (test/harness.ts). The 12 behavior groups are the Task 7 brief contract.
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { archivedGoalKey, goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";
import type { HostEvent, SyntheticInput } from "../src/types.ts";

const S = "s1";

// schema/dist/session-event.d.ts: data = { sessionID } for execution events.
function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}

function started(id: string, sessionID = S): HostEvent {
  return ev("session.execution.started", id, { sessionID });
}

function succeeded(id: string, sessionID = S): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID });
}

// schema/dist/session-event.d.ts (UsageUpdated): data = { cost, tokens, sessionID }.
function usage(id: string, tokens: Record<string, unknown>, sessionID = S): HostEvent {
  return ev("session.usage.updated", id, { tokens, sessionID });
}

async function boot(): Promise<{ h: Harness; ctrl: GoalController; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  return { h, ctrl, stop };
}

function goalOf(h: Harness, sessionID = S): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(sessionID)) as GoalRecord | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function lastSynthetic(h: Harness): SyntheticInput {
  const call = h.synthetics[h.synthetics.length - 1];
  expect(call, "a synthetic feedback must have been emitted").toBeDefined();
  return call.input;
}

// Grounded evidence that passes all three validateEvidence layers against the
// user message injected next to it (length >= 24, anchored, token overlap).
const EVIDENCE = "bun test passed: all 12 tests green in goal-loop.test.ts";
const EVIDENCE_MESSAGE = { id: "m1", type: "user", text: "run the tests, the tests passed for goal-loop.test.ts" };

// ---------------------------------------------------------------------------
// 1. set -> view
// ---------------------------------------------------------------------------

test("1: set creates an active goal; view reports objective + cap; view without a goal says so", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ship it");
  const g = goalOf(h);
  expect(g).toBeDefined();
  expect(g!.status).toBe("active");
  expect(g!.id).toMatch(/^g_/);
  expect(g!.objective).toBe("Ship it");
  expect(g!.sessionID).toBe(S);
  expect(g!.cap).toEqual({}); // 2026-10-20: goals are unbounded by default (no default cap at all)
  // every synthetic carries the goalControl marker (Task 8 arbiter dependency)
  expect(h.synthetics.every((c) => c.input.metadata?.goalControl === true)).toBe(true);
  expect(lastSynthetic(h).text).toContain("Ship it");

  await h.commandExecutor(S, "/goal view");
  const view = lastSynthetic(h).text;
  expect(view).toContain("Ship it");
  expect(view).toContain("unbounded turns / unbounded tokens");

  // a session without a goal gets the "no active goal" phrasing
  await h.commandExecutor("s2", "/goal view");
  expect(lastSynthetic(h).text).toContain("no active goal");
  await stop();
});

test("1b: set flag parsing — explicit caps, --unbounded, flag errors, missing objective", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Flagged --turns 3 --tokens 777");
  const g = goalOf(h);
  expect(g!.objective).toBe("Flagged");
  expect(g!.cap).toEqual({ turns: 3, tokens: 777 });

  // a non-terminal goal refuses the replacement (R7: nothing is touched) —
  // so terminate the first goal through a covered terminal path (complete
  // with grounded evidence) before the replacement can succeed
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  expect(await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S)).toContain("completed");
  expect(goalOf(h)!.status).toBe("completed");
  // a terminal goal does not block the replacement
  await h.commandExecutor(S, "/goal set Unbounded --unbounded");
  expect(goalOf(h)!.objective).toBe("Unbounded");
  expect(goalOf(h)!.cap).toEqual({});

  const h2 = (await boot()).h;
  await h2.commandExecutor(S, "/goal set Bad --turns abc");
  expect(lastSynthetic(h2).text).toContain("--turns");
  await h2.commandExecutor(S, "/goal set");
  expect(lastSynthetic(h2).text).toContain("objective");
  await h2.commandExecutor(S, "/goal set Bad --tokens 0");
  expect(lastSynthetic(h2).text).toContain("--tokens");
  await stop();
});

test("1c: unknown subcommand and bare /goal produce usage text, never a throw", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal frobnicate");
  expect(lastSynthetic(h).text).toContain("unknown goal subcommand");
  await h.commandExecutor(S, "/goal");
  expect(lastSynthetic(h).text).toContain("Usage:");
  await stop();
});

test("1d: every user command result line kicks (visible output); machine notices stay pure records (§48-#2 / §49-rev 2026-10-21)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Kick");
  expect(lastSynthetic(h).resume).not.toBe(false); // set keeps the host auto-wake

  await h.commandExecutor(S, "/goal view");
  expect(lastSynthetic(h).resume).not.toBe(false); // §49-rev: user query kicks — the reply IS the visible output
  await h.commandExecutor(S, "/goal pause");
  expect(lastSynthetic(h).resume).not.toBe(false); // §49-rev: state change → user sees confirmation
  await h.commandExecutor(S, "/goal history");
  expect(lastSynthetic(h).resume).not.toBe(false); // §49-rev: user query kicks
  await h.commandExecutor(S, "/goal resume");
  expect(lastSynthetic(h).resume).not.toBe(false); // resume keeps the kick (§47)
  await h.commandExecutor(S, "/goal complete");
  expect(lastSynthetic(h).resume).not.toBe(false); // §49-rev: error path visible too

  await stop();
});

test("1e: harness A+B — a non-resume synthetic is recorded as a would-wake AND drives a real turn; a terminal notice adds neither (§48)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Terminal --tokens 100000");
  // A: the set's result line (no resume) is the single would-wake.
  expect(h.wakes).toHaveLength(1);
  // B: that wake drove a REAL turn — by the time commandExecutor returns the
  // auto-turn is processed, so the goal's last handled event is the auto-wake
  // turn's terminal (the controller actually processed it).
  expect(goalOf(h)!.lastHandledEventID).toMatch(/^awake_\d+_e$/);

  // Trip the tokens cap → budget_limited (a terminal notice, resume:false).
  await h.emit(usage("u1", { input: 100000 }));
  await h.emit(started("s1"));
  await h.emit(succeeded("e1"));
  expect(goalOf(h)!.status).toBe("budget_limited");
  // A: the terminal notice added NO wake — h.wakes is still just the set.
  expect(h.wakes).toHaveLength(1);
  await stop();
});

test("1f: every command result line kicks — a refused set and a no-op resume included, so the user sees the refusal (§49-rev)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Kick");
  expect(lastSynthetic(h).resume).not.toBe(false); // successful set → kick
  await h.commandExecutor(S, "/goal set Other");
  expect(lastSynthetic(h).text).toContain("still in progress");
  expect(lastSynthetic(h).resume).not.toBe(false); // refused set → visible to the user
  await h.commandExecutor(S, "/goal resume");
  expect(lastSynthetic(h).text).toContain("already active");
  expect(lastSynthetic(h).resume).not.toBe(false); // no-op resume → visible too
  await stop();
});

test("1g: 2.1.1 kick-synthetic shape — a goalControl item delivered as type:user is CONTROL, no spurious wake (§50)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set NoSpur");
  // §50 real-host finding (2026-10-21 verify-wake run): 2.1.1 delivers our KICK
  // result-line synthetic as a USER-typed inbox item carrying the goalControl
  // metadata (record lines arrive as type:"synthetic"). The metadata — not the
  // host's item type — is the attribution signal; classifying on the type
  // re-attributed the kick line as "user" and the kick turn's boundary woke
  // spuriously (burning the goal's budget turn).
  await h.emit(ev("session.inbox.enqueued", "q_k1", {
    sessionID: S,
    inboxID: "inbox_k1",
    item: { type: "user", payload: { text: "goal NoSpur set — active", metadata: { goalControl: true } }, delivery: "queue" },
  }));
  // The host steers it into the running turn: by the boundary it is delivered
  // (gone from the live inbox store) — the queued gate is clear.
  await h.probe.inboxCancel("inbox_k1");
  await h.emit(started("s1"));
  await h.emit(succeeded("e1"));
  // The kick turn's boundary sees lastInbox=control → NO wake: a kick line must
  // never burn budget nor restart a parked loop.
  expect(h.prompts.length).toBe(0);
  await stop();
});

// ---------------------------------------------------------------------------
// 2. set while a non-terminal goal exists: refuse ("still") + archive old
// ---------------------------------------------------------------------------

test("2: set while a non-terminal goal exists refuses (still) and leaves the old goal untouched (R7)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Old objective");
  const before = goalOf(h)!;
  const beforeRaw = structuredClone(before);
  const archivedPrefix = `${goalStorageKey(S)}/archived/`;
  const archivedBefore = await h.probe.storageScan(archivedPrefix);
  await h.commandExecutor(S, "/goal set New objective");
  expect(lastSynthetic(h).text).toContain("still");
  // R7 (spec §9): the old goal is untouched as a GOAL — same id/status/
  // objective/tasks/usage, nothing written under archivedGoalKey. (§49-rev:
  // the refused set now kicks a visible-reply turn, whose boundary may
  // advance lastHandledEventID — that is transport bookkeeping, not a goal
  // change.)
  const after = goalOf(h)!;
  expect(after.id).toBe(before.id);
  expect(after.status).toBe(before.status); // unchanged (still active)
  expect(after.objective).toBe("Old objective");
  expect(after.tasks).toEqual(beforeRaw.tasks);
  expect(after.used).toEqual(beforeRaw.used);
  expect(after.cap).toEqual(beforeRaw.cap);
  const archivedAfter = await h.probe.storageScan(archivedPrefix);
  expect(archivedAfter).toEqual(archivedBefore); // empty: the refusal archived nothing
  expect(h.storage.get(archivedGoalKey(S, before.id))).toBeUndefined();
  await stop();
});

// ---------------------------------------------------------------------------
// 3. goal_complete
// ---------------------------------------------------------------------------

test("3: goal_complete with grounded evidence completes + archives; non-active is refused", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Finish the parser");
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  const reply = await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S);
  expect(reply).toContain("completed");
  const g = goalOf(h)!;
  expect(g.status).toBe("completed");
  expect(g.evidence).toBe(EVIDENCE);
  const archived = h.storage.get(archivedGoalKey(S, g.id)) as GoalRecord | undefined;
  expect(archived).toBeDefined();
  expect(archived!.objective).toBe("Finish the parser");
  expect(archived!.status).toBe("completed");

  // not active anymore
  const again = await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S);
  expect(again).toContain("not active");
  await stop();
});

// ---------------------------------------------------------------------------
// 4. goal_block
// ---------------------------------------------------------------------------

test("4: goal_block with reason blocks + archives; without reason refuses and stays active", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ship the API");
  // missing reason first (while still active): refused, goal untouched
  const noReason = await h.toolExecutor("goal_block", {}, S);
  expect(noReason).toContain("reason");
  expect(goalOf(h)!.status).toBe("active");
  const reply = await h.toolExecutor("goal_block", { reason: "waiting on external API approval" }, S);
  expect(reply).toContain("blocked");
  const g = goalOf(h)!;
  expect(g.status).toBe("blocked");
  expect(g.blocker).toBe("waiting on external API approval");
  expect(h.storage.get(archivedGoalKey(S, g.id))).toBeDefined();
  await stop();
});

// ---------------------------------------------------------------------------
// 5. goal_clear (transcript-grounded, fail-closed)
// ---------------------------------------------------------------------------

test("5: /goal clear finds the user's clear request in the transcript; without a transcript it is fail-closed", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Clean up the repo");
  // no transcript: refused, goal stays active
  await h.commandExecutor(S, "/goal clear");
  expect(lastSynthetic(h).text).toContain("transcript");
  expect(goalOf(h)!.status).toBe("active");
  // with a user clear request in the transcript: cleared + archived
  h.setMessages(S, [{ id: "m1", type: "user", text: "please discard the branch and stop the work" }]);
  await h.commandExecutor(S, "/goal clear");
  const g = goalOf(h)!;
  expect(lastSynthetic(h).text).toContain("cleared");
  expect(g.status).toBe("cleared");
  expect(h.storage.get(archivedGoalKey(S, g.id))).toBeDefined();
  await stop();
});

test("5b: goal_clear tool with an explicit request; ungrounded request is refused", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ship the CLI");
  // no transcript at all -> fail-closed refusal, goal untouched
  const noTranscript = await h.toolExecutor("goal_clear", { request: "cancel the deploy and discard the build artifacts" }, S);
  expect(noTranscript).toContain("transcript");
  expect(goalOf(h)!.status).toBe("active");
  // grounded in a user message -> cleared
  h.setMessages(S, [{ id: "m1", type: "user", text: "cancel the deploy and discard the build artifacts" }]);
  const reply = await h.toolExecutor("goal_clear", { request: "cancel the deploy and discard the build artifacts" }, S);
  expect(reply).toContain("cleared");
  expect(goalOf(h)!.status).toBe("cleared");
  await stop();
});

// ---------------------------------------------------------------------------
// 6. task commands (2026-10-18 ruling: no task cap — the old 50 limit is gone)
// ---------------------------------------------------------------------------

test("6: /goal task add + status update; the 51st add succeeds (no cap)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Task loop");
  await h.commandExecutor(S, "/goal task add t1");
  expect(lastSynthetic(h).text).toContain("t1");
  expect(goalOf(h)!.tasks[0]).toMatchObject({ title: "t1", status: "todo" });
  for (let i = 2; i <= 50; i++) await h.commandExecutor(S, `/goal task add t${i}`);
  expect(goalOf(h)!.tasks.length).toBe(50);
  await h.commandExecutor(S, "/goal task 1 doing");
  expect(goalOf(h)!.tasks[0].status).toBe("doing");
  await h.commandExecutor(S, "/goal task add t51");
  expect(goalOf(h)!.tasks.length).toBe(51);
  expect(goalOf(h)!.tasks[50]).toMatchObject({ title: "t51", status: "todo" });
  await stop();
});

// ---------------------------------------------------------------------------
// 7. pause / resume
// ---------------------------------------------------------------------------

test("7: pause rejects goal_complete (not active); resume restores active", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Draft the docs");
  await h.commandExecutor(S, "/goal pause");
  expect(goalOf(h)!.status).toBe("paused");
  const reply = await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S);
  expect(reply).toContain("not active");
  expect(goalOf(h)!.status).toBe("paused");
  await h.commandExecutor(S, "/goal resume");
  expect(goalOf(h)!.status).toBe("active");
  await stop();
});

// ---------------------------------------------------------------------------
// 16-18. /goal resume coverage (spec §15-9 / §11: blocked and budget_limited are resumable)
// ---------------------------------------------------------------------------

test("16: /goal resume on a blocked goal → active, blocker cleared, stalls 0, NO explicit wake (2026-10-20 ruling: the command result line is the kick — an injected re-wake was a redundant second execution-capable message the user had to delete)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Blocked via command");
  const reply = await h.toolExecutor("goal_block", { reason: "waiting for external decision" }, S);
  expect(reply).toContain("blocked");
  const g = goalOf(h)!;
  expect(goalOf(h)!.blocker).toBe("waiting for external decision");
  await h.commandExecutor(S, "/goal resume");
  const after = goalOf(h)!;
  expect(after.id).toBe(g.id);
  expect(after.status).toBe("active");
  expect(after.stalls).toBe(0);
  expect(after.blocker).toBeUndefined(); // the stale blocker must not survive the resume (129 incident)
  expect(h.prompts.length).toBe(0); // no explicit re-wake: the host admits the result-line synthetic (steer + wake) — ONE message
  expect(after.used.turns).toBe(0);
  expect(after.continuations).toBe(0);
  await stop();
});

test("17: /goal resume on a budget_limited goal → active, NO explicit wake (2026-10-20 ruling; spec §11: resumable continuation)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Budgeted --tokens 100");
  await h.emit(usage("u1", { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
  await h.emit(started("s1"));
  await h.emit(succeeded("e1")); // budget check precedes attribution → budget_limited
  const id = goalOf(h)!.id;
  expect(goalOf(h)!.status).toBe("budget_limited");
  const before = h.prompts.length;
  await h.commandExecutor(S, "/goal resume");
  const after = goalOf(h)!;
  expect(after.id).toBe(id);
  expect(after.status).toBe("active");
  expect(after.stalls).toBe(0);
  expect(h.prompts.length).toBe(before); // no explicit re-wake
  await stop();
});

test("18: /goal resume rejects terminal states (completed stays hard-terminal, no wake)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Sealed");
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S);
  expect(goalOf(h)!.status).toBe("completed");
  const before = h.prompts.length;
  await h.commandExecutor(S, "/goal resume");
  expect(goalOf(h)!.status).toBe("completed"); // untouched
  expect(h.prompts.length).toBe(before); // no wake
  await stop();
});

test("19: resume from budget_limited grants one boundary budget grace — the kick turn does not re-limit; the next over-cap boundary does (§49)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set G --tokens 100000");
  await h.emit(usage("u1", { input: 100000 }));
  await h.emit(started("s1"));
  await h.emit(succeeded("e1"));
  expect(goalOf(h)!.status).toBe("budget_limited");
  await h.commandExecutor(S, "/goal resume");
  // The resume's own kick turn (host auto-wake, §48-B) consumes the grace
  // instead of immediately re-limiting the just-resumed goal.
  expect(goalOf(h)!.status).toBe("active");
  await h.emit(started("s2"));
  await h.emit(succeeded("e2"));
  expect(goalOf(h)!.status).toBe("budget_limited"); // one-shot: the next over-cap boundary re-limits
  await stop();
});

// ---------------------------------------------------------------------------
// 19-21. conversation surface: goal_pause / goal_resume / goal_view tools
// (2026-10-18 ruling — every /goal capability gets a tool face so the user
// can manage the goal in plain conversation; the tools reuse the exact
// command cores: tool/command equivalence, no behavior fork)
// ---------------------------------------------------------------------------

test("19: goal_pause tool pauses an active goal (conversation surface)", async () => {
  const { h, stop } = await boot();
  expect(await h.toolExecutor("goal_pause", {}, S)).toContain("no active goal");
  await h.commandExecutor(S, "/goal set Pause via tool");
  expect(await h.toolExecutor("goal_pause", {}, S)).toContain("paused");
  expect(goalOf(h)!.status).toBe("paused");
  expect(await h.toolExecutor("goal_pause", {}, S)).toContain("already paused");
  await stop();
});

test("20: goal_resume tool resumes paused/blocked/budget_limited, refuses active and terminal", async () => {
  const { h, stop } = await boot();
  expect(await h.toolExecutor("goal_resume", {}, S)).toContain("no active goal");
  await h.commandExecutor(S, "/goal set Resume via tool");
  expect(await h.toolExecutor("goal_resume", {}, S)).toContain("already active");
  // paused: silent restart, no wake
  await h.toolExecutor("goal_pause", {}, S);
  const before = h.prompts.length;
  expect(await h.toolExecutor("goal_resume", {}, S)).toContain("resumed");
  expect(goalOf(h)!.status).toBe("active");
  expect(h.prompts.length).toBe(before); // paused keeps its no-wake behavior
  // blocked: blocker cleared, NO explicit wake (2026-10-20 ruling — the model
  // is mid-turn on the tool path; the boundary re-wakes at the next turn end)
  await h.toolExecutor("goal_block", { reason: "waiting on vendor" }, S);
  expect(goalOf(h)!.status).toBe("blocked");
  expect(await h.toolExecutor("goal_resume", {}, S)).toContain("resumed");
  expect(goalOf(h)!.status).toBe("active");
  expect(goalOf(h)!.blocker).toBeUndefined();
  expect(h.prompts.length).toBe(before);
  // budget_limited: active + one wake (spec §11) — the previous goal must be
  // terminal first (R7: set refuses while a non-terminal goal exists)
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S);
  expect(goalOf(h)!.status).toBe("completed");
  await h.commandExecutor(S, "/goal set Budgeted --tokens 100");
  await h.emit(usage("u2", { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
  await h.emit(started("s1b"));
  await h.emit(succeeded("e1b"));
  expect(goalOf(h)!.status).toBe("budget_limited");
  const before2 = h.prompts.length;
  expect(await h.toolExecutor("goal_resume", {}, S)).toContain("resumed");
  expect(goalOf(h)!.status).toBe("active");
  expect(h.prompts.length).toBe(before2); // no explicit re-wake (2026-10-20 ruling)
  // completed: hard terminal, refused, no wake
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S);
  expect(goalOf(h)!.status).toBe("completed");
  const before3 = h.prompts.length;
  expect(await h.toolExecutor("goal_resume", {}, S)).toContain("not resumable");
  expect(goalOf(h)!.status).toBe("completed");
  expect(h.prompts.length).toBe(before3);
  await stop();
});

test("21: goal_view tool reports status/objective/cap/usage without side effects", async () => {
  const { h, stop } = await boot();
  expect(await h.toolExecutor("goal_view", {}, S)).toContain("no active goal");
  await h.commandExecutor(S, "/goal set View via tool");
  const reply = await h.toolExecutor("goal_view", {}, S);
  expect(reply).toContain("active");
  expect(reply).toContain("View via tool");
  expect(goalOf(h)!.status).toBe("active"); // read-only
  expect(h.prompts.length).toBe(0); // no wake
  await stop();
});

// ---------------------------------------------------------------------------
// 8. tool/command equivalence (one example each)
// ---------------------------------------------------------------------------

test("8: goal_set / goal_add_task / goal_update_task are command-equivalent", async () => {
  const { h, stop } = await boot();
  const reply = await h.toolExecutor("goal_set", { objective: "Build it" }, S);
  expect(reply).toContain("created");
  expect(goalOf(h)!.objective).toBe("Build it");
  expect(goalOf(h)!.cap).toEqual({}); // unbounded by default (2026-10-20 ruling)
  expect(await h.toolExecutor("goal_add_task", { title: "a1" }, S)).toContain("a1");
  expect(goalOf(h)!.tasks[0]).toMatchObject({ title: "a1", status: "todo" });
  expect(await h.toolExecutor("goal_update_task", { ref: "1", status: "done" }, S)).toContain("done");
  expect(goalOf(h)!.tasks[0].status).toBe("done");
  await stop();
});

// ---------------------------------------------------------------------------
// 8b. goal_next_step (2026-10-20 ruling — the model's next-step plan, replayed
// by the next boundary wake — the dispatch-brief structure for the goal loop)
// ---------------------------------------------------------------------------

test("8b: goal_next_step records the model's next-step plan (turn + ts stamped); bad input, missing and terminal goals are refused", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Next step probe");
  const reply = await h.toolExecutor("goal_next_step", { text: "re-test, judge: n>=9" }, S);
  expect(reply).toContain("recorded");
  const ns = goalOf(h)!.nextStep;
  expect(ns).toMatchObject({ text: "re-test, judge: n>=9" });
  expect(ns!.turn).toBe(goalOf(h)!.used.turns);
  expect(ns!.ts).toBeGreaterThan(0);
  // latest write wins
  await h.toolExecutor("goal_next_step", { text: "second plan" }, S);
  expect(goalOf(h)!.nextStep!.text).toBe("second plan");
  // bad input
  expect(await h.toolExecutor("goal_next_step", {}, S)).toMatch(/text/);
  expect(await h.toolExecutor("goal_next_step", { text: "   " }, S)).toMatch(/text/);
  // cleared goal refuses the write (the user's explicit discard is never
  // overridden by a model call — 2026-10-20 reactivation ruling)
  h.setMessages(S, [{ id: "m2", type: "user", text: "discard the probe goal and stop the work" }]);
  await h.toolExecutor("goal_clear", { request: "discard the probe goal and stop the work" }, S);
  expect(goalOf(h)!.status).toBe("cleared");
  expect(await h.toolExecutor("goal_next_step", { text: "late" }, S)).toContain("cleared");
  expect(goalOf(h)!.nextStep!.text).toBe("second plan");
  await stop();
  // no active goal
  const { h: h2, stop: stop2 } = await boot();
  expect(await h2.toolExecutor("goal_next_step", { text: "x" }, S)).toContain("no active goal");
  await stop2();
});

// ---------------------------------------------------------------------------
// 8c-8d. goal_next_step reactivation (2026-10-20 ruling — 129 incident: a
// call on an ended goal used to be a dead end; now it re-activates the goal
// as a fresh phase. cleared and budget_limited stay terminal: the user's
// explicit discard and an explicit cap are never overridden by the model)
// ---------------------------------------------------------------------------

test("8c: goal_next_step reactivates completed/paused/blocked/stalled goals as a fresh phase (counters reset, evidence preserved, step recorded)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Reactivate probe");
  // phase 1: completed with grounded evidence
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  expect(await h.toolExecutor("goal_complete", { evidence: EVIDENCE }, S)).toContain("completed");
  // the persisted phase-1 record consumed budget — reactivation must reset it
  // (and drop the stale goal_wait window — the "waiting" belonged to phase 1,
  // a reactivated phase must not inherit its silence)
  const phase1 = goalOf(h)!;
  phase1.used = { turns: 7, tokens: 12345 };
  phase1.stalls = 2;
  phase1.waitUntil = Date.now() + 60 * 60 * 1000;
  h.storage.set(goalStorageKey(S), phase1);
  const reply = await h.toolExecutor("goal_next_step", { text: "phase-2: verify, then archive" }, S);
  expect(reply).toContain("reactivated");
  expect(reply).toContain("completed");
  const g = goalOf(h)!;
  expect(g.status).toBe("active");
  expect(g.used).toEqual({ turns: 0, tokens: 0 }); // fresh phase budget (cap unchanged)
  expect(g.stalls).toBe(0);
  expect(g.waitUntil).toBeUndefined(); // the stale wait window must not ride the new phase
  expect(g.evidence).toBeUndefined();
  expect(g.evidenceHistory!.length).toBe(1);
  expect(g.evidenceHistory![0].evidence).toBe(EVIDENCE);
  expect(g.reactivation).toMatchObject({ from: "completed" });
  expect(g.nextStep).toMatchObject({ text: "phase-2: verify, then archive", turn: 0 });
  // paused -> reactivated (no evidence to archive — history stays at 1)
  await h.toolExecutor("goal_pause", {}, S);
  expect(await h.toolExecutor("goal_next_step", { text: "from pause" }, S)).toContain("reactivated");
  expect(goalOf(h)!.status).toBe("active");
  expect(goalOf(h)!.reactivation).toMatchObject({ from: "paused" });
  expect(goalOf(h)!.evidenceHistory!.length).toBe(1);
  // blocked -> reactivated, the stale blocker is dropped (same discipline as resume)
  await h.toolExecutor("goal_block", { reason: "vendor silent" }, S);
  expect(await h.toolExecutor("goal_next_step", { text: "from block" }, S)).toContain("reactivated");
  expect(goalOf(h)!.status).toBe("active");
  expect(goalOf(h)!.blocker).toBeUndefined();
  // stalled -> reactivated (a persisted terminal record; the stall ladder
  // itself is covered in judge-integration.test.ts)
  const stalled = goalOf(h)!;
  stalled.status = "stalled";
  stalled.stallReport = "stalling hard (no action tails)";
  h.storage.set(goalStorageKey(S), stalled);
  expect(await h.toolExecutor("goal_next_step", { text: "from stall" }, S)).toContain("reactivated");
  expect(goalOf(h)!.status).toBe("active");
  expect(goalOf(h)!.reactivation).toMatchObject({ from: "stalled" });
  await stop();
});

test("8d: goal_next_step refuses cleared and budget_limited goals — the records stay untouched", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Closed loop");
  h.setMessages(S, [{ id: "m1", type: "user", text: "discard this goal and stop the work" }]);
  expect(await h.toolExecutor("goal_clear", { request: "discard this goal and stop the work" }, S)).toContain("cleared");
  const clearedReply = await h.toolExecutor("goal_next_step", { text: "x" }, S);
  expect(clearedReply).toContain("cleared");
  expect(clearedReply).toContain("goal_set");
  expect(goalOf(h)!.status).toBe("cleared");
  expect(goalOf(h)!.nextStep).toBeUndefined();
  // budget_limited (an explicit cap hit): stays terminal, points to goal_set
  await h.commandExecutor(S, "/goal set Budgeted --tokens 100");
  await h.emit(usage("u1", { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
  await h.emit(started("s1"));
  await h.emit(succeeded("e1")); // budget check precedes attribution -> budget_limited
  expect(goalOf(h)!.status).toBe("budget_limited");
  const budgetReply = await h.toolExecutor("goal_next_step", { text: "y" }, S);
  expect(budgetReply).toContain("budget_limited");
  expect(budgetReply).toContain("goal_set");
  expect(goalOf(h)!.status).toBe("budget_limited");
  expect(goalOf(h)!.nextStep).toBeUndefined();
  await stop();
});

// ---------------------------------------------------------------------------
// 9. goal_wait
// ---------------------------------------------------------------------------

test("9: goal_wait writes waitUntil for 1..60 minutes; bad minutes and a missing goal are refused", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Batch run");
  const before = Date.now();
  const reply = await h.toolExecutor("goal_wait", { minutes: 5 }, S);
  const after = Date.now();
  const w = goalOf(h)!.waitUntil;
  expect(w).toBeDefined();
  expect(w!).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
  expect(w!).toBeLessThanOrEqual(after + 5 * 60_000 + 50);
  expect(reply).toContain("5");
  // rejected waits leave the record untouched
  for (const bad of [0, 61, "abc"]) {
    const r = await h.toolExecutor("goal_wait", { minutes: bad }, S);
    expect(r).toContain("minutes");
  }
  expect(goalOf(h)!.waitUntil).toBe(w);
  // no active goal -> refused
  const { h: h2, stop: stop2 } = await boot();
  expect(await h2.toolExecutor("goal_wait", { minutes: 10 }, S)).toContain("no active goal");
  await stop();
  await stop2();
});

// ---------------------------------------------------------------------------
// 10. permission surface
// ---------------------------------------------------------------------------

test("10: all twelve goal_* tools register with permission goal.control", async () => {
  const { h, stop } = await boot();
  const names = [
    "goal_set",
    "goal_complete",
    "goal_block",
    "goal_clear",
    "goal_history",
    "goal_add_task",
    "goal_update_task",
    "goal_next_step",
    "goal_wait",
    "goal_pause",
    "goal_resume",
    "goal_view",
  ];
  for (const name of names) {
    const tool = h.tools.get(name);
    expect(tool, `tool ${name} registered`).toBeDefined();
    expect(tool!.spec.permission).toBe("goal.control");
    expect(typeof tool!.spec.description).toBe("string");
    expect(tool!.spec.description.length).toBeGreaterThan(10);
  }
  // 2026-10-20 ruling: ALL twelve goal_* tools are natively exposed
  // (codemode:false) and grouped under the `goal` namespace (MCP-server
  // style) — registration names are prefix-free; the host flattens to
  // goal_<name>, so the model-visible names (the map keys above) are unchanged.
  for (const name of names) {
    expect(h.tools.get(name)!.spec.codemode, `${name} must be native`).toBe(false);
    expect(h.tools.get(name)!.spec.namespace, `${name} must sit in the goal namespace`).toBe("goal");
  }
  expect(h.namespaces.get("goal"), "the goal namespace must be declared").toBeDefined();
  await stop();
});

// ---------------------------------------------------------------------------
// 11. defensive parsing (no tool ever throws on bad input)
// ---------------------------------------------------------------------------

test("11: every tool returns a human-readable error string on bad input (never throws)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Parse guard");
  await h.toolExecutor("goal_add_task", { title: "x1" }, S);
  const cases: Array<[string, unknown, RegExp]> = [
    ["goal_set", {}, /objective/],
    ["goal_set", { objective: 42 }, /objective/],
    ["goal_complete", {}, /evidence/],
    ["goal_block", {}, /reason/],
    ["goal_clear", {}, /request/],
    // goal_history takes no fields: garbage input still gets an answer
    ["goal_history", null, /archived/],
    ["goal_add_task", {}, /title/],
    ["goal_update_task", {}, /ref/],
    ["goal_next_step", {}, /text/],
    ["goal_update_task", { ref: "1", status: "bogus" }, /todo\|doing\|done/],
    ["goal_wait", { minutes: "abc" }, /minutes/],
  ];
  for (const [name, input, pattern] of cases) {
    const reply = await h.toolExecutor(name, input, S);
    expect(typeof reply, `${name} must return a string, got ${typeof reply}`).toBe("string");
    expect(reply).toMatch(pattern);
  }
  expect(goalOf(h)!.status).toBe("active"); // bad input must not damage state
  await stop();
});

// ---------------------------------------------------------------------------
// 12. snapshot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 14. Task 14 Fix 1: saveGoal compare-and-set guard (stale write dropped)
// ---------------------------------------------------------------------------

test("14a: saveGoal drops a stale write — a newer /goal clear wins (compare-and-set)", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set CAS guard");
  const recA = await (ctrl as unknown as { loadGoal(sid: string): Promise<GoalRecord | undefined> }).loadGoal(S);
  expect(recA).toBeDefined();
  const baseUpdatedAt = recA!.updatedAt;
  // Backdate the load baseline so the guard's comparison is deterministic
  // (a /goal clear bump landing in the same millisecond would not be
  // strictly newer; the CAS spec compares against the load baseline).
  recA!.updatedAt = baseUpdatedAt - 1000;
  // A legitimate clear (transcript-grounded, 合格流程) writes the newer record
  h.setMessages(S, [{ id: "m1", type: "user", text: "please discard the branch and stop the work" }]);
  await h.commandExecutor(S, "/goal clear");
  const cleared = goalOf(h)!;
  expect(cleared.status).toBe("cleared");
  // Stale write: A's baseline is older than what storage now holds → dropped
  const saved = await (ctrl as unknown as { saveGoal(g: GoalRecord): Promise<boolean> }).saveGoal(recA!);
  expect(saved).toBe(false); // the false (dropped) path was taken
  const stored = goalOf(h)!;
  expect(stored.status).toBe("cleared"); // NOT resurrected by the stale write
  expect(stored.updatedAt).toBe(cleared.updatedAt); // clear's bump, not A's
  expect(recA!.updatedAt).toBe(baseUpdatedAt - 1000); // not bumped on drop
  await stop();
});

test("14c: goal_next_step whose save is dropped by a concurrent write reports the change, not success", async () => {
  // Review finding I1: both nextStepUpdate branches discarded saveGoal's
  // compare-and-set result — a dropped reactivation still answered "the loop
  // resumes". A concurrent writer (e.g. a /goal clear from another surface)
  // landing between load and save must surface as "changed underneath".
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set CAS nextstep");
  // Simulate the concurrent writer: the storage record is rewritten with a
  // newer updatedAt between the tool's own load (first get) and saveGoal's
  // staleness probe (second get).
  const realGet = (h.probe as unknown as { storageGet(key: string): Promise<unknown> }).storageGet.bind(h.probe);
  let gets = 0;
  (h.probe as unknown as Record<string, unknown>).storageGet = async (key: string) => {
    gets += 1;
    if (gets === 2 && key === goalStorageKey(S)) {
      const cur = h.storage.get(key) as GoalRecord;
      cur.status = "cleared";
      cur.updatedAt = Date.now() + 1000;
      h.storage.set(key, cur);
    }
    return realGet(key);
  };
  const out = await h.toolExecutor("goal_next_step", { text: "stale write probe" }, S);
  expect(out).toContain("changed underneath");
  const stored = goalOf(h)!;
  expect(stored.status).toBe("cleared"); // the dropped write did not resurrect/reactivate
  expect(stored.nextStep).toBeUndefined();
  await stop();
});

test("14f: goal_block whose storage write fails reports the change, not success (fail-closed)", async () => {
  // 129 incident class (2026-10-20): a block that never reached storage was
  // later read back as ACTIVE — the write failure had been reported as
  // success. A terminal transition whose storageSet throws must surface as
  // "changed underneath" and never claim the transition landed.
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set FailClosed block");
  const before = goalOf(h)!;
  (h.probe as unknown as Record<string, unknown>).storageSet = async () => {
    throw new Error("kv write failed (scripted)");
  };
  const reply = await h.toolExecutor("goal_block", { reason: "kv down" }, S);
  expect(reply).toContain("changed underneath");
  expect(reply).not.toContain("blocked:"); // never claims success
  const stored = goalOf(h)!;
  expect(stored.status).toBe("active"); // the failed write did not land
  expect(stored.updatedAt).toBe(before.updatedAt); // storage untouched
  await stop();
});

test("14b: finishGoal on a stale record returns false and writes no archive copy", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set CAS finish");
  const recA = await (ctrl as unknown as { loadGoal(sid: string): Promise<GoalRecord | undefined> }).loadGoal(S);
  const baseUpdatedAt = recA!.updatedAt;
  recA!.updatedAt = baseUpdatedAt - 1000; // deterministic staleness (see 14a)
  // /goal pause writes the newer record (no transcript needed)
  await h.commandExecutor(S, "/goal pause");
  expect(goalOf(h)!.status).toBe("paused");
  const finish = await (ctrl as unknown as {
    finishGoal(g: GoalRecord, s: import("../src/state.ts").GoalStatus, p?: unknown): Promise<boolean>;
  }).finishGoal(recA!, "completed", { evidence: EVIDENCE });
  expect(finish).toBe(false);
  const stored = goalOf(h)!;
  expect(stored.status).toBe("paused"); // NOT resurrected to completed
  expect(h.storage.get(archivedGoalKey(S, stored.id))).toBeUndefined(); // no archive copy
  expect(recA!.updatedAt).toBe(baseUpdatedAt - 1000); // not bumped on drop
  await stop();
});

test("14c: /goal complete whose save lands on a newer record refuses (no success claim)", async () => {
  const { h, ctrl, stop } = await boot();
  await h.commandExecutor(S, "/goal set CAS command");
  h.setMessages(S, [EVIDENCE_MESSAGE]);
  // Concurrent actor: while the command's load→save window is open (during
  // the transcript read), a newer write lands on the same storage key.
  const origContext = h.probe.context;
  (h.probe as unknown as { context: (sid: string) => Promise<unknown> }).context = async (sid: string) => {
    const msgs = await origContext(sid);
    const fresh = await (ctrl as unknown as { loadGoal(sid: string): Promise<GoalRecord | undefined> }).loadGoal(sid);
    await (ctrl as unknown as { saveGoal(g: GoalRecord): Promise<boolean> }).saveGoal(fresh!); // bump
    return msgs;
  };
  await sleep(20); // guarantee the concurrent bump is strictly newer than /goal set's
  await h.commandExecutor(S, `/goal complete ${EVIDENCE}`);
  const reply = lastSynthetic(h).text;
  expect(reply).toContain("changed"); // "changed underneath" semantics
  expect(reply).not.toContain("completed:"); // never claims success
  const stored = goalOf(h)!;
  expect(stored.status).toBe("active"); // the stale terminal write did not land
  expect(stored.evidence).toBeUndefined();
  await stop();
});

test("12: snapshot deep-copies the record; undefined for a session without a goal", async () => {
  const { h, ctrl, stop } = await boot();
  expect(await ctrl.snapshot("s9")).toBeUndefined();
  await h.commandExecutor(S, "/goal set Snapshot me");
  await h.toolExecutor("goal_add_task", { title: "t1" }, S);
  const snap = await ctrl.snapshot(S);
  expect(snap).toBeDefined();
  expect(snap!.objective).toBe("Snapshot me");
  snap!.objective = "MUTATED";
  snap!.tasks.push({ id: "t9", title: "injected", status: "todo", createdAt: 0, updatedAt: 0 });
  expect(goalOf(h)!.objective).toBe("Snapshot me");
  expect(goalOf(h)!.tasks.length).toBe(1);
  await stop();
});

// P0-1 (2026-10-16 A/B): the reference plugin's goal_set description carries
// an explicit "user asked" constraint; ours did not — live A/B showed the
// model spontaneously calling goal_set on a plain task (reference: 0).
test("13: goal_set description constrains spontaneous use (explicit-ask gate)", async () => {
  const { h, stop } = await boot();
  const spec = h.tools.get("goal_set");
  expect(spec).toBeDefined();
  expect(spec!.spec.description).toMatch(/explicitly asks you to set a goal/i);
  await stop();
});

test("15: command-menu descriptions — /goal points to the usage table; every subcommand has its own one-line argument-help command", async () => {
  // 2026-10-17 user ruling: the host clamps every /-menu description to a
  // single row (2.0.32 web UI ellipsis, verified live), so per-subcommand
  // argument help lives on fine-grained commands (goal-set, goal-view, ...) —
  // one menu row each; /goal points at the bare-`/goal` usage table.
  const { h, stop } = await boot();
  const desc = h.commandDescriptions.get("goal");
  expect(desc).toBeDefined();
  expect(desc).not.toContain("\n");
  expect(desc).toContain("bare /goal");
  for (const [name, token] of [
    ["goal-set", "<objective>"],
    ["goal-set", "[--turns|--tokens N]"],
    ["goal-set", "[--unbounded]"],
    ["goal-view", "show the current goal"],
    ["goal-pause", "pause the active goal"],
    ["goal-resume", "resume the paused goal"],
    ["goal-complete", "<evidence>"],
    ["goal-block", "<reason>"],
    ["goal-clear", "discard the goal"],
  ] as const) {
    const d = h.commandDescriptions.get(name);
    expect(d, `${name} description`).toBeDefined();
    expect(d!).not.toContain("\n");
    expect(d!).toContain(token);
  }

  // routing: /goal-set reaches the same set path as /goal set (host strips
  // the command name and passes the remainder)
  await h.commandExecutor(S, "/goal-set Fine grained --turns 2");
  const g = goalOf(h);
  expect(g!.objective).toBe("Fine grained");
  expect(g!.cap).toEqual({ turns: 2 });
  await h.commandExecutor(S, "/goal view");
  expect(lastSynthetic(h).text).toContain("Fine grained");

  // the full usage (all subcommands) is still served by the bare /goal help
  // output, delivered as a goalControl synthetic (multi-line session message)
  await h.commandExecutor(S, "/goal");
  const helpText = lastSynthetic(h).text;
  for (const sub of ["set", "view", "pause", "resume", "complete", "block", "clear", "task", "history"]) {
    expect(helpText).toContain(sub);
  }
  expect(helpText).toContain("\n"); // multi-line help block
  await stop();
});
