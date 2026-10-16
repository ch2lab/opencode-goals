// Task 13 diagnostics (spec §14): callback loss experiment — run a script
// that is GUARANTEED to fail in the background of a goal-active session and
// record WHERE the callback chain breaks (if it does):
//   a) event layer: do shell.exited / session.shell.ended fire?
//   b) delivery layer: does the shell result become an inbox message?
//   c) wake: does the watchdog shell-exit wake reach the session context?
//
// Manual reading only — NOT part of `bun test`. ~50 lines of scenario on top
// of the shared isolated-host helper.
//
//   bun run scripts/diagnostics-callback.ts [--keep-dir]

import { readFile } from "node:fs/promises";
import { startHost, labProvider, type ProviderSpec } from "./host.ts";

const keepDir = process.argv.includes("--keep-dir");
// NOTE: the isolated host gets the lab model on purpose — a model-less host
// falls back to the built-in "exo-free" model, which is DEPRECATED on 2.0.29:
// the resulting failed session drain wedges the session (pending HTTP POSTs
// never respond). A working model keeps the drain resolvable.
// Credentials come from env only (OPENCODE_LAB_PROVIDER_BASE / _KEY — no
// committed defaults).
let provider: ProviderSpec;
try {
  provider = await labProvider();
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
const host = await startHost({ keepDir, provider });
// Orphan-host guard (Task-13 review fix): the host is stopped on ANY exit
// path — a mid-scenario throw must not leave the serve process behind.
let hostStopped = false;
const stopHost = async (): Promise<void> => {
  if (hostStopped) return;
  hostStopped = true;
  try {
    host.stopEventCapture();
    await host.stop();
  } catch {}
};
try {
  const s = await host.api.createSession();
  console.log(`session=${s}`);
  await host.api.command(s, "goal", "set observe the shell callback");
  await Bun.sleep(1000);

  const eventsFile = await host.startEventCapture(90);
  // guaranteed-fail script, session-scoped (the model's shell-tool path)
  const st = await host.api.sessionShell(s, "Write-Output about-to-fail; Start-Sleep -Seconds 2; exit 3");
  console.log(`session.shell create → HTTP ${st}`);
  await Bun.sleep(10_000);
  host.stopEventCapture();
  await Bun.sleep(500);

  const events = (await readFile(eventsFile, "utf8").catch(() => ""));
  const fam = (t: string) => events.includes(`"type":"${t}"`);
  const inbox = await host.api.inbox(s);
  const ctxText = JSON.stringify(await host.api.context(s));
  const shellSynthetic = ctxText.includes("shell command");

  console.log(`\n[a] event layer:`);
  console.log(`    shell.created=${fam("shell.created")}  session.shell.started=${fam("session.shell.started")}`);
  console.log(`    shell.exited=${fam("shell.exited")}   session.shell.ended=${fam("session.shell.ended")}`);
  for (const t of ["shell.exited", "session.shell.ended"]) {
    const line = events.split("\n").find((l) => l.includes(`"type":"${t}"`));
    if (line) console.log(`    ${t}: ${line.slice(0, 300)}`);
  }
  console.log(`[b] delivery layer: inbox items=${inbox.length} (types: ${JSON.stringify(inbox.map((i: any) => i.type))})`);
  console.log(`    session context contains shell-result synthetic: ${shellSynthetic}`);
  console.log(
    `[c] wake: goalWake in context=${ctxText.includes("goalWake")} — a wake reaching the context is EXPECTED here: the shell exit IS an execution boundary, ` +
      `and the watchdog shell-exit wake is delivered when the session can go idle; false only means "no wake reached context in this window"`,
  );
  console.log(`\nVERDICT: ${fam("shell.exited") && fam("session.shell.ended") && inbox.length > 0
    ? "event + delivery layers intact for a failing script (a context wake is normal — the shell exit is a boundary)"
    : "BROKEN — inspect the lines above for where the chain stops"}`);

  if (keepDir) console.log(`env dir kept: ${host.directory}`);
} finally {
  await stopHost();
}
