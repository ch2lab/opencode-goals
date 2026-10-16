// Task 13 diagnostics (spec §14): host-restart experiment — kill the service
// while a goal is waiting on a long-running shell (session idle, turn over),
// restart the SAME isolated env, and record:
//   - where the shell record went (still "running"? gone? cancelled?)
//   - whether the host delivered a cancellation notice to the session
//   - what the plugin's start-reconciliation did (goal state + wake?)
//
// Manual reading only — NOT part of `bun test`.
//
//   bun run scripts/diagnostics-restart.ts [--keep-dir]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHost, readLogFile, TMP_BASE, labProvider, type IsolatedHost, type ProviderSpec } from "./host.ts";

const keepDir = process.argv.includes("--keep-dir");
const dir = join(TMP_BASE, `ocgoal-restart-${Date.now()}`);
const port1 = 47600 + Math.floor(Math.random() * 100);

// Lab credentials from env only (OPENCODE_LAB_PROVIDER_BASE / _KEY).
let provider: ProviderSpec;
try {
  provider = await labProvider();
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

// Orphan-host guard (Task-13 review fix): both hosts are stopped on ANY exit
// path (including the mid-scenario kill + a throw before/after h2 boots).
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
console.log(`host1 up on ${h1.baseUrl} (pid ${h1.pid})`);
try {
  const s = await h1.api.createSession();
  console.log(`session=${s}`);
  // The goal text asks the model to idle, so its first turn (triggered by the
  // goalControl synthetic) ends quickly and the session goes idle waiting on
  // the 300s shell — the "idle wait" case this experiment is about.
  const c1 = await h1.api.command(s, "goal", "set wait for the long-running shell to finish; do nothing else");
  console.log(`/goal set → HTTP ${c1}`);
  await Bun.sleep(1000);
  // Fire-and-forget: on 2.0.29 the session shell POST only RESPONDS when the
  // shell EXITS — a 300s shell would block the await for 5 minutes. The host
  // spawns the shell immediately; we observe it via shellList instead.
  void h1.api
    .sessionShell(s, "Write-Output still-running; Start-Sleep -Seconds 300")
    .then((st) => console.log(`session.shell (sleep 300) responded → HTTP ${st}`), (e) =>
      console.log(`session.shell (sleep 300) did not respond in time (${(e as Error).name}) — expected while it runs`),
    );
  await Bun.sleep(3000);
  const [shell] = await h1.api.shellList();
  console.log(`waiting shell: ${JSON.stringify(shell)}`);

  console.log(`\n-- killing the service (pid ${h1.pid}) --`);
  await stopHost(h1);
  h2 = await startHost({ dir, keepDir: true, port: port1 + 1, provider });
  console.log(`-- restarted on ${h2.baseUrl} --`);
  await Bun.sleep(8000);

  const shells = await h2.api.shellList();
  const gone = shell ? await h2.api.shellGet(shell.id) : undefined;
  const ctx = JSON.stringify(await h2.api.context(s));
  const g = await h2.api.goalsGet(s);

  console.log(`\n[1] shell record after restart: list=${JSON.stringify(shells)}`);
  console.log(`    shellGet(old id) → status=${gone?.status} data=${JSON.stringify(gone?.data)}`);
  console.log(`[2] cancellation notice in context: ${/cancelled because the server restarted/i.test(ctx)}`);
  console.log(`    context notice lines: ${ctx.includes("restarted") ? ctx.slice(Math.max(0, ctx.indexOf("restart") - 200), ctx.indexOf("restart") + 200).replace(/"/g, "'") : "(none)"}`);
  console.log(`[3] goal after reconciliation: status=${g.output?.status} waitingShells=${JSON.stringify(g.output?.waitingShells)} continuations=${g.output?.continuations}`);
  console.log(`    reconciliation wake injected (goalWake in context): ${ctx.includes("goalWake")}`);
  console.log(`\nVERDICT: ${shell && gone?.status === 404 && /cancelled/i.test(ctx)
    ? "shell record dropped + host cancellation notice delivered (host took the idle case as documented)"
    : "see lines above for which recovery happened"}`);

  if (keepDir) {
    console.log(`\n--- host log tail (reconcile/wake lines) ---`);
    const log = await readLogFile(h2, 400);
    console.log(log.split("\n").filter((l) => /goal|wake|reconcil|inbox|shell/i.test(l)).slice(-20).join("\n"));
    console.log(`env dir kept: ${h2.directory}`);
  }
} finally {
  if (h2 !== undefined) await stopHost(h2);
  await stopHost(h1);
}
