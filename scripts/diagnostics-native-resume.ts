// Task 13 diagnostics (spec §14): host NATIVE resume experiment — kill the
// service MID-TURN (turn in progress, blocked on a long shell) and restart;
// record whether the host's resumeSuspendedSessions sweep ran:
//   - synthetic message with metadata notice === "restart" ("The server
//     restarted while you were working. Continue from where you left off…")
//   - does the suspended turn actually resume (execution events)?
//   - what does the plugin's goal record say after the fact?
//
// Requires a model (the lab LLM, isolated host) to start a real turn.
// Credentials come from env only (OPENCODE_LAB_PROVIDER_BASE / _KEY).
// Manual reading only — NOT part of `bun test`.
//
//   bun run scripts/diagnostics-native-resume.ts [--keep-dir]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHost, readLogFile, TMP_BASE, labProvider, type IsolatedHost, type ProviderSpec } from "./host.ts";

const keepDir = process.argv.includes("--keep-dir");
const dir = join(TMP_BASE, `ocgoal-resume-${Date.now()}`);
const port1 = 47650 + Math.floor(Math.random() * 50);

let provider: ProviderSpec;
try {
  provider = await labProvider();
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

// Orphan-host guard (Task-13 review fix): both hosts are stopped on ANY exit
// path (mid-scenario kill + any throw before/after h2 boots).
let h2: IsolatedHost | undefined;
const stopped = new Set<IsolatedHost>();
const stopHost = async (h: IsolatedHost): Promise<void> => {
  if (stopped.has(h)) return;
  stopped.add(h);
  try {
    h.stopEventCapture();
    await h.stop();
  } catch {}
};

const h1 = await startHost({ dir, keepDir: true, port: port1, provider });
const s = await h1.api.createSession().catch(() => {
  void stopHost(h1);
  throw new Error("createSession failed");
});
console.log(`session=${s}`);
try {
  await h1.api.command(s, "goal", "set survive a mid-turn restart");
  await Bun.sleep(1000);
  await h1.api.prompt(s, "Use the shell tool to run exactly: Start-Sleep -Seconds 90; Write-Output done. Wait for it, then report that it finished. Do nothing else.");
  console.log("prompt sent — waiting for the turn to block on the shell…");

  // let the turn start and the shell run (turn stays in progress)
  await Bun.sleep(20_000);
  const shells = await h1.api.shellList();
  console.log(`running shells: ${JSON.stringify(shells.map((x: any) => ({ id: x.id, status: x.status, command: x.command })))}`);

  console.log(`\n-- killing the service mid-turn (pid ${h1.pid}) --`);
  await stopHost(h1);
  h2 = await startHost({ dir, keepDir: true, port: port1 + 1, provider });
  const evFile = await h2.startEventCapture(120);
  await Bun.sleep(30_000);
  h2.stopEventCapture();
  await Bun.sleep(500);

  const ctx = JSON.stringify(await h2.api.context(s));
  const g = await h2.api.goalsGet(s);
  const events = (await readFile(evFile, "utf8").catch(() => ""));
  const execStarted = (events.match(/"type":"session\.execution\.started"/g) ?? []).length;

  console.log(`\n[1] notice:"restart" synthetic in context: ${/"notice"\s*:\s*"restart"/.test(ctx)}`);
  console.log(`    around marker: ${(() => { const i = ctx.search(/restarted|"notice"/); return i < 0 ? "(none)" : ctx.slice(Math.max(0, i - 150), i + 200).replace(/"/g, "'"); })()}`);
  console.log(`[2] shells after restart: ${JSON.stringify((await h2.api.shellList()).map((x: any) => ({ id: x.id, status: x.status })))}`);
  console.log(`    execution.started events in the 30s after restart: ${execStarted}`);
  console.log(`[3] goal: status=${g.output?.status} continuations=${g.output?.continuations} stalls=${g.output?.stalls}`);
  console.log(`    goalWake in context after restart: ${ctx.includes("goalWake")}`);
  console.log(`\nVERDICT: ${/"notice"\s*:\s*"restart"/.test(ctx) ? "host native resume path engaged (sweep ran) — see marker above" : "no restart notice observed — sweep did not engage for this serve restart (spec §7.1 'service is lazy' case)"}`);

  if (keepDir) {
    console.log(`\n--- host log tail (resume/wake lines) ---`);
    const log = await readLogFile(h2, 400);
    console.log(log.split("\n").filter((l) => /resume|reconcil|wake|restarted|suspended/i.test(l)).slice(-20).join("\n"));
    console.log(`env dir kept: ${h2.directory}`);
  }
} finally {
  if (h2 !== undefined) await stopHost(h2);
  await stopHost(h1);
}
