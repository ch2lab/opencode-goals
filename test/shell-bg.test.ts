// §52 foreground-shell auto-backgrounding (2026-10-21 ruling: a blocking
// shell that outlives the cap must not freeze the goal loop forever — the
// turn is blocked on the tool call, so no boundary, no check-in, no wake).
// The plugin calls the host's session.background endpoint (the Ctrl+B server
// action: the work keeps running; the host injects its own synthetic).
//
//   T1 a foreground shell older than the cap → exactly ONE POST (deduped)
//   T2 a background shell (metadata.background) is never re-backgrounded
//   T3 cap = 0 → disabled (no POST, ever)
//   T4 a young foreground shell (under the cap) is left alone

import { test, expect } from "bun:test";
import { createHarness, type Harness } from "./harness";
import { GoalController } from "../src/controller";
import { resolveOptions } from "../src/options";

const S = "ses_shell_bg";

async function boot(options: Record<string, unknown> = { foregroundShellBackgroundMs: 1000 }) {
  const h = await createHarness();
  const ctrl = new GoalController(h.probe, resolveOptions(options), {
    tickMs: 1,
    contWindowMs: 50,
    livenessMs: 60_000, // keep the §50 liveness recheck out of these tests
    livenessCheckMs: 20, // the §52 scan rides this 20ms timer
  });
  const stop = await ctrl.start();
  return { h, stop };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

test("T1: a foreground shell older than the cap is backgrounded — exactly once, deduped", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set ShellBG");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([
    { id: "sh_fg", status: "running", sessionID: S, time: { started: Date.now() - 5000 } },
  ]);
  expect(await until(() => h.backgroundCalls.length >= 1)).toBe(true); // the POST happened
  await sleep(300); // several more scans
  expect(h.backgroundCalls).toEqual([S]); // exactly one POST for this shell
  await stop();
});

test("T2: a background shell (metadata.background) is never re-backgrounded", async () => {
  const { h, stop } = await boot();
  await h.commandExecutor(S, "/goal set BGOnly");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([
    { id: "sh_bg", status: "running", sessionID: S, background: true, time: { started: Date.now() - 5000 } },
  ]);
  await sleep(400); // several scans
  expect(h.backgroundCalls.length).toBe(0);
  await stop();
});

test("T3: cap = 0 disables the feature entirely", async () => {
  const { h, stop } = await boot({ foregroundShellBackgroundMs: 0 });
  await h.commandExecutor(S, "/goal set Off");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([
    { id: "sh_fg", status: "running", sessionID: S, time: { started: Date.now() - 5000 } },
  ]);
  await sleep(400);
  expect(h.backgroundCalls.length).toBe(0);
  await stop();
});

test("T4: a young foreground shell (under the cap) is left alone", async () => {
  const { h, stop } = await boot(); // cap = 1000ms
  await h.commandExecutor(S, "/goal set Young");
  h.setSession(S, { location: { directory: "/w" } });
  h.setShells([
    { id: "sh_young", status: "running", sessionID: S, time: { started: Date.now() - 100 } },
  ]);
  await sleep(300); // well under the cap
  expect(h.backgroundCalls.length).toBe(0);
  await stop();
});
