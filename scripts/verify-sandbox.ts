// Live sandbox drill (2026-10-17): reproduces the 129 field incidents on a
// FULLY ISOLATED desktop host (2.0.29 CLI) with the real lab LLM, against the
// PACKAGED 1.0.5 artifact (unpacked tarball, local directory package spec —
// offline, no npm network).
//
// Field incidents under test:
//  1. Duplicate boundary wakes + inflated used.turns (hot-reload churn →
//     concurrent plugin loads; 129: goalTurn ×2-3, cap 10 burned in ~10
//     model turns).
//  2. Boundary wakes firing WHILE a session shell is running (the fast path
//     must stay silent: boundary during shell-wait = re-arm watchdog only).
//
// Manual/live use only (NOT a bun test, no .test suffix):
//   set OPENCODE_LAB_PROVIDER_BASE / OPENCODE_LAB_PROVIDER_KEY
//   bun run scripts/verify-sandbox.ts
//
// Phases:
//  A  boot isolated host + load artifact plugin → ACTIVE
//  B  set goal (turns 8) + create probe shell (sleep 150) → waitingShells armed
//  C  user prompt → full model turn → boundary while shell running → NO wake
//  D  config churn ×2 mid-wait (host hot-reload, multi-load) → still no wake,
//     goal intact, watchdog re-armed, plugin active
//  E  shell exits → exactly ONE exit-result wake → model completes the goal
//  F  invariants: wake count == used.turns (1:1), exit wake unique,
//     "loading plugin" count in host log (multi-load evidence)
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "bun";
import { REPO_ROOT, TMP_BASE, labProvider, startHost, readLogFile } from "./host.ts";

