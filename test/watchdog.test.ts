// Task 10: watchdog + restart reconciliation (spec §7.1), driven through the
// REAL GoalController.start() against the deterministic harness (test/harness.ts)
// + a scripted fake ShellProbe (tests mutate what list() returns).
//
// Controller ruling (rulings.md): REAL timers with small option values
// (watchdogTickMs 1ms via deps.tickMs=1, shellStallMs 50ms, waitCheckInMs 100ms)
// + STATE polling via waitFor(pred, 2000ms) — never exact wall-clock moments.
//
// Event payload assumptions pinned here (brief ruling: code the current
// assumption + TODO(task13) where genuinely open):
//  - the watchdog consumes the DURABLE, session-scoped shell family
//    `session.shell.started` / `session.shell.ended`
//    (schema/dist/session-event.d.ts Shell.Started/Ended): data = { shell:
//    ShellInfo, sessionID } and data = { shell: ShellInfo, output: { output,
//    cursor, size, truncated }, sessionID }. That is the only mechanically
//    attributable family: the EPHEMERAL `shell.created` / `shell.exited`
//    (schema/dist/shell.d.ts) carry data = { info } / { id, exit?, status }
//    with NO sessionID, so they never pass the controller's session gate in
//    2.0.29 (still handled by the controller, dead path until a host adds
//    attribution — TODO(task13) live-smoke decides which family to trust).
//  - ShellInfo.status ∈ "running" | "exited" | "timeout" | "killed"
//    (shell.d.ts Shell.Status — there is NO "completed" value; "exited" is
//    the plain exit).
//  - restart notice = a context message whose metadata carries
//    notice === "restart" (the host restart.ts synthetic, spec §7.1 step 2 —
//    field assumption, TODO(task13)).
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { createGoal, goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController, SHELL_LIST_RPC_METHOD, type ShellProbe } from "../src/controller.ts";
import type { HostEvent } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

const OPTS = resolveOptions({ watchdogTickMs: 1, shellStallMs: 50, waitCheckInMs: 100 });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ProbeShell = { id: string; state: "running" | "exited"; exitCode?: number; outputTail?: string };

