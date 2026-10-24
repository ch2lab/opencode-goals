// §54 (2026-10-22 ruling, 129 sm70 screenshot): a session BLOCKED ON ITS OWN
// FOREGROUND shell is silent — a periodic check-in could not be delivered
// (it would only queue behind the blocked turn, mislabeled "background item"),
// the §50 liveness recheck must not mistake the expected silence for a dead
// stream, and the fire-time guard discards any deadline that would land on a
// blocked turn. The §52 scan (auto-background at the cap) is what moves it.
//
//   F1 a terminal boundary with a running foreground shell → hold, NO check-in
//      arm (reason + fg field in the decision log); after the shell leaves the
//      store the next boundary wakes normally
//   F2 an armed (background) check-in whose due arrives while a foreground
//      shell is in flight → deadline discarded, no delivery
//   F3 the §50 liveness recheck skips a session blocked on a foreground shell
//      (control leg: without it the scan rechecks — the scan must stay alive)
//   F4 §56 (2026-10-24 host-contract flip): an UNFLAGGED shell entry is
//      BACKGROUND (the host omits metadata.background for bg shells) — such a
//      shell arms the progress check-in normally; only an explicit
//      `background: false` is foreground

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import { decisionLogPath } from "../src/decisionlog.ts";
import { backgroundCheckInText } from "../src/wake.ts";
import { GoalController } from "../src/controller.ts";
import { resolveOptions } from "../src/options.ts";
import type { HostEvent } from "../src/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const S = "s_fg";

function ev(type: string, id: string, properties: Record<string, unknown>): HostEvent {
  return { type, id, properties };
}
function started(id: string): HostEvent {
  return ev("session.execution.started", id, { sessionID: S });
}
function succeeded(id: string): HostEvent {
  return ev("session.execution.succeeded", id, { sessionID: S });
}
function toolCalled(id: string): HostEvent {
  return ev("session.tool.called", id, {
    input: {},
    executed: true,
    assistantMessageID: "am1",
    id: "tc1",
    sessionID: S,
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

function lastDecision(sessionID: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(decisionLogPath(process.pid), "utf8");
    const lines = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mine = lines.filter((l) => l.sessionID === sessionID);
    return mine[mine.length - 1];
  } catch {
    return undefined;
  }
}

async function boot(options: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions(options), {
    tickMs: 1,
    contWindowMs: 50,
    ...deps,
  });
  const stop = await ctrl.start();
  return { h, ctrl, stop };
}

test("F1: boundary with a running foreground shell → hold, NO check-in arm; unblocked boundary wakes", async () => {
  const { h, ctrl, stop } = await boot({ checkInDelaySec: 1 });
  await h.commandExecutor(S, "/goal set FGBlock");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "sh_fg", status: "running", sessionID: S }]); // §56: blocking = live turn + non-bg shell
  h.setActiveSessions({ [S]: "running" }); // the turn is alive (the UI's running badge)
  await h.emit(started("a1"));
  await h.emit(toolCalled("t1"));
  await h.emit(succeeded("b1")); // the blocked turn's (fabricated or real) terminal
  const line = lastDecision(S);
  expect(line?.decision).toBe("hold");
  expect(line?.fg).toBe(1);
  expect(String(line?.reason)).toContain("foreground shell blocked");
  const any = ctrl as unknown as { checkinDue: Map<string, unknown>; wdTimers: Map<string, unknown> };
  expect(any.checkinDue.has(S)).toBe(false); // nothing armed
  expect(any.wdTimers.has(S)).toBe(false); // no tick to fire it
  await sleep(1500); // well past the 1s check-in window: still silent
  expect(h.prompts.length).toBe(0);
  // The foreground shell leaves the store → the next boundary resumes the loop.
  h.setShells([]);
  h.setActiveSessions({});
  await h.emit(started("a2"));
  await h.emit(toolCalled("t2"));
  await h.emit(succeeded("b2"));
  expect(h.prompts.length).toBe(1);
  await stop();
});

test("F2: an armed (background) check-in is discarded at due when a foreground shell is in flight", async () => {
  const { h, ctrl, stop } = await boot({ checkInDelaySec: 1 });
  await h.commandExecutor(S, "/goal set FireGuard");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([{ id: "sh_bg", status: "running", sessionID: S, background: true }]);
  await h.emit(started("a1"));
  await h.emit(toolCalled("t1"));
  await h.emit(succeeded("b1")); // background in flight → arm (1s)
  const any = ctrl as unknown as { checkinDue: Map<string, unknown> };
  expect(any.checkinDue.has(S)).toBe(true);
  // The session goes on blocking: a foreground shell appears in the store.
  h.setShells([
    { id: "sh_bg", status: "running", sessionID: S, background: true },
    { id: "sh_fg", status: "running", sessionID: S },
  ]);
  h.setActiveSessions({ [S]: "running" }); // §56: the guard keys on the live turn
  await sleep(1500); // due passes: the fire-time guard discards, never delivers
  expect(h.prompts.length).toBe(0);
  expect(any.checkinDue.has(S)).toBe(false); // discarded — the end boundary re-arms
  await stop();
});

test("F3: the §50 liveness recheck skips a session blocked on a foreground shell (and still heals without one)", async () => {
  const { h, stop } = await boot({}, { livenessMs: 300, livenessCheckMs: 20 });
  const warns: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  const recheckCount = () => warns.filter((w) => String(w[0] ?? "").includes("liveness recheck")).length;
  try {
    await h.commandExecutor(S, "/goal set LivenessSkip");
    h.setSession(S, { location: { directory: "/w" } });
    h.setShells([{ id: "sh_fg", status: "running", sessionID: S }]); // §56: blocking = live turn + non-bg shell
    h.setActiveSessions({ [S]: "running" });
    await h.emit(started("a1")); // an active turn whose events stop here (blocked shell)
    await sleep(1200); // many scan periods past the 300ms silence window
    expect(recheckCount()).toBe(0); // SKIPPED: the silence is expected, not a dead stream
    expect(h.prompts.length).toBe(0); // no fabricated boundary, no check-in
    // Control leg: unblock → the scan is alive and rechecks the stranded turn.
    h.setShells([]);
    h.setActiveSessions({});
    expect(await until(() => recheckCount() > 0, 4000)).toBe(true);
  } finally {
    console.warn = origWarn;
    await stop();
  }
});

test("F4: §56 — an UNFLAGGED shell entry is BACKGROUND: boundary arms the check-in, which fires with a (bg) roster label", async () => {
  const { h, stop } = await boot({ checkInDelaySec: 1 });
  await h.commandExecutor(S, "/goal set UnflagBG");
  h.setSession(S, { location: { directory: "/w" } });
  // NO background field — the host omits it for background shells (129
  // transcript: model launched with background:true → entry without the
  // field). §54 read "absent" as foreground and silenced this case.
  h.setShells([{ id: "sh_unflag", status: "running", sessionID: S }]);
  await h.emit(started("a1"));
  await h.emit(toolCalled("t1"));
  await h.emit(succeeded("b1")); // in-flight (bg) boundary → arm
  await until(() => h.prompts.length === 1, 3000);
  expect(h.prompts.length).toBe(1);
  expect(h.prompts[0].input.text).toBe(backgroundCheckInText(1, 1, ["sh_unflag (bg)"]));
  await stop();
});
