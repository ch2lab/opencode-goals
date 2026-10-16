// Task 11: compaction-proof goal state — the two session hooks
// (spec §10 defense lines 2 + 3), driven through the REAL
// GoalController.start() against the deterministic harness (test/harness.ts).
//
// - context hook: before every model call, an ACTIVE goal appends its
//   objective block as a system part; non-active (incl. paused) or no goal →
//   no-op.
// - compaction hook: the host's SessionCompaction.result is a WHOLE
//   REPLACEMENT (session.d.ts: "Set to use this compaction and skip the
//   model request") — so the summary must carry the conversation history
//   (via probe.generate) PLUS the mandatory trailing [GOAL STATE] block.
//   generate failure / context failure / no active goal → fail-safe no-op
//   (host default compaction runs; payload.result stays unset; the hook
//   never throws).
//
// The 6 behaviors are the Task 11 brief contract. The hook callbacks are
// pulled from h.sessionHooks — an unregistered hook fails the test (bug).
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

async function boot(): Promise<{ h: Harness; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions({}), {});
  const stop = await ctrl.start();
  return { h, stop };
}

function goalOf(h: Harness, sessionID = S): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(sessionID)) as GoalRecord | undefined;
}

type HookFn = (sessionID: string, payload: Record<string, unknown>) => void;

function contextHook(h: Harness): HookFn {
  const hook = h.sessionHooks.context[0];
  expect(hook, "context session hook must be registered in start()").toBeDefined();
  return hook!;
}

function compactionHook(h: Harness): HookFn {
  const hook = h.sessionHooks.compaction[0];
  expect(hook, "compaction session hook must be registered in start()").toBeDefined();
  return hook!;
}

// ---------------------------------------------------------------------------
// 1. context hook positive: active goal → system part appended
// ---------------------------------------------------------------------------

test("1: context hook appends the objective block for an active goal (SystemPart shape, [GOAL + id, verbatim objective, turns usage)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ship compaction-proof state");
  const g = goalOf(h)!;
  const hook = contextHook(h);
  const payload: Record<string, unknown> = { system: [] };
  await hook(S, payload);
  const system = payload.system as Array<{ type?: string; text: string }>;
  expect(system).toHaveLength(1);
  // SystemPart shape pinned from @opencode/ai (schema/messages.d.ts):
  // { type: "text", text: string, cache?, metadata? }
  expect(system[0].type).toBe("text");
  const text = system[0].text;
  expect(text).toContain("[GOAL");
  expect(text).toContain(g.id);
  expect(text).toContain("Ship compaction-proof state");
  // objectiveBlock contract: turns usage `used/cap`
  expect(text).toContain(`${g.used.turns}/${g.cap.turns}`);
  await stop();
});

// ---------------------------------------------------------------------------
// 2. context hook no-op: no goal / paused goal
// ---------------------------------------------------------------------------

test("2: context hook is a no-op without a goal and while paused (system stays empty)", async () => {
  const { h, stop } = await boot();
  const hook = contextHook(h);

  const noGoal: Record<string, unknown> = { system: [] };
  await hook(S, noGoal);
  expect(noGoal.system).toHaveLength(0);

  await h.commandExecutor(S, "/goal set Pause me");
  await h.commandExecutor(S, "/goal pause");
  expect(goalOf(h)!.status).toBe("paused");
  const paused: Record<string, unknown> = { system: [] };
  await hook(S, paused);
  expect(paused.system).toHaveLength(0);
  await stop();
});

test("2b: context hook is idempotent on a reused system array (host retry → no double append)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Retry me");
  const hook = contextHook(h);
  const payload: Record<string, unknown> = { system: [] };
  await hook(S, payload);
  expect(payload.system).toHaveLength(1);
  // Host retry: the SAME payload object is re-fired.
  await hook(S, payload);
  expect(payload.system).toHaveLength(1);
  await stop();
});

// ---------------------------------------------------------------------------
// 3. compaction hook positive: result.summary = generated text + trailing
//    [GOAL STATE]; generate prompt carries the conversation history
// ---------------------------------------------------------------------------

test("3: compaction hook sets result.summary with the generated text, verbatim objective, per-task status lines, and [GOAL STATE] last; the generate prompt embeds the history", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Alpha objective");
  await h.toolExecutor("goal_add_task", { title: "first step" }, S);
  await h.toolExecutor("goal_add_task", { title: "second step" }, S);
  const g = goalOf(h)!;
  h.setMessages(S, [
    { id: "m1", type: "user", text: "kickoff: the alpha-bravo token was discussed" },
    { id: "m2", type: "assistant", content: [{ text: "working on the alpha-bravo item now" }] },
  ]);
  h.setGenerate("SUMMARY-TEXT");
  const hook = compactionHook(h);
  const payload: Record<string, unknown> = {};
  await hook(S, payload);

  const result = payload.result as { summary: string } | undefined;
  expect(result, "payload.result must be set for an active goal").toBeDefined();
  const summary = result!.summary;
  expect(summary).toContain("SUMMARY-TEXT");
  expect(summary).toContain("Alpha objective");
  expect(summary).toContain("1. [todo] first step");
  expect(summary).toContain("2. [todo] second step");
  // [GOAL STATE] is a MANDATORY trailing section: it exists even if the
  // generated text is empty/malformed, and it comes after the generated text.
  expect(summary.lastIndexOf("[GOAL STATE]")).toBeGreaterThan(summary.indexOf("SUMMARY-TEXT"));
  expect(summary).toContain(`${g.used.turns}/${g.cap.turns}`);

  // The generate request carried the conversation history AND the state block.
  expect(h.generated).toHaveLength(1);
  expect(h.generated[0].prompt).toContain("alpha-bravo");
  expect(h.generated[0].prompt).toContain("Alpha objective");
  expect(h.generated[0].prompt).toContain("first step");
  await stop();
});

