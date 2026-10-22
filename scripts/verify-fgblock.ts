// §54 真宿主验证批（2026-10-22 裁定：前台 shell 阻塞态显式化）：在【隔离真实宿主】上验证
// 前台（阻塞式）shell 长时运行时插件保持沉默——
//   1. 模型前台跑 sleep 100（阻塞 turn）
//   2. 阻塞期间（事件流静默是预期）：
//      - 无 "Background check-in" 消息（129 截图 bug：误发且只能排队）
//      - 无 §50 "liveness recheck" 自愈行（注入 livenessMs 30s + 扫描 15s——
//        旧行为会在 ~45s 伪造边界并武装 check-in，新行为 = 跳过该会话）
//      - 无 auto-backgrounded 决策行（cap 保持 30min 默认，本用例不转后台）
//   3. shell 结束后循环恢复：新的决策行落地（边界节奏回来）
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-fgblock.ts

import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const CAP_MS = 30 * 60 * 1000; // default — this case must NOT background
const LIVENESS_MS = 30_000; // injected: the §50 silence window (5 min in production)
const LIVENESS_CHECK_MS = 15_000; // injected: scan period (30s in production)
const BLOCK_MS = 100_000; // the model's foreground sleep
const CHECK_TIMEOUT_MS = 180_000;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(1000);
  }
  return false;
}

async function main(): Promise<void> {
  const provider = await labProvider(); // throws with a clear message when env is unset
  console.log(`[verify-fgblock] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.VERIFY_KEEP_DIR === "1",
    config: {
      plugins: [
        {
          package: REPO_ROOT,
          options: {
            foregroundShellBackgroundMs: CAP_MS,
            checkInDelaySec: 15,
            livenessMs: LIVENESS_MS,
            livenessCheckMs: LIVENESS_CHECK_MS,
          },
        },
      ],
    },
  });
  console.log(`[verify-fgblock] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));

  const S = await host.api.createSession();
  const idle = async (): Promise<boolean> => {
    try {
      return (await host.api.sessionActive())[S] !== "running";
    } catch {
      return true;
    }
  };
  const runningShell = async () => {
    const list = (await host.api.shellList()) as Array<{
      id?: string;
      status?: string;
      metadata?: { sessionID?: string; background?: boolean };
    }>;
    return list.find((e) => e?.metadata?.sessionID === S && e?.status === "running");
  };
  const decisions = async (): Promise<Record<string, unknown>[]> => {
    const dir = process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp";
    const raw = await readFile(join(dir, "opencode-goal", `decisions-${host.pid}.jsonl`), "utf8").catch(() => "");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== undefined && l.sessionID === S);
  };

  // F0: set the goal, wait for the kick turn to finish.
  const stSet = await host.api.command(
    S,
    "goal",
    "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 5",
  );
  check("F0: /goal set accepted", stSet >= 200 && stSet < 300, { status: stSet });
  check("F1: session idle after the kick turn", await waitUntil(idle, CHECK_TIMEOUT_MS, "F1: idle"));

  // F2: the model runs a LONG FOREGROUND shell (blocking — not background).
  await host.api.prompt(
    S,
    "Automated goal-loop test. Use your shell tool to run exactly: sleep 100 — in the FOREGROUND " +
      "(blocking; do NOT use background mode) — then reply with the next countdown integer. " +
      "Do NOT call any goal_* tool.",
  );
  const sawShell = await waitUntil(async () => (await runningShell()) !== undefined, CHECK_TIMEOUT_MS, "F2: shell running");
  const shell = await runningShell();
  check("F2: the model's foreground shell is running in the host shell store", sawShell && shell !== undefined, {
    shell: shell ? { id: shell.id, background: shell.metadata?.background ?? false } : undefined,
  });
  const tBlocked = Date.now(); // the block window starts now

  // F3: stay inside the blocked window long enough that the OLD behavior would
  // have fired (livenessMs 30s + scan 15s → recheck by ~45s; a recheck boundary
  // would have armed a 15s check-in → fired by ~60s).
  await sleep(75_000);
  const stillRunning = (await runningShell()) !== undefined;
  check("F3: still blocked inside the window (the shell is the blocker)", stillRunning, {
    shell: (await runningShell())?.id,
  });
  if (!stillRunning) {
    console.log("  (the shell exited early — the suppression window cannot be observed; F4-F6 still run)");
  }

  // F4: NO "Background check-in" message landed in the session during the block.
  const msgs = await host.api.context(S);
  const checkins = msgs.filter((m: any) => String(m?.text ?? "").includes("Background check-in"));
  check("F4: no 'Background check-in' while blocked on a foreground shell (the 129 screenshot bug)", checkins.length === 0, {
    count: checkins.length,
  });
  // F5: NO §50 liveness recheck (the expected silence is not a dead stream).
  check("F5: no §50 'liveness recheck' during the block (silence is expected, not a dead stream)", !host.stdoutTail().includes("liveness recheck"), {
    tail: host.stdoutTail().slice(-300),
  });
  // F6: no auto-backgrounding (cap = 30 min, the block is ~2 min).
  check("F6: no auto-backgrounding below the cap", !host.stdoutTail().includes("§52 foreground shell"), {
    tail: host.stdoutTail().slice(-300),
  });

  // F7: after the shell exits, the turn finishes, a boundary fires — the loop
  // recovers its rhythm (a new decision line after the block started).
  const recovered = await waitUntil(async () => {
    const d = await decisions();
    return d.some((l) => typeof l.ts === "string" && new Date(l.ts as string).getTime() >= tBlocked);
  }, CHECK_TIMEOUT_MS, "F7: post-block boundary");
  check("F7: a post-block decision line landed (the loop recovered its rhythm)", recovered, {
    decisions: (await decisions()).map((d) => `${d.decision}:${d.reason}`),
  });

  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

(async () => {
  await main();
})().catch((err) => {
  console.error("[verify-fgblock] fatal:", err);
  process.exit(2);
});
