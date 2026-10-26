// §57 真宿主验证批（2026-10-24 裁定：goal_wait 到期 = 无条件"wait 时间到"唤醒）：
// 在【隔离真实宿主】上验证
//   1. 模型调用 goal_wait(1) 结束回合后，会话完全空闲（事故形态：无在飞、无边界）
//   2. ~60s 后（窗口 + tick 2s）必须见到恰好一条 "Goal wait period ended" 唤醒
//   3. 决策日志出现 `watchdog` / "watchdog goal_wait expiry" 行
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-wait.ts

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const WAIT_TIMEOUT_MS = 120_000; // 60s window + 2s tick + generous margin
const ONE_SHOT_GRACE_MS = 20_000; // after the first wake: no second one may appear

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(1000);
  }
  return false;
}

async function main(): Promise<void> {
  const provider = await labProvider(); // throws with a clear message when env is unset
  console.log(`[verify-wait] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.VERIFY_KEEP_DIR === "1",
    // Fast watchdog tick (the deadline's heartbeat); the check-in window is
    // irrelevant here (no in-flight work by design — the incident shape).
    config: {
      plugins: [
        {
          package: REPO_ROOT,
          // watchdogTickMs 2000 — fast deadline heartbeat; stallLimit 100 — the
          // countdown goal's pure-text replies must not self-stall mid-test.
          options: { watchdogTickMs: 2000, stallLimit: 100 },
        },
      ],
    },
  });
  console.log(`[verify-wait] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

  // The plugin's HTTP data plane (shell store / active map / inbox) resolves
  // the host through state/opencode/service.json — a bare `serve` never writes
  // it. Without it every boundary query fails ("host context dead") and the
  // boundary is SKIPPED: W6c's "zero wakes" would pass for the WRONG reason
  // (the quiet-window hold never executes). Write the host's own registration.
  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));

  const S = await host.api.createSession();
  const idle = async (): Promise<boolean> => {
    try {
      return (await host.api.sessionActive())[S] !== "running";
    } catch {
      return true; // query failure must not wedge the run
    }
  };
  const expiryMessages = async (): Promise<string[]> => {
    const msgs = await host.api.context(S);
    const out: string[] = [];
    for (const m of msgs) {
      const t = String(m?.text ?? "");
      if (t.includes("Goal wait period ended")) out.push(t);
    }
    return out;
  };

  // W0: set the goal (kick turn). --turns 1000: with the service.json registry
  // the boundaries actually arbitrate (no more "host context dead" skips), so
  // the countdown loop runs autonomously and would burn a 20-turn cap mid-test.
  const stSet = await host.api.command(S, "goal", "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 1000");
  check("W0: /goal set accepted", stSet >= 200, { status: stSet });
  check("W1: session idle after the kick turn", await waitUntil(idle, 90_000));

  // W2: the model declares a 1-minute wait and ends its turn — then the
  // session is FULLY IDLE: no in-flight shells, no subtasks, no queue.
  // This is the parked shape of the 2026-10-24 incident (plus the §57 fix:
  // the deadline must now wake the loop on its own).
  await host.api.prompt(
    S,
    "Automated goal-loop test. Call the goal_wait tool with minutes set to 1 AND set the background flag to true " +
      "(this keeps the call non-blocking). " +
      "After the tool returns, reply with exactly: wait armed — and stop. " +
      "Do NOT call any other tool and do NOT call goal_set/goal_complete/goal_block.",
  );
  check("W2: session idle after the goal_wait turn", await waitUntil(idle, 90_000));

  // W3: the deadline wake lands on its own — ~60s window + 2s tick.
  const saw = await waitUntil(async () => (await expiryMessages()).length >= 1, WAIT_TIMEOUT_MS);
  const first = (await expiryMessages())[0] ?? "";
  check("W3: 'Goal wait period ended' wake fired at the deadline (unconditional — session fully idle)", saw, {
    text: first.slice(0, 300),
    tail: saw ? undefined : host.stdoutTail().slice(-300),
  });
  await sleep(ONE_SHOT_GRACE_MS);
  const all = await expiryMessages();
  check("W4: ONE-SHOT — no second expiry wake within the grace window", all.length === 1, { count: all.length });

  // W5: the decision log carries the watchdog line (the 129 "silent no-op"
  // anti-pattern: a line = a decision actually made).
  const decDir = join(process.env.TEMP ?? "C:\\Windows\\Temp", "opencode-goal");
  const decPath = join(decDir, `decisions-${host.pid}.jsonl`);
  let line: unknown = undefined;
  try {
    const lines = readFileSync(decPath, "utf8").split("\n").filter(Boolean);
    line = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .find((e) => e?.sessionID === S && e?.decision === "watchdog" && String(e?.reason).includes("goal_wait expiry"));
  } catch {
    // no file yet (log writes are best-effort) — the check below reports it
  }
  check("W5: decision log line 'watchdog: goal_wait expiry' for the session", line !== undefined, {
    line,
    dir: readdirSync(decDir).filter((f) => f.startsWith(`decisions-${host.pid}`)),
  });

  // W6-W8: the 129 2026-10-25 STORM shape (spec §59): the model calls
  // goal_wait, its turn ENDS (the gate-0 boundary), and nothing may wake the
  // loop until the deadline. Pre-fix: every idle boundary WAKE'd the model
  // (boundary in-flight 0), which re-called goal_wait — 25 continuations in
  // ~2 minutes. Assert: quiet window silent → exactly one expiry at the
  // deadline → quiet-window hold line in the decision log.
  const { Database } = await import("bun:sqlite");
  const dbPath = join(host.directory, "data", "opencode", "opencode.db");
  const readGoal = (): { waitUntil?: number } | undefined => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query("SELECT value FROM kv WHERE key LIKE ?")
        .all(`%${S}%`) as Array<{ value: string }>;
      for (const r of rows) {
        try {
          const g = JSON.parse(r.value) as { status?: string; waitUntil?: number };
          if (g.status === "active") return g;
        } catch {
          // keep scanning
        }
      }
    } finally {
      db.close();
    }
    return undefined;
  };
  const activityCount = async (): Promise<number> => {
    const msgs = await host.api.context(S);
    let n = 0;
    for (const m of msgs) {
      const t = String(m?.text ?? "");
      if (t.includes("Goal wait period ended")) continue; // counted separately
      n++;
    }
    return n;
  };
  const quietStart = Date.now();
  await host.api.prompt(
    S,
    "Automated goal-loop test. Call the goal_wait tool with minutes set to 2 AND set the background flag to true " +
      "(this keeps the call non-blocking). " +
      "After the tool returns, reply with exactly: waiting — and stop. " +
      "Do NOT call any other tool and do NOT call goal_set/goal_complete/goal_block.",
  );
  check("W6a: session idle after the goal_wait(2m) turn", await waitUntil(idle, 90_000));
  const baseActivity = await activityCount(); // baseline AFTER the wait turn's own messages landed
  const baseExpiry = (await expiryMessages()).length; // the W2-window expiry is still in context — delta, not absolute
  const deadline = readGoal()?.waitUntil;
  check("W6b: persisted goal_wait deadline >= 90s out (test not degenerate)", (deadline ?? 0) - quietStart >= 90_000, {
    deadline,
    quietStart,
  });
  if (deadline !== undefined) {
    // Mid-window silence: the session must NOT gain a single message before
    // the deadline (a storm wake would show up as a model turn here).
    const midQuiet = await waitUntil(async () => (await activityCount()) > baseActivity, Math.max(2000, deadline - quietStart - 40_000));
    check("W6c: QUIET — zero loop wakes inside the goal_wait window", !midQuiet, {
      activity: midQuiet ? (await activityCount()) - baseActivity : 0,
    });
    // The deadline wake lands (one-shot, exactly one).
    const msToDeadline = deadline - Date.now();
    if (msToDeadline > 0) await sleep(msToDeadline + 5_000); // wait past the deadline (+tick margin)
    const sawExp = await waitUntil(async () => (await expiryMessages()).length >= 1, 20_000);
    await sleep(20_000);
    const nExp = (await expiryMessages()).length;
    check("W6d: ONE expiry wake at the deadline", sawExp && nExp === baseExpiry + 1, { count: nExp, base: baseExpiry });
  }
  // W7: the decision log shows a quiet-window HOLD for this window (either
  // gate shape — gate=0 "quiet window (goal_wait until …)" or gate>0 "in-flight,
  // quiet window" when the host queued something on the turn).
  const quietHold = readFileSync(decPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find(
      (e) =>
        e?.sessionID === S &&
        e?.decision === "hold" &&
        String(e?.reason).includes("quiet window") &&
        Date.parse(String(e?.ts)) >= quietStart,
    );
  check("W7: decision log line 'hold: … quiet window' (after the goal_wait turn)", quietHold !== undefined, {
    line: quietHold,
    holds: readFileSync(decPath, "utf8")
      .split("\n")
      .filter((l) => l.includes(`"sessionID":"${S}"`))
      .slice(-6),
  });
  // W8/W9: §60 BLOCKING default (2026-10-26 ruling) — a bare goal_wait call
  // BLOCKS the turn: W8 the full window (host-side sleep clock visible in the
  // shell store mid-wait), W9 an early return on a user message enqueued
  // mid-wait (NOT the 5-minute deadline).
  const readDecisions = (): Array<Record<string, unknown>> =>
    readFileSync(decPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined as unknown as Record<string, unknown>;
        }
      })
      .filter((e) => e !== undefined);

  const t8 = Date.now();
  await host.api.prompt(
    S,
    "Automated goal-loop test. Call the goal_wait tool with minutes set to 1 and NO other parameters " +
      "(do NOT set background). This call BLOCKS until it returns — wait for it. " +
      "After it returns, reply with exactly: blocking wait complete — and stop. " +
      "Do NOT call any other tool and do NOT call goal_set/goal_complete/goal_block.",
  );
  // Mid-wait (~15s): the turn is still RUNNING (blocked inside the tool call)
  // and the clock shell (`sleep 60`) is live in the host shell store.
  while (Date.now() - t8 < 15_000) await sleep(1000);
  const t8active = (await host.api.sessionActive())[S];
  const t8shells = (await host.api.shellList()) as Array<Record<string, unknown>>;
  const t8clock = t8shells.find((s) => String(s?.command ?? "").includes("sleep"));
  check("W8a: turn STILL RUNNING mid-wait (blocking goal_wait)", t8active === "running", { active: t8active });
  check("W8b: host-side clock shell live in the shell store mid-wait", t8clock !== undefined, {
    shells: t8shells.map((s) => `${s?.id}:${s?.command}`),
  });
  const t8saw = await waitUntil(async () => {
    const msgs = (await host.api.context(S)) as Array<Record<string, unknown>>;
    return msgs.some((m) => String(m?.text ?? "").includes("blocking wait complete"));
  }, WAIT_TIMEOUT_MS);
  const t8secs = (Date.now() - t8) / 1000;
  check("W8c: the wait really blocked ~60s before the turn finished", t8saw && t8secs >= 55, {
    seconds: Math.round(t8secs),
    tail: t8saw ? undefined : host.stdoutTail().slice(-300),
  });
  const t8armed = readDecisions().find(
    (e) => e.sessionID === S && e.decision === "wait" && String(e.reason).includes("armed blocking"),
  );
  const t8resolved = readDecisions().find(
    (e) => e.sessionID === S && e.decision === "wait" && String(e.reason).includes("resolved (deadline"),
  );
  check("W8d: decision log fingerprint — 'armed blocking' + 'resolved (deadline…)'", t8armed !== undefined && t8resolved !== undefined, {
    armed: t8armed?.reason,
    resolved: t8resolved?.reason,
  });

  const t9 = Date.now();
  await host.api.prompt(
    S,
    "Automated goal-loop test. Call the goal_wait tool with minutes set to 5 and NO other parameters. " +
      "It BLOCKS — wait for its return, then reply with exactly: <the tool's result text> — and stop. " +
      "Do NOT call any other tool and do NOT call goal_set/goal_complete/goal_block.",
  );
  // ~20s in: still blocked. Then a USER message arrives — the enqueued event
  // must return the wait IMMEDIATELY (the tool returns "wait interrupted").
  while (Date.now() - t9 < 20_000) await sleep(1000);
  const t9active = (await host.api.sessionActive())[S];
  await host.api.prompt(
    S,
    "Automated test user message: reply with exactly: user interrupted the wait — and stop. Do not call any tool.",
  );
  const t9saw = await waitUntil(async () => {
    const msgs = (await host.api.context(S)) as Array<Record<string, unknown>>;
    return msgs.some((m) => String(m?.text ?? "").includes("user interrupted the wait"));
  }, 120_000);
  const t9secs = (Date.now() - t9) / 1000;
  check("W9a: turn was RUNNING (blocked in goal_wait(5m)) when the user message was sent", t9active === "running", {
    active: t9active,
  });
  check("W9b: the user message returned the wait EARLY — the turn finished in well under 5 minutes", t9saw && t9secs < 150, {
    seconds: Math.round(t9secs),
    tail: t9saw ? undefined : host.stdoutTail().slice(-300),
  });
  const t9resolved = readDecisions().find(
    (e) => e.sessionID === S && e.decision === "wait" && String(e.reason).includes("resolved (user"),
  );
  check("W9c: decision log fingerprint — 'wait: resolved (user…)'", t9resolved !== undefined, { line: t9resolved?.reason });
  const t9shells = (await host.api.shellList()) as Array<Record<string, unknown>>;
  check("W9d: the clock shell was killed (no 'sleep 300' left in the store)", !t9shells.some((s) => String(s?.command ?? "").includes("sleep 300")), {
    shells: t9shells.map((s) => `${s?.id}:${s?.command}`),
  });

  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error("[verify-wait] fatal:", err);
  process.exit(2);
});