// ---------------------------------------------------------------------------
// 4. generate failure → fail-safe: no result, hook never throws
// ---------------------------------------------------------------------------

test("4: generate failure is fail-safe — result stays unset, hook does not throw", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Fail goal");
  h.setMessages(S, [{ id: "m1", type: "user", text: "some history" }]);
  h.setGenerate(() => {
    throw new Error("boom");
  });
  const hook = compactionHook(h);
  const payload: Record<string, unknown> = {};
  await expect(hook(S, payload)).resolves.toBeUndefined();
  expect(payload.result).toBeUndefined();
  expect("result" in payload).toBe(false);
  await stop();
});

test("4b: context fetch failure is fail-safe — no result, generate never called, hook never throws", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ctx fail goal");
  const orig = h.probe.context;
  h.probe.context = () => Promise.reject(new Error("ctx boom"));
  h.setGenerate("SHOULD-NOT-BE-USED");
  try {
    const hook = compactionHook(h);
    const payload: Record<string, unknown> = {};
    await hook(S, payload);
    expect(payload.result).toBeUndefined();
    expect("result" in payload).toBe(false);
    expect(h.generated).toHaveLength(0); // no summary request without history
  } finally {
    h.probe.context = orig;
  }
  await stop();
});

test("4c: empty/whitespace-only generated text is fail-safe — no state-only summary (which would lose the conversation)", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Empty gen goal");
  h.setMessages(S, [{ id: "m1", type: "user", text: "some history" }]);
  h.setGenerate("   \n  ");
  const hook = compactionHook(h);
  const payload: Record<string, unknown> = {};
  await expect(hook(S, payload)).resolves.toBeUndefined();
  expect(payload.result).toBeUndefined();
  expect("result" in payload).toBe(false);
  expect(h.generated).toHaveLength(1); // generate WAS called; its empty output is what fails
  await stop();
});

// ---------------------------------------------------------------------------
// 5. no goal → no-op: no result, no generate
// ---------------------------------------------------------------------------

test("5: compaction hook is a no-op without an active goal — no result, no generate", async () => {
  const { h, stop } = await boot();
  const hook = compactionHook(h);
  const payload: Record<string, unknown> = {};
  await hook(S, payload);
  expect(payload.result).toBeUndefined();
  expect("result" in payload).toBe(false);
  expect(h.generated).toHaveLength(0);
  await stop();
});

// ---------------------------------------------------------------------------
// 6. integration: a full compaction round-trip is lossless for the state
// ---------------------------------------------------------------------------

test("6: full compaction round-trip keeps objective, task statuses, and turns usage intact", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Lossless compaction");
  await h.toolExecutor("goal_add_task", { title: "write the report" }, S);
  await h.toolExecutor("goal_add_task", { title: "ship it" }, S);
  await h.toolExecutor("goal_update_task", { ref: 1, status: "done" }, S);
  const g = goalOf(h)!;
  expect(g.status).toBe("active");
  expect(g.tasks.map((t) => t.status)).toEqual(["done", "todo"]);
  h.setMessages(S, [
    { id: "m1", type: "user", text: "work on the lossless compaction objective now" },
    { id: "m2", type: "assistant", content: [{ text: "report part is done" }] },
  ]);
  h.setGenerate("compact body text");
  const hook = compactionHook(h);
  const payload: Record<string, unknown> = {};
  await hook(S, payload);
  const summary = (payload.result as { summary: string }).summary;
  expect(summary).toContain("Lossless compaction");
  expect(summary).toContain("1. [done] write the report");
  expect(summary).toContain("2. [todo] ship it");
  expect(summary).toContain(`Turns used: ${g.used.turns}/${g.cap.turns}`);
  expect(summary).toContain("compact body text");
  await stop();
});

// ---------------------------------------------------------------------------
// 7. paused goal → compaction no-op (no active goal = no takeover)
// ---------------------------------------------------------------------------

test("7: paused goal is a compaction no-op — no result, no generate", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Pause compaction");
  await h.commandExecutor(S, "/goal pause");
  expect(goalOf(h)!.status).toBe("paused");
  h.setMessages(S, [{ id: "m1", type: "user", text: "some history" }]);
  h.setGenerate("SHOULD-NOT-BE-USED");
  const hook = compactionHook(h);
  const payload: Record<string, unknown> = {};
  await hook(S, payload);
  expect(payload.result).toBeUndefined();
  expect("result" in payload).toBe(false);
  expect(h.generated).toHaveLength(0);
  await stop();
});

// ---------------------------------------------------------------------------
// 8. malformed context payload (non-array system) → never throws, untouched
// ---------------------------------------------------------------------------

test("8: context hook with a malformed payload never throws and leaves it untouched", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set Malformed payload");
  const hook = contextHook(h);
  const payload: Record<string, unknown> = { system: "nope" };
  await expect(hook(S, payload)).resolves.toBeUndefined();
  expect(payload.system).toBe("nope");
  await stop();
});