const TARBALL = join(REPO_ROOT, ".publish-staging", "ch2lab-opencode-goals-1.0.5.tgz");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // -- artifact: unpack the packaged tarball (offline install) -------------
  if (!existsSync(TARBALL)) {
    console.error(`tarball not found: ${TARBALL} — run: bun run scripts/publish.mjs pack`);
    process.exit(2);
  }
  const pkgParent = join(TMP_BASE, `ocgoal-sbx-pkg-${Date.now()}`);
  await mkdir(join(pkgParent, "pkg"), { recursive: true });
  const tx = Bun.spawn(["tar", "xzf", TARBALL, "-C", join(pkgParent, "pkg"), "--strip-components=1"]);
  await tx.exited;
  const pkgDir = join(pkgParent, "pkg");
  const ver = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as { version: string };
  console.log(`artifact: ${ver.version} unpacked to ${pkgDir}`);

  // -- boot isolated host with the artifact + lab LLM -----------------------
  const provider = await labProvider(); // throws with a clear message when env missing
  const host = await startHost({
    provider,
    config: { plugins: [{ package: pkgDir, options: {} }] },
    keepDir: true,
    waitMs: 60_000,
  });
  console.log(`host up: ${host.baseUrl} (dir kept: ${host.directory})`);

  try {
    // A: plugin ACTIVE
    let active = false;
    for (let i = 0; i < 30 && !active; i++) {
      const ps = await host.api.plugins();
      const p = (ps ?? []).find((x: any) => x?.id === "opencode-goal");
      active = p?.state?.status === "active";
      if (!active) await sleep(1000);
    }
    check("A: plugin ACTIVE from local artifact", active);
    if (!active) throw new Error("plugin never became active");

    const sessionId = await host.api.createSession();
    console.log(`session: ${sessionId}`);

    // B: set goal + create the probe shell
    const rSet = await host.api.command(sessionId, "goal", "set sandbox-drill: a probe shell (sleep 150, prints sandbox-sleep-done on exit) runs in this session. When it EXITS, call goal_complete with evidence quoting its final output line sandbox-sleep-done. Do not complete before the exit. --turns 8");
    // The command endpoint answers 204 No Content on success (2.0.29).
    check("B1: /goal set accepted (http 2xx)", rSet >= 200 && rSet < 300, `http=${rSet}`);
    if (rSet < 200 || rSet >= 300) throw new Error(`/goal set rejected: http=${rSet}`);
    // Fire-and-forget: the session-shell POST is held open by the host for
    // the shell's lifetime (streaming attach), so it must not be awaited
    // (the api's 15s timeout would abort mid-shell). Verify via /api/shell.
    await host.api.sessionShellFire(sessionId, "sleep 150 && echo sandbox-sleep-done");
    let listed = false;
    for (let i = 0; i < 30 && !listed; i++) {
      const shells = (await host.api.shellList()) ?? [];
      listed = shells.some((x: any) => typeof x.command === "string" && x.command.includes("sandbox-sleep-done"));
      if (!listed) await sleep(500);
    }
    check("B2: probe shell registered in /api/shell (fire-and-forget attach POST)", listed);
    if (!listed) throw new Error("probe shell never appeared in /api/shell");

    let armed = 0;
    for (let i = 0; i < 20; i++) {
      const g = await host.api.goalsGet(sessionId);
      const rec = g.output as any;
      armed = rec?.waitingShells?.length ?? 0;
      if (armed > 0) break;
      await sleep(500);
    }
    check("B3: waitingShells armed from session.shell.started (2.0.29 durable family)", armed > 0, `waitingShells=${armed}`);

    // C: one full model turn → boundary while the shell is running → silence
    const evFile = await host.startEventCapture(1500);
    const rPrompt = await host.api.prompt(sessionId, "The probe shell is still running. In one short sentence confirm you are waiting for it. Do not complete the goal.");
    check("C1: user prompt accepted", rPrompt !== undefined);
    // wait for the turn to finish (execution.succeeded in the event stream).
    // Window is generous on purpose: the lab LLM's first turn (triggered by
    // the /goal command) took 155s in the first run — the 90s window of that
    // run expired mid-turn and produced a false C2 FAIL.
    let turnDone = false;
    for (let i = 0; i < 300 && !turnDone; i++) {
      const t = await readFile(evFile, "utf8").catch(() => "");
      turnDone = t.includes("session.execution.succeeded");
      if (!turnDone) await sleep(1000);
    }
    check("C2: model turn completed (execution.succeeded observed)", turnDone);
    const ctx1 = (await host.api.context(sessionId)) ?? [];
    const wakes1 = ctx1.filter((m: any) => typeof m.text === "string" && m.text.startsWith("[GOAL"));
    check("C3: NO ordinary boundary wake while shell running (fast path silent)", wakes1.length === 0, `wake msgs so far: ${wakes1.length}`);

    // D: config churn ×2 (semantic option changes → host hot-reload, multi-load)
    const cfg = join(host.directory, "config", "opencode", "opencode.jsonc");
    const j = JSON.parse(await readFile(cfg, "utf8"));
    j.plugins[0].options = { wakeDetail: "slim" };
    await writeFile(cfg, JSON.stringify(j, null, 2));
    console.log("  churn #1 (options → wakeDetail:slim); waiting 20s for hot reload…");
    await sleep(20_000);
    const j2 = JSON.parse(await readFile(cfg, "utf8"));
    j2.plugins[0].options = { wakeDetail: "slim", judgeEnabled: false };
    await writeFile(cfg, JSON.stringify(j2, null, 2));
    console.log("  churn #2 (options += judgeEnabled:false); waiting 20s…");
    await sleep(20_000);
    const ps2 = await host.api.plugins();
    const p2 = (ps2 ?? []).find((x: any) => x?.id === "opencode-goal");
    check("D1: plugin still ACTIVE after double hot-reload churn", p2?.state?.status === "active");
    const g2 = await host.api.goalsGet(sessionId);
    const rec2 = g2.output as any;
    check("D2: goal survived churn (record readable, still active)", rec2?.status === "active", `status=${rec2?.status}`);
    check("D3: watchdog re-armed after takeover reconcile", (rec2?.waitingShells?.length ?? 0) > 0, `waitingShells=${rec2?.waitingShells?.length}`);
    const ctx2 = (await host.api.context(sessionId)) ?? [];
    const wakes2 = ctx2.filter((m: any) => typeof m.text === "string" && m.text.startsWith("[GOAL"));
    check("D4: still NO wake after churn boundaries (single consumer, fast path)", wakes2.length === 0, `wake msgs: ${wakes2.length}`);

    // E: shell exits (~150s after creation) → exactly ONE exit-result wake.
    // Primary check: the session.shell.ended event (its payload carries the
    // command). Fallback: a /api/shell row flipping to status "exited"
    // (Shell.Info.status — NOT state; the first run's E1 FAIL used a wrong
    // field guess and a command-matching find() that never matched).
    let exited = false;
    for (let i = 0; i < 180 && !exited; i++) {
      const t = await readFile(evFile, "utf8").catch(() => "");
      exited = t.includes("session.shell.ended") && t.includes("sandbox-sleep-done");
      if (!exited) {
        const shells = (await host.api.shellList()) ?? [];
        exited = shells.some(
          (x: any) => x?.status === "exited" && typeof x?.command === "string" && x.command.includes("sandbox-sleep-done"),
        );
      }
      if (!exited) await sleep(1000);
    }
    check("E1: probe shell exited", exited);
    let terminal = "";
    let finalUsed = 0;
    for (let i = 0; i < 120 && !terminal; i++) {
      const g = await host.api.goalsGet(sessionId);
      const rec = g.output as any;
      if (rec?.used?.turns) finalUsed = rec.used.turns;
      terminal = ["completed", "budget_limited", "stalled", "blocked", "cleared"].includes(rec?.status ?? "") ? (rec.status as string) : "";
      if (!terminal) await sleep(1000);
    }
    check("E2: goal reached a terminal state", terminal !== "", `status=${terminal}`);
    const ctx3 = (await host.api.context(sessionId)) ?? [];
    const exitWakes = ctx3.filter((m: any) => typeof m.text === "string" && m.text.includes("exited (exit"));
    check("E3: exactly ONE shell-exit result wake", exitWakes.length === 1, `exit wakes: ${exitWakes.length}`);

    // F: invariants
    const wakesAll = ctx3.filter((m: any) => typeof m.text === "string" && m.text.startsWith("[GOAL"));
    const turnStamps = wakesAll.map((m: any) => {
      const t = /turn (\d+)\/\d+/.exec(m.text);
      return t ? t[1] : "?";
    });
    const distinct = new Set(turnStamps).size;
    check("F1: boundary wakes are UNIQUE (no duplicate goalTurn — the 129 signature)", distinct === turnStamps.length && turnStamps.length === wakesAll.length, `stamps=[${turnStamps.join(",")}]`);
    check(
      "F2: used.turns == injected-wake count (boundary + exit; 1:1, no inflation — 129 was 34 vs 10)",
      finalUsed > 0 && finalUsed === wakesAll.length + exitWakes.length,
      `used.turns=${finalUsed}, boundary=${wakesAll.length}, exit=${exitWakes.length}`,
    );
    const logTail = await readLogFile(host, 400);
    const loads = (logTail.match(/loading plugin.*opencode-goal/g) ?? []).length;
    console.log(`  [INFO] "loading plugin" lines in log tail: ${loads} (multi-load churn evidence)`);
  } finally {
    host.stopEventCapture();
    await host.stop();
  }
  console.log(failures === 0 ? "\nSANDBOX DRILL: ALL PASS" : `\nSANDBOX DRILL: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error("sandbox drill aborted:", err);
  process.exit(3);
});
