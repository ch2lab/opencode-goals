// Task 10 (rewritten 2026-10-19): the shell-wait surface is UNIFIED under the
// in-flight gate + one-shot progress check (ruling: 化繁为简 — the event-driven
// shell-exit fast path and the event-cache in-flight count are REMOVED):
//
//   - in-flight shells are DISCOVERED by query from the host shell store
//     (the harness mirrors the host: emit(started) adds, emit(ended) removes);
//   - a terminal boundary with in-flight background work does NOT wake; it
//     arms the one-shot progress check (test/background-gate.test.ts owns the
//     arming/cancel/fire semantics);
//   - a shell ending no longer fast-paths a result wake — the completion
//     rides the one-shot progress check (the nudge) or a goal resume.
//
// What this file pins: the no-fast-path completion behavior, the watchdog tick
// lifecycle, the timeoutWrap rewrite, and the stall attribution of a plain-text
// reply to a progress check.
//
// Controller ruling (rulings.md): REAL timers with small option values
// + STATE polling via waitFor(pred, timeout) — never exact wall-clock
// moments.
//
// Event payload assumptions pinned here (brief ruling: code the current
// assumption + TODO(task13) where genuinely open):
//  - the controller consumes the DURABLE, session-scoped shell family
//    `session.shell.started` / `session.shell.ended`
//    (schema/dist/session-event.d.ts Shell.Started/Ended): data = { shell:
//    ShellInfo, sessionID } and data = { shell: ShellInfo, output: { output,
//    cursor, size, truncated }, sessionID }.
//  - ShellInfo.status ∈ "running" | "exited" | "timeout" | "killed"
//    (shell.d.ts Shell.Status — there is NO "completed" value; "exited" is
//    the plain exit).
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { goalStorageKey, type GoalRecord } from "../src/state.ts";
import { GoalController } from "../src/controller.ts";
import type { HostEvent } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s1";

const OPTS = resolveOptions({ watchdogTickMs: 1 });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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
  ctrl: GoalController;
  stop: () => Promise<void>;
}

async function boot(opts = OPTS): Promise<Boot> {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, opts, { tickMs: 1 });
  const stop = await ctrl.start();
  return { h, ctrl, stop };
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

// ---------------------------------------------------------------------------
// 1. fast path (boundary while waiting) + event-driven exit wake wording
// ---------------------------------------------------------------------------

test("1: shell in flight — the boundary arms the check (no wake); shell.ended no longer fast-paths a wake (completion rides the check)", async () => {
  const { h, stop } = await boot(resolveOptions({ watchdogTickMs: 1, checkInDelaySec: 1 }));
  await h.commandExecutor(S, "/goal set Fast");
  h.setSession(S, { location: { directory: "/w" } }); // the shell-store query needs the session's location
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // in-flight boundary → arm the check, no wake
  expect(h.prompts.length).toBe(0);
  expect(goalOf(h)!.lastHandledEventID).toBe("b1");
  // The shell ends (leaves the store): the event-driven fast path is GONE — no
  // immediate result wake; the completion rides the one-shot progress check.
  await h.emit(shellEnded("x1", "sh1", "timeout"));
  expect(h.prompts.length).toBe(0); // no fast-path wake
  // ...until the check fires: the progress-check-in nudge lands.
  await waitFor(() => h.prompts.length === 1, 3000, "progress check-in");
  expect(h.prompts[0].input.text).toContain("Background check-in");
  await stop();
});

// (The event-driven shell-exit fast path and its ghost/duplicate guard were
// removed 2026-10-19 — a shell ending no longer wakes; completion rides the
// one-shot progress check, covered by test 1 and background-gate.test.ts.)

// ---------------------------------------------------------------------------
// 3. a progress check replied with pure text (no tool) → stall counts
//    normally at the boundary (spec §7.1 attribution, kept for the new
//    check-in family)
// ---------------------------------------------------------------------------

