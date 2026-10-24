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
import * as fs from "node:fs";
import { decisionLogPath } from "../src/decisionlog";
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
    { id: "sh_fg", status: "running", sessionID: S, background: false, time: { started: Date.now() - 5000 } },  // §56: explicit false = foreground
  ]);
  h.setActiveSessions({ [S]: "running" }); // §56: §52 rescues only a BLOCKED turn
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
    { id: "sh_fg", status: "running", sessionID: S, background: false, time: { started: Date.now() - 5000 } },  // §56: explicit false = foreground
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
    { id: "sh_young", status: "running", sessionID: S, background: false, time: { started: Date.now() - 100 } },  // §56
  ]);
  await sleep(300); // well under the cap
  expect(h.backgroundCalls.length).toBe(0);
  await stop();
});

// --- §54 (2026-10-22 ruling): the auto-background is NOT silent — the plugin
// delivers its own IMMEDIATE notice (one per shell) so the model knows WHAT was
// moved, without waiting for the host's synthetic or the 5-minute cycle. ---

test("T5: §54 on cap: exactly ONE immediate notice (goalControl, id + command + cap) + a decision line", async () => {
  const { h, stop } = await boot(); // cap = 1000ms
  await h.commandExecutor(S, "/goal set NoticeT5");
  h.setSession(S, { location: { directory: "/w" } });
  // The decision log file is shared across tests in this process — count deltas.
  const countWatchdogLines = (): number => {
    const raw = fs.readFileSync(decisionLogPath(process.pid), "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.sessionID === S && l.decision === "watchdog").length;
  };
  const before = countWatchdogLines();
  h.setShells([
    {
      id: "sh_fg5",
      status: "running",
      sessionID: S,
      background: false, // §56: explicit false = foreground
      command: "long maintenance script",
      time: { started: Date.now() - 60_000 }, // a minute over the cap
    },
  ]);
  h.setActiveSessions({ [S]: "running" }); // §56: §52 rescues only a BLOCKED turn
  expect(await until(() => h.backgroundCalls.length >= 1)).toBe(true); // the POST happened
  expect(await until(() => h.prompts.length >= 1)).toBe(true); // the immediate notice
  const notice = h.prompts[0];
  expect(notice.input.metadata?.goalControl).toBe(true); // the watchdog wake channel
  const text = notice.input.text;
  expect(text).toContain("sh_fg5");
  expect(text).toContain('(command: "long maintenance script")');
  expect(text).toContain("moved it to background automatically");
  expect(text).toContain("max foreground blocking time");
  await sleep(400); // several more scans: deduped — still exactly one notice
  expect(h.prompts.length).toBe(1);
  expect(countWatchdogLines() - before).toBe(1); // the watchdog path left exactly one line
  const raw = fs.readFileSync(decisionLogPath(process.pid), "utf8");
  const mine = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.sessionID === S && l.decision === "watchdog");
  expect(String(mine[mine.length - 1].reason)).toContain("auto-backgrounded");
  await stop();
});