/** Scripted fake ShellProbe: tests mutate what list() returns; calls counted. */
function makeFakeProbe(initial: ProbeShell[] = []) {
  const box: { shells: ProbeShell[]; calls: number } = { shells: initial, calls: 0 };
  const probe: ShellProbe = {
    list: async () => {
      box.calls += 1;
      return structuredClone(box.shells);
    },
  };
  return {
    probe,
    calls: () => box.calls,
    set: (shells: ProbeShell[]) => {
      box.shells = shells;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a STATE (never a wall-clock moment) with a generous timeout. */
async function waitFor(cond: () => boolean, timeoutMs = 2000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${label}`);
}

interface Boot {
  h: Harness;
  fake: ReturnType<typeof makeFakeProbe>;
  stop: () => Promise<void>;
}

async function boot(): Promise<Boot> {
  const h = await createHarness();
  const fake = makeFakeProbe();
  const ctrl = new GoalController(h.probe, OPTS, { shellProbe: fake.probe, tickMs: 1 });
  const stop = await ctrl.start();
  return { h, fake, stop };
}

/** Same as boot, but with explicit controller deps (e.g. no shellProbe / throwing probe). */
async function bootWith(deps: { shellProbe?: ShellProbe; tickMs?: number }): Promise<{ h: Harness; stop: () => Promise<void> }> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, OPTS, deps);
  const stop = await ctrl.start();
  return { h, stop };
}

function goalOf(h: Harness, sessionID = S): GoalRecord | undefined {
  return h.storage.get(goalStorageKey(sessionID)) as GoalRecord | undefined;
}

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}

// schema/dist/session-event.d.ts (Shell.Started): data = { shell, sessionID }.
function shellStarted(id: string, shell: { id: string; command: string; cwd: string }, sessionID = S): HostEvent {
  return ev("session.shell.started", id, {
    sessionID,
    shell: {
      id: shell.id,
      status: "running",
      command: shell.command,
      cwd: shell.cwd,
      shell: "bash",
      file: "script.sh",
      metadata: {},
      time: { started: Date.now() },
    },
  });
}

// schema/dist/session-event.d.ts (Shell.Ended): data = { shell, output, sessionID }.
function shellEnded(
  id: string,
  shellID: string,
  status: "exited" | "timeout" | "killed",
  sessionID = S,
): HostEvent {
  return ev("session.shell.ended", id, {
    sessionID,
    shell: {
      id: shellID,
      status,
      command: "cmdA",
      cwd: "/w",
      shell: "bash",
      file: "script.sh",
      metadata: {},
      time: { started: Date.now() - 1000, completed: Date.now() },
    },
    output: { output: "last output line", cursor: 15, size: 15, truncated: false },
  });
}

function started(id: string, sessionID = S): HostEvent {
  return ev("session.execution.started", id, { sessionID });
}

function succeeded(id: string, sessionID = S): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID });
}

function toolCalled(id: string, sessionID = S): HostEvent {
  return ev("session.tool.called", id, {
    input: {},
    executed: true,
    assistantMessageID: "am1",
    id: "tc1",
    sessionID,
  });
}

/** Check-in wakes: goalControl synthetics-style wakes tagged by the marker line. */
function checkIns(h: Harness): string[] {
  return h.prompts
    .filter((p) => typeof p.input.text === "string" && p.input.text.includes("SHELL CHECK-IN"))
    .map((p) => p.input.text);
}

// ---------------------------------------------------------------------------
// 1. timeout awareness (create.before → shell.created correlation)
// ---------------------------------------------------------------------------

test("1: timeout awareness — recorded timeout raises the zero-growth threshold to T+tick; no-timeout / mismatched shells use shellStallMs", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Timeouts");
  // Host hands { command, cwd, timeout } to the create.before hook before spawn.
  h.shellCreateBefore[0]({ command: "cmdA", cwd: "/w", timeout: 150 });
  fake.set([
    { id: "shA", state: "running", outputTail: "a1" },
    { id: "shB", state: "running", outputTail: "b1" },
    { id: "shC", state: "running", outputTail: "c1" },
  ]);
  await h.emit(shellStarted("e1", { id: "shA", command: "cmdA", cwd: "/w" }));
  // correlation fails (cwd mismatch, command mismatch) → treated as NO timeout
  await h.emit(shellStarted("e2", { id: "shB", command: "cmdA", cwd: "/other" }));
  await h.emit(shellStarted("e3", { id: "shC", command: "cmdX", cwd: "/w" }));
  const g = goalOf(h)!;
  expect(g.waitingShells?.find((w) => w.id === "shA")?.timeoutMs).toBe(150);
  expect(g.waitingShells?.find((w) => w.id === "shB")?.timeoutMs).toBeUndefined();
  expect(g.waitingShells?.find((w) => w.id === "shC")?.timeoutMs).toBeUndefined();

  // tails constant (zero growth). shA's threshold = max(shellStallMs=50, 150+1) = 151ms;
  // shB/shC use the 50ms baseline. At 120ms shA must NOT have checked in yet.
  await sleep(120);
  expect(checkIns(h).some((t) => t.includes("shA"))).toBe(false);
  expect(checkIns(h).some((t) => t.includes("shB"))).toBe(true); // 50ms baseline fired
  await waitFor(
    () => checkIns(h).some((t) => t.includes("shA")),
    2000,
    "shA check-in past the 150+tick timeout threshold",
  );
  expect(checkIns(h).some((t) => t.includes("shC"))).toBe(true);
  await stop();
});

// ---------------------------------------------------------------------------
// 2. fast path (boundary while waiting; exited wording timeout/killed)
// ---------------------------------------------------------------------------

test("2: fast path — boundary with waitingShells does not wake; shell.exited wakes, wording distinguishes timeout / killed", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Fast");
  // timeout 0 = no timeout: create.before records nothing
  h.shellCreateBefore[0]({ command: "cmdA", cwd: "/w", timeout: 0 });
  fake.set([{ id: "sh1", state: "running", outputTail: "x" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // boundary while waiting → no wake
  expect(h.prompts.length).toBe(0);
  expect(goalOf(h)!.lastHandledEventID).toBe("b1");

  await h.emit(shellEnded("x1", "sh1", "timeout"));
  expect(h.prompts.length).toBe(1);
  const t = h.prompts[0].input.text;
  expect(t).toContain("timed out");
  expect(t).toContain("timeout");
  expect(t).not.toContain("killed");
  expect(t).toContain("last output line"); // output tail carried
  expect(h.prompts[0].input.metadata?.goalControl).toBe(true);
  expect(h.prompts[0].input.delivery).toBe("queue");
  expect((goalOf(h)!.waitingShells ?? []).length).toBe(0);

  // second shell: killed
  fake.set([{ id: "sh2", state: "running", outputTail: "y" }]);
  await h.emit(shellStarted("e2", { id: "sh2", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b2"));
  expect(h.prompts.length).toBe(1); // boundary still no-wake
  await h.emit(shellEnded("x2", "sh2", "killed"));
  expect(h.prompts.length).toBe(2);
  const k = h.prompts[1].input.text;
  expect(k).toContain("killed");
  expect(k).toContain("killed");
  expect(k).not.toContain("timeout");
  expect(k).not.toContain("timeout");
  await stop();
});

// ---------------------------------------------------------------------------
// 3. lost exit event self-heal (probe reports exited, no event)
// ---------------------------------------------------------------------------

test("3: event-lost self-heal — probe shows exited without an exited event → tick synthesizes the exit wake, waitingShells cleared", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Heal");
  fake.set([{ id: "sh1", state: "running", outputTail: "t1" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // idle boundary (fast path)
  // flip the probe to exited before the 50ms zero-growth window
  await sleep(10);
  fake.set([{ id: "sh1", state: "exited", exitCode: 2, outputTail: "final line" }]);
  await waitFor(() => h.prompts.length > 0, 2000, "synthetic exit wake");
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toContain("exit");
  expect(h.prompts[0].input.text).toContain("final line");
  expect(h.prompts[0].input.metadata?.goalControl).toBe(true);
  expect((goalOf(h)!.waitingShells ?? []).length).toBe(0);
  const callsAtWake = fake.calls();
  await sleep(100);
  expect(h.prompts.length).toBe(1); // no ghost check-in after the result wake
  expect(fake.calls()).toBe(callsAtWake); // disarmed: no more probe.list
  await stop();
});

// ---------------------------------------------------------------------------
// 4. check-in dual signal (stall / long-wait / within-window / active / once per segment)
// ---------------------------------------------------------------------------

test("4a: check-in dual signal — zero growth → likely stalled; at most once per segment; tool action restarts the countdown", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Stall4");
  fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]); // zero growth
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // idle boundary (first create idle state)
  await sleep(30); // < 50ms zero-growth threshold
  expect(h.prompts.length).toBe(0);
  await waitFor(() => h.prompts.length === 1, 2000, "zero-growth check-in");
  expect(checkIns(h)[0]).toContain("likely stalled");
  expect(checkIns(h)[0]).toContain("fixed"); // output tail carried
  expect(h.prompts[0].input.metadata?.goalControl).toBe(true);
  // at most ONE check-in per stall segment: wait far past the threshold, no second
  await sleep(200);
  expect(h.prompts.length).toBe(1);
  // model acts (tool.called boundary) → segment ends → fresh countdown → second allowed
  await h.emit(started("s1"));
  await h.emit(toolCalled("t1"));
  await h.emit(succeeded("b2")); // back to idle
  await waitFor(() => h.prompts.length === 2, 2000, "boundary wake after tool action");
  await waitFor(() => h.prompts.length === 3, 3000, "fresh-segment check-in");
  expect(checkIns(h).length).toBe(2);
  expect(checkIns(h)[1]).toContain("likely stalled");
  await stop();
});

test("4b: check-in dual signal — growth but long wait → a long wait needs progress confirmation; growth within waitCheckInMs → no inject", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Grow4");
  let n = 0;
  const grow = (): void => {
    n += 1;
    fake.set([{ id: "sh1", state: "running", outputTail: `line ${n}` }]);
  };
  grow();
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // idle boundary
  // tail keeps growing (mutated faster than any threshold) → zero-growth never arms;
  // the long-wait branch waits for waitCheckInMs = 100ms
  const mutator = setInterval(grow, 5);
  try {
    await sleep(60); // has growth but < waitCheckInMs → still no inject
    expect(h.prompts.length).toBe(0);
    await waitFor(() => h.prompts.length === 1, 3000, "long-wait check-in");
    expect(checkIns(h)[0]).toContain("a long wait needs progress confirmation");
    expect(checkIns(h)[0]).not.toContain("likely stalled");
    expect(checkIns(h)[0]).toMatch(/line \d+/); // output tail carried (snapshot at inject)
  } finally {
    clearInterval(mutator); // never leak the interval on a failing run
    await stop();
  }
});

test("4c: check-in — active session: conditions met but no inject; back to idle and overdue → inject", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Active4");
  fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(started("s1")); // session active → watchdog stopped, no inject
  await sleep(150); // zero-growth condition (50ms) would have been met
  expect(h.prompts.length).toBe(0);
  await h.emit(succeeded("b1")); // back to idle → re-arm → overdue → inject
  await waitFor(() => h.prompts.length === 1, 2000, "post-idle check-in");
  expect(checkIns(h)[0]).toContain("likely stalled");
  await stop();
});

// ---------------------------------------------------------------------------
// 5. goal_wait silence (waitUntil) + pure-text reply stalls
// ---------------------------------------------------------------------------

test("5a: goal_wait silence — waitUntil suppresses check-ins and stalls; after expiry (rewound in storage) the next deadline injects", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Wait5");
  fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // idle
  await waitFor(() => h.prompts.length === 1, 2000, "first check-in");
  // model replies with the goal_wait(1) tool → waitUntil written
  const reply = await h.toolExecutor("goal_wait", { minutes: 1 }, S);
  expect(reply).toContain("will not be woken");
  expect(goalOf(h)!.waitUntil).toBeGreaterThan(Date.now());
  await h.emit(started("s1"));
  await h.emit(toolCalled("t1")); // goal_wait IS a tool action → segment resets
  await h.emit(succeeded("b2")); // boundary inside the waitUntil window → record only
  expect(goalOf(h)!.stalls).toBe(0);
  await sleep(150); // check-in deadlines pass, waitUntil silences: no inject, no stall
  expect(h.prompts.length).toBe(1);
  expect(goalOf(h)!.stalls).toBe(0);
  // rewind waitUntil into the past in storage (controller ruling: don't wait 60min)
  const g = goalOf(h)!;
  g.waitUntil = Date.now() - 1000;
  await h.probe.storageSet(goalStorageKey(S), g);
  await waitFor(() => h.prompts.length === 2, 2000, "post-expiry check-in");
  expect(checkIns(h).length).toBe(2);
  await stop();
});

test("5b: check-in replied with pure text (no tool) → stall counts normally at the boundary", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Text5");
  fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // idle
  await waitFor(() => h.prompts.length === 1, 2000, "check-in");
  expect(goalOf(h)!.stalls).toBe(0);
  // model replies with plain text: turn starts and ends, no tool.called
  await h.emit(started("s1"));
  await h.emit(succeeded("b2"));
  expect(goalOf(h)!.stalls).toBe(1); // stall counts normally
  expect(h.prompts.length).toBe(2); // the boundary carries its normal wake
  await stop();
});

// ---------------------------------------------------------------------------
// 6. ghosts (no check-in after exit / after terminal; tick stops before probe)
// ---------------------------------------------------------------------------

test("6: ghosts — exit wake then no second check-in; terminal goal stops the armed tick before probe.list", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Ghost");
  fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1"));
  await waitFor(() => h.prompts.length === 1, 2000, "check-in");
  await h.emit(shellEnded("x1", "sh1", "exited"));
  expect(h.prompts.length).toBe(2); // result wake (fast path)
  expect(h.prompts[1].input.text).toContain("exit");
  const callsAtExit = fake.calls();
  await sleep(200); // well past the check-in window
  expect(h.prompts.length).toBe(2); // NO second check-in (ghost assertion)
  expect(fake.calls()).toBe(callsAtExit); // disarmed: no probe.list
  await stop();

  const b2 = await boot();
  await b2.h.commandExecutor(S, "/goal set Term6");
  b2.fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]);
  await b2.h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await b2.h.emit(succeeded("b1"));
  await sleep(30); // armed → tick is probing
  const activeCalls = b2.fake.calls();
  expect(activeCalls).toBeGreaterThan(0);
  const reply = await b2.h.toolExecutor("goal_block", { reason: "external dependency down" }, S);
  expect(reply).toContain("blocked");
  await sleep(150); // an armed tick fires after terminal: no injection, no probe.list
  expect(b2.fake.calls()).toBe(activeCalls);
  expect(b2.h.prompts.length).toBe(0);
  await b2.stop();
});

// ---------------------------------------------------------------------------
// 7. reconciliation — host already took over (restart notice)
// ---------------------------------------------------------------------------

test("7: reconcile — restart notice in context → no new wake, watchdog re-armed and re-verified via probe.list", async () => {
  const h = await createHarness();
  const fake = makeFakeProbe([{ id: "sh1", state: "running", outputTail: "r1" }]);
  // pre-seed storage: an active goal that was waiting on a shell (restart anchor)
  const g = createGoal({ sessionID: S, objective: "Recon7" });
  g.waitingShells = [{ id: "sh1", since: Date.now() - 100_000 }];
  await h.probe.storageSet(goalStorageKey(S), g);
  // host restart sweep left its synthetic "server restarted…continue" message:
  // metadata { notice: "restart" } (spec §7.1 step 2 — assumption pinned above).
  h.setMessages(S, [
    {
      id: "m1",
      type: "synthetic",
      text: "The server restarted while you were working. Continue from where you left off.",
      metadata: { notice: "restart" },
    },
  ]);
  const ctrl = new GoalController(h.probe, OPTS, { shellProbe: fake.probe, tickMs: 1 });
  const stop = await ctrl.start();
  expect(h.prompts.length).toBe(0); // host already acting → no new wake
  const atStart = fake.calls();
  expect(atStart).toBeGreaterThan(0); // re-verified against probe.list
  await sleep(60);
  expect(fake.calls()).toBeGreaterThan(atStart); // watchdog re-armed: ticks keep probing
  await stop();
});

// ---------------------------------------------------------------------------
// 8. reconciliation — idle session, shell lost with the restart
// ---------------------------------------------------------------------------

test("8: reconcile — idle + shell gone from probe → lost wake + our pending inbox wake cancelled", async () => {
  const h = await createHarness();
  const fake = makeFakeProbe([]); // sh1 gone with the restart
  const g = createGoal({ sessionID: S, objective: "Recon8" });
  g.waitingShells = [{ id: "sh1", since: Date.now() - 100_000 }];
  await h.probe.storageSet(goalStorageKey(S), g);
  // our own pending wake still queued in the inbox (metadata goalWake)
  h.inbox.set(S, [
    {
      id: "inbox_77",
      sessionID: S,
      type: "user",
      delivery: "queue",
      payload: { text: "old wake", metadata: { goalWake: true, goalID: g.id } },
    },
  ]);
  const ctrl = new GoalController(h.probe, OPTS, { shellProbe: fake.probe, tickMs: 1 });
  const stop = await ctrl.start();
  expect(h.prompts.length).toBe(1);
  const t = h.prompts[0].input.text;
  expect(t).toContain("lost");
  expect(t).toContain("cancelled");
  expect(h.prompts[0].input.metadata?.goalControl).toBe(true);
  expect(h.cancelledInbox).toContain("inbox_77"); // old wake cancelled (captured)
  expect(h.inbox.get(S)?.length).toBe(0); // actually removed from the live inbox
  expect((goalOf(h)!.waitingShells ?? []).length).toBe(0);
  await stop();
});

// ---------------------------------------------------------------------------
// 9. reconciliation — soft reload (shell still running)
// ---------------------------------------------------------------------------

test("9: reconcile — shell still running after soft reload → re-arm, no wake", async () => {
  const h = await createHarness();
  const fake = makeFakeProbe([{ id: "sh1", state: "running", outputTail: "r1" }]);
  const g = createGoal({ sessionID: S, objective: "Recon9" });
  g.waitingShells = [{ id: "sh1", since: Date.now() - 100_000 }];
  await h.probe.storageSet(goalStorageKey(S), g);
  const ctrl = new GoalController(h.probe, OPTS, { shellProbe: fake.probe, tickMs: 1 });
  const stop = await ctrl.start();
  expect(h.prompts.length).toBe(0);
  const atStart = fake.calls();
  expect(atStart).toBeGreaterThan(0);
  await sleep(60);
  expect(fake.calls()).toBeGreaterThan(atStart); // re-armed: ticks keep probing
  // since re-recorded (fresh countdown anchored at the reload)
  expect(goalOf(h)!.waitingShells?.[0]?.since ?? 0).toBeGreaterThanOrEqual(Date.now() - 60_000);
  await stop();
});

// ---------------------------------------------------------------------------
// 10. cleanup stops everything
// ---------------------------------------------------------------------------

test("10: cleanup — after stop() no probe.list / rpc growth", async () => {
  const { h, fake, stop } = await boot();
  await h.commandExecutor(S, "/goal set Clean");
  fake.set([{ id: "sh1", state: "running", outputTail: "fixed" }]);
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1"));
  await sleep(60);
  expect(fake.calls()).toBeGreaterThan(0);
  const listAtStop = fake.calls();
  const rpcAtStop = h.rpc.calls.length;
  await stop();
  await sleep(120); // advance real time
  expect(fake.calls()).toBe(listAtStop);
  expect(h.rpc.calls.length).toBe(rpcAtStop);
});

// ---------------------------------------------------------------------------
// 11. reconcile fail-safe — probe facts unavailable (review finding C1)
// ---------------------------------------------------------------------------

test("11: reconcile — probe facts unavailable (no shellProbe / list throws) → no lost wake, no inboxCancel, waitingShells intact + re-anchored", async () => {
  // (a) no shellProbe wired at all (the guaranteed production path before the
  // probe could answer — reconcile must NOT read empty facts as "all shells gone")
  {
    const h = await createHarness();
    const g = createGoal({ sessionID: S, objective: "Recon11a" });
    g.waitingShells = [{ id: "sh1", since: Date.now() - 100_000 }];
    await h.probe.storageSet(goalStorageKey(S), g);
    h.inbox.set(S, [
      {
        id: "inbox_88",
        sessionID: S,
        type: "user",
        delivery: "queue",
        payload: { text: "old wake", metadata: { goalWake: true, goalID: g.id } },
      },
    ]);
    const ctrl = new GoalController(h.probe, OPTS, { tickMs: 1 }); // no shellProbe
    const stop = await ctrl.start();
    await sleep(60);
    expect(h.prompts.length).toBe(0); // no fabricated "lost/cancelled" wake
    expect(h.cancelledInbox.length).toBe(0); // no fabricated inboxCancel
    const ws = goalOf(h)!.waitingShells;
    expect(ws?.map((w) => w.id)).toEqual(["sh1"]); // intact
    expect(ws![0].since).toBeGreaterThanOrEqual(Date.now() - 5_000); // re-anchored
    await stop();
  }
  // (b) probe wired but list() rejects (RPC down) — same fail-safe, and the
  // armed ticks keep retrying without mutating state
  {
    const h = await createHarness();
    let listCalls = 0;
    const throwingProbe: ShellProbe = {
      list: async () => {
        listCalls += 1;
        throw new Error("rpc down");
      },
    };
    const g = createGoal({ sessionID: S, objective: "Recon11b" });
    g.waitingShells = [{ id: "sh1", since: Date.now() - 100_000 }];
    await h.probe.storageSet(goalStorageKey(S), g);
    h.inbox.set(S, [
      {
        id: "inbox_89",
        sessionID: S,
        type: "user",
        delivery: "queue",
        payload: { text: "old wake", metadata: { goalWake: true, goalID: g.id } },
      },
    ]);
    const ctrl = new GoalController(h.probe, OPTS, { shellProbe: throwingProbe, tickMs: 1 });
    const stop = await ctrl.start();
    await sleep(200); // armed ticks all hit the rejecting list() (cadence on this box is ~12ms/tick)
    expect(listCalls).toBeGreaterThan(0);
    expect(h.prompts.length).toBe(0);
    expect(h.cancelledInbox.length).toBe(0);
    const ws = goalOf(h)!.waitingShells;
    expect(ws?.map((w) => w.id)).toEqual(["sh1"]);
    expect(ws![0].since).toBeGreaterThanOrEqual(Date.now() - 5_000);
    await stop();
  }
});

// ---------------------------------------------------------------------------
// 12. tick fault tolerance — probe failures don't kill the timer (review I3)
// ---------------------------------------------------------------------------

test("12: tick — probe failure window then recovery: timer survives, no state change during failures, check-in fires after", async () => {
  let listCalls = 0;
  // GATED failure window, not "first N calls": this box's effective 1ms-timer
  // cadence is ~12ms/tick (Windows timer granularity), so a fixed call count
  // maps to a machine-dependent wall-clock window. The gate makes the window
  // deterministic: list() rejects until we open it, whatever the cadence.
  const gate = { open: false };
  const { h, stop } = await bootWith({
    tickMs: 1,
    shellProbe: {
      list: async () => {
        listCalls += 1;
        if (!gate.open) throw new Error("rpc down");
        return [{ id: "sh1", state: "running", outputTail: "fixed" }];
      },
    },
  });
  await h.commandExecutor(S, "/goal set Fault12");
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // idle boundary
  await sleep(200); // inside the (gate-controlled) failing window
  expect(listCalls).toBeGreaterThan(0); // the timer kept ticking through failures
  expect(h.prompts.length).toBe(0); // no injection without facts
  expect((goalOf(h)!.waitingShells ?? []).length).toBe(1); // no state change
  gate.open = true; // recovery
  await waitFor(() => h.prompts.length === 1, 3000, "check-in after probe recovery");
  expect(h.prompts[0].input.text).toContain("likely stalled"); // constant tail → zero-growth after baseline
  expect(h.prompts[0].input.text).toContain("fixed"); // tail carried once facts returned
  await h.emit(succeeded("b2")); // the event loop still consumes after the failure window
  expect(goalOf(h)!.lastHandledEventID).toBe("b2");
  await stop();
});

// ---------------------------------------------------------------------------
// Task 14 Fix 3b: timeoutWrap — the previously no-op option now rewrites
// `input.timeout` in the shell create.before handler.
// ---------------------------------------------------------------------------

test("13: timeoutWrap — no-timeout spawns get shellStallMs while an active goal exists; host values and the cleared state never rewritten", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(
    h.probe,
    resolveOptions({ timeoutWrap: true, shellStallMs: 1234 }),
    {},
  );
  const stop = await ctrl.start();
  const before = h.shellCreateBefore[0];
  const timeouts = (ctrl as unknown as { shellTimeouts: Map<string, number> }).shellTimeouts;
  // 0. default options (timeoutWrap false) + timeout 0 → untouched, not
  //    recorded (current behavior must not regress)
  const h0 = await createHarness();
  const ctrl0 = new GoalController(h0.probe, resolveOptions({}), {});
  const stop0 = await ctrl0.start();
  const input0 = { command: "cmd0", cwd: "/w", timeout: 0 };
  h0.shellCreateBefore[0](input0);
  expect(input0.timeout).toBe(0);
  expect((ctrl0 as unknown as { shellTimeouts: Map<string, number> }).shellTimeouts.size).toBe(0);
  await stop0();
  // 1. no active goal + timeout 0 → untouched, not recorded
  let input = { command: "cmd", cwd: "/w", timeout: 0 };
  before(input);
  expect(input.timeout).toBe(0);
  expect(timeouts.size).toBe(0);
  // 2. active goal + timeout 0 → rewritten in place to options.shellStallMs
  await h.commandExecutor(S, "/goal set Wrap");
  expect(goalOf(h)!.status).toBe("active");
  input = { command: "cmd", cwd: "/w", timeout: 0 };
  before(input);
  expect(input.timeout).toBe(1234); // SAME object was rewritten (payload is mutable)
  expect(timeouts.get("cmd\u0000/w")).toBe(1234); // rememberShellTimeout recorded the effective value
  // 3. active goal + host timeout present → host value is never overwritten
  input = { command: "cmd2", cwd: "/w", timeout: 5000 };
  before(input);
  expect(input.timeout).toBe(5000);
  expect(timeouts.get("cmd2\u0000/w")).toBe(5000);
  // 4. after /goal clear the active-goal set is empty → no more rewrites
  h.setMessages(S, [{ id: "m1", type: "user", text: "please discard the branch and stop the work" }]);
  await h.commandExecutor(S, "/goal clear");
  expect(goalOf(h)!.status).toBe("cleared");
  input = { command: "cmd3", cwd: "/w", timeout: 0 };
  before(input);
  expect(input.timeout).toBe(0);
  expect(timeouts.get("cmd3\u0000/w")).toBeUndefined();
  await stop();
});

// ---------------------------------------------------------------------------
// Task 14 Fix 4: /goal resume re-arms the watchdog.
// ---------------------------------------------------------------------------

test("14: /goal resume re-arms the watchdog (pause disarms via the tick ghost rule)", async () => {
  // Traced current behavior (assertions written to the trace, per brief):
  // pauseGoal does NOT disarm the tick — the next tick's ghost rule
  // (runWatchdogTick: status !== active → disarm) stops it. So the
  // precondition here is "tick count stops growing AFTER the disarm"; the
  // resume must trigger the ensureWatchdog path — without Fix 4 the tick
  // count would stay frozen after resume (the pause's ghost disarm never
  // gets undone), and the test's post-resume growth assertion fails.
  const h = await createHarness();
  const fake = makeFakeProbe();
  const ctrl = new GoalController(h.probe, OPTS, { shellProbe: fake.probe, tickMs: 5 });
  const stop = await ctrl.start();
  const armed = () => (ctrl as unknown as { wdTimers: Map<string, unknown> }).wdTimers.has(S);
  await h.commandExecutor(S, "/goal set Re-arm on resume");
  fake.set([{ id: "shR", state: "running", outputTail: "r1" }]);
  await h.emit(shellStarted("er1", { id: "shR", command: "cmdR", cwd: "/w" }));
  // precondition: the armed watchdog is actually ticking
  await waitFor(() => fake.calls() > 0, 2000, "pre-pause tick");
  await sleep(30); // >= 3 tick periods
  expect(fake.calls()).toBeGreaterThan(1);
  // pause → paused record; the ghost rule disarms on the next tick
  await h.commandExecutor(S, "/goal pause");
  expect(goalOf(h)!.status).toBe("paused");
  await waitFor(() => !armed(), 2000, "disarm via tick ghost rule");
  const frozen = fake.calls();
  await sleep(40); // >= 8 tick periods: while paused the count must NOT grow
  expect(fake.calls()).toBe(frozen);
  // resume → ensureWatchdog re-arms (Fix 4)
  await h.commandExecutor(S, "/goal resume");
  expect(goalOf(h)!.status).toBe("active");
  expect(armed()).toBe(true);
  const after = fake.calls();
  await waitFor(() => fake.calls() > after, 2000, "post-resume tick growth");
  await stop();
});

// ---------------------------------------------------------------------------
// Task 13 smoke: the shell facts RPC method name matches the value DISCOVERED
// on 2.0.29 — statically from @opencode/protocol@2.0.29
// (dist/groups/shell.js: HttpApiEndpoint.get("shell.list", "/api/shell", ...)
// in the "server.shell" group) and live against an isolated 2.0.29 host
// (scripts/live-smoke.ts, see .superpowers/sdd/2026-10-15-opencode-goal/
// task-13-report.md). Guards against an accidental rename of the constant.
// ---------------------------------------------------------------------------

test("task13: SHELL_LIST_RPC_METHOD matches the 2.0.29 shell-list RPC identifier", () => {
  expect(SHELL_LIST_RPC_METHOD).toBe("shell.list");
});
