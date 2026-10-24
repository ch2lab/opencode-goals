// §51 真宿主验证批（2026-10-21 裁定：check-in 提醒附带在飞任务名单——不封顶、
// 只要 ID + 运行时长、不要 command）：在【隔离真实宿主】上验证
//   1. 后台 shell 在飞 + 边界 arm → checkInDelaySec 后 check-in 注入
//   2. 注入的 check-in 消息实带名单：shell ID + (运行时长)，不含 command 文本
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-checkin.ts

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const CHECK_TIMEOUT_MS = 120_000;
const CHECKIN_DELAY_SEC = 15; // plugin option, injected below — the reminder fires fast

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
  console.log(`[verify-checkin] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.VERIFY_KEEP_DIR === "1",
    // Shorten the check-in window + speed up the watchdog tick (plugin options
    // override the repo-default build).
    config: {
      plugins: [
        { package: REPO_ROOT, options: { checkInDelaySec: CHECKIN_DELAY_SEC, watchdogTickMs: 2000 } },
      ],
    },
  });
  console.log(`[verify-checkin] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

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
  const checkinMessage = async (): Promise<string | undefined> => {
    const msgs = await host.api.context(S);
    for (const m of msgs) {
      const t = String(m?.text ?? "");
      if (t.includes("Background check-in")) return t;
    }
    return undefined;
  };

  // K0: set the goal (kick turn) — countdown framing so the model never completes.
  const stSet = await host.api.command(
    S,
    "goal",
    "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 5",
  );
  check("K0: /goal set accepted", stSet >= 200 && stStatus(stSet), { status: stSet });
  check("K1: session idle after the kick turn", await waitUntil(idle, CHECK_TIMEOUT_MS, "K1: idle"));

  // K2: fire a background shell (the host spawns it server-side, attached to S).
  // NOTE: api.shellList() returns RAW host JSON — sessionID nests under metadata
  // (hostapi.normalizeShells is the plugin's view, not this raw API).
  const findRunningShell = async () => {
    const list = (await host.api.shellList()) as Array<{ id?: string; status?: string; metadata?: { sessionID?: string } }>;
    return list.find((e) => e?.metadata?.sessionID === S && e?.status === "running");
  };
  await host.api.sessionShellFire(S, "sleep 90");
  const found = await waitUntil(async () => (await findRunningShell()) !== undefined, 30_000, "K2: shell running");
  const runningShell = await findRunningShell();
  check("K2: background shell running in the host shell store", found && runningShell !== undefined, {
    shell: runningShell ? { id: runningShell.id, status: runningShell.status } : undefined,
  });

  // K3: a prompt turn ends IN FLIGHT (the sleep shell) → the boundary arms the
  // one-shot check-in (checkInDelaySec later).
  await host.api.prompt(
    S,
    "Automated goal-loop test. Reply with ONLY the next countdown integer per the goal objective. " +
      "Do NOT call any tool — especially never goal_complete, goal_block, goal_pause, goal_wait or goal_next_step.",
  );
  check("K3: prompt turn ran and the session went idle (boundary armed the check-in)", await waitUntil(idle, CHECK_TIMEOUT_MS, "K3: idle after prompt"));

  // K4: the check-in fires and its message carries the roster — shell id +
  // elapsed time, NO command text (2026-10-21 ruling: uncapped, id + elapsed only).
  const fired = await waitUntil(async () => (await checkinMessage()) !== undefined, CHECK_TIMEOUT_MS, "K4: check-in fired");
  const text = await checkinMessage();
  check("K4: check-in fired (Background check-in message delivered)", fired, { present: text !== undefined });
  if (runningShell !== undefined && text !== undefined) {
    check("K4b: the roster lists the running shell by ID", text.includes(runningShell.id ?? ""), { text: text.slice(0, 400) });
    check("K4c: the roster carries an elapsed time", /In flight now[\s\S]*?\d+(?:m\s?\d+)?s\)/.test(text), { text: text.slice(0, 400) });
    check("K4d: NO command text in the reminder (the ruling)", !text.includes("sleep 90"), { text: text.slice(0, 400) });
  } else if (runningShell === undefined || text === undefined) {
    check("K4b: roster assertions skipped (no shell or no message)", false, { shell: runningShell?.id, message: text });
  }

  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

function stStatus(st: number): boolean {
  return st >= 200 && st < 300;
}

main().catch((err) => {
  console.error("[verify-checkin] fatal:", err);
  process.exit(2);
});
