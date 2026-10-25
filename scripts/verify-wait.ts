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

  // W0: set the goal (kick turn).
  const stSet = await host.api.command(S, "goal", "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 20");
  check("W0: /goal set accepted", stSet >= 200, { status: stSet });
  check("W1: session idle after the kick turn", await waitUntil(idle, 90_000));

  // W2: the model declares a 1-minute wait and ends its turn — then the
  // session is FULLY IDLE: no in-flight shells, no subtasks, no queue.
  // This is the parked shape of the 2026-10-24 incident (plus the §57 fix:
  // the deadline must now wake the loop on its own).
  await host.api.prompt(
    S,
    "Automated goal-loop test. Call the goal_wait tool with minutes set to 1. " +
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
        .all(`${S}%`) as Array<{ value: string }>;
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
    "Automated goal-loop test. Call the goal_wait tool with minutes set to 2. " +
      "After the tool returns, reply with exactly: waiting — and stop. " +
      "Do NOT call any other tool and do NOT call goal_set/goal_complete/goal_block.",
  );
  check("W6a: session idle after the goal_wait(2m) turn", await waitUntil(idle, 90_000));
  const baseActivity = await activityCount(); // baseline AFTER the wait turn's own messages landed
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
    const sawExp = await waitUntil(async () => (await expiryMessages()).length >= 1, 30_000);
    await sleep(20_000);
    const nExp = (await expiryMessages()).length;
    check("W6d: ONE expiry wake at the deadline", sawExp && nExp === 1, { count: nExp });
  }
  // W7: the decision log shows the quiet-window HOLD (not a storm of wakes).
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
        String(e?.reason).startsWith("quiet window (goal_wait"),
    );
  check("W7: decision log line 'hold: quiet window (goal_wait …)'", quietHold !== undefined, { line: quietHold });
  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error("[verify-wait] fatal:", err);
  process.exit(2);
});