test("3: progress check replied with pure text → the boundary stalls normally and carries its wake", async () => {
  const { h, stop } = await boot(resolveOptions({ watchdogTickMs: 1, checkInDelaySec: 1 }));
  await h.commandExecutor(S, "/goal set Text3");
  h.setSession(S, { location: { directory: "/w" } });
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // in-flight boundary → arm the one-shot check
  await waitFor(() => h.prompts.length === 1, 3000, "progress check-in");
  expect(h.prompts[0].input.text).toContain("Background check-in");
  expect(goalOf(h)!.stalls).toBe(0);
  // model replies with plain text: turn starts and ends, no tool.called
  await h.emit(started("s1"));
  await h.emit(succeeded("b2"));
  expect(goalOf(h)!.stalls).toBe(1); // stall counts normally
  expect(h.prompts.length).toBe(2); // the boundary carries its normal wake
  await stop();
});

// ---------------------------------------------------------------------------
// 4. cleanup stops the tick
// ---------------------------------------------------------------------------

test("4: cleanup — after stop() the tick is gone (no timer, no further activity)", async () => {
  const { h, ctrl, stop } = await boot(resolveOptions({ watchdogTickMs: 1, checkInDelaySec: 1 }));
  await h.commandExecutor(S, "/goal set Clean");
  h.setSession(S, { location: { directory: "/w" } });
  await h.emit(shellStarted("e1", { id: "sh1", command: "cmdA", cwd: "/w" }));
  await h.emit(succeeded("b1")); // arm → the tick is the deadline's heartbeat
  await waitFor(() => (ctrl as unknown as { wdTimers: Map<string, unknown> }).wdTimers.has(S), 2000, "tick armed");
  const shellCallsAtStop = h.shellListCalls;
  await stop();
  await sleep(150); // advance real time
  expect((ctrl as unknown as { wdTimers: Map<string, unknown> }).wdTimers.has(S)).toBe(false);
  expect(h.shellListCalls).toBe(shellCallsAtStop);
});

// ---------------------------------------------------------------------------
// 5. timeoutWrap — the no-op-free option rewrites `input.timeout` in the
//    shell create.before handler (value = checkInDelaySec * 1000: an
//    unwrapped spawn is reaped by the host after the background-wait window)
// ---------------------------------------------------------------------------

test("5: timeoutWrap — no-timeout spawns get checkInDelaySec*1000 while an active goal exists; host values and the cleared state never rewritten", async () => {
  const h = await createHarness();
  const ctrl = new GoalController(
    h.probe,
    resolveOptions({ timeoutWrap: true, checkInDelaySec: 1234 }),
    {},
  );
  const stop = await ctrl.start();
  const before = h.shellCreateBefore[0];
  // 0. default options (timeoutWrap false) + timeout 0 → untouched
  const h0 = await createHarness();
  const ctrl0 = new GoalController(h0.probe, resolveOptions({}), {});
  const stop0 = await ctrl0.start();
  const input0 = { command: "cmd0", cwd: "/w", timeout: 0 };
  h0.shellCreateBefore[0](input0);
  expect(input0.timeout).toBe(0);
  await stop0();
  // 1. no active goal + timeout 0 → untouched, not recorded
  let input = { command: "cmd", cwd: "/w", timeout: 0 };
  before(input);
  expect(input.timeout).toBe(0);
  // 2. active goal + timeout 0 → rewritten in place to checkInDelaySec*1000
  await h.commandExecutor(S, "/goal set Wrap");
  expect(goalOf(h)!.status).toBe("active");
  input = { command: "cmd", cwd: "/w", timeout: 0 };
  before(input);
  expect(input.timeout).toBe(1234000); // SAME object was rewritten (payload is mutable)
  // 3. active goal + host timeout present → host value is never overwritten
  input = { command: "cmd2", cwd: "/w", timeout: 5000 };
  before(input);
  expect(input.timeout).toBe(5000);
  // 4. after /goal clear the active-goal set is empty → no more rewrites
  h.setMessages(S, [{ id: "m1", type: "user", text: "please discard the branch and stop the work" }]);
  await h.commandExecutor(S, "/goal clear");
  expect(goalOf(h)!.status).toBe("cleared");
  input = { command: "cmd3", cwd: "/w", timeout: 0 };
  before(input);
  expect(input.timeout).toBe(0);
  await stop();
});
