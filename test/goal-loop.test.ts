// Task 7: goal-loop controller — lifecycle + commands + tools, driven
// through the REAL GoalController.start() against the deterministic harness
// (test/harness.ts). The 12 behavior groups are the Task 7 brief contract.
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { archivedGoalKey, goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

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

function lastSynthetic(h: Harness): { text: string; metadata?: Record<string, unknown> } {
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
  expect(g!.cap).toEqual({ turns: 10 }); // 2026-10-16: tokens are statistics only, no default cap
  // every synthetic carries the goalControl marker (Task 8 arbiter dependency)
  expect(h.synthetics.every((c) => c.input.metadata?.goalControl === true)).toBe(true);
  expect(lastSynthetic(h).text).toContain("Ship it");

  await h.commandExecutor(S, "/goal view");
  const view = lastSynthetic(h).text;
  expect(view).toContain("Ship it");
  expect(view).toContain("10 turns / unbounded tokens");

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
  // R7 (spec §9): the old goal is EXACTLY as it was — same record including
  // updatedAt, same status, nothing written under archivedGoalKey.
  const after = goalOf(h)!;
  expect(after).toEqual(beforeRaw);
  expect(after.id).toBe(before.id);
  expect(after.status).toBe(before.status); // unchanged (still active)
  expect(after.objective).toBe("Old objective");
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
// 6. task commands + the 50-task limit
// ---------------------------------------------------------------------------

test("6: /goal task add + status update; the 51st add is rejected with the 50 limit", async () => {
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
  expect(lastSynthetic(h).text).toContain("50");
  expect(goalOf(h)!.tasks.length).toBe(50);
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
// 8. tool/command equivalence (one example each)
// ---------------------------------------------------------------------------

test("8: goal_set / goal_add_task / goal_update_task are command-equivalent", async () => {
  const { h, stop } = await boot();
  const reply = await h.toolExecutor("goal_set", { objective: "Build it" }, S);
  expect(reply).toContain("created");
  expect(goalOf(h)!.objective).toBe("Build it");
  expect(goalOf(h)!.cap).toEqual({ turns: 10 }); // same default cap as the command (turns-only; tokens = statistics)
  expect(await h.toolExecutor("goal_add_task", { title: "a1" }, S)).toContain("a1");
  expect(goalOf(h)!.tasks[0]).toMatchObject({ title: "a1", status: "todo" });
  expect(await h.toolExecutor("goal_update_task", { ref: "1", status: "done" }, S)).toContain("done");
  expect(goalOf(h)!.tasks[0].status).toBe("done");
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

test("10: all eight goal_* tools register with permission goal.control", async () => {
  const { h, stop } = await boot();
  const names = [
    "goal_set",
    "goal_complete",
    "goal_block",
    "goal_clear",
    "goal_history",
    "goal_add_task",
    "goal_update_task",
    "goal_wait",
  ];
  for (const name of names) {
    const tool = h.tools.get(name);
    expect(tool, `tool ${name} registered`).toBeDefined();
    expect(tool!.spec.permission).toBe("goal.control");
    expect(typeof tool!.spec.description).toBe("string");
    expect(tool!.spec.description.length).toBeGreaterThan(10);
  }
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
