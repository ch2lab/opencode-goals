// §52 真宿主验证批（2026-10-21 裁定：前台 shell 超时自动转后台）：在【隔离真实宿主】上验证
//   1. 模型前台（阻塞式）跑一个长 shell → 超过 foregroundShellBackgroundMs（注入 5s）
//   2. 插件调 POST /api/session/:id/background（宿主 Ctrl+B 服务端动作）
//   3. 断言：宿主注入 "moved to the background" synthetic（turn 解除阻塞）、
//      shell 进程**仍在运行**（转后台 = 保活，不是杀）、循环恢复边界节奏（决策日志新行）
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-shellbg.ts

import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const CAP_MS = 5_000; // plugin option, injected below (30 min default in production)
const CHECK_TIMEOUT_MS = 120_000;

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
  console.log(`[verify-shellbg] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.VERIFY_KEEP_DIR === "1",
    config: {
      plugins: [
        { package: REPO_ROOT, options: { foregroundShellBackgroundMs: CAP_MS, checkInDelaySec: 300 } },
      ],
    },
  });
  console.log(`[verify-shellbg] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

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

  // G0: set the goal, wait for the kick turn to finish.
  const stSet = await host.api.command(
    S,
    "goal",
    "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 5",
  );
  check("G0: /goal set accepted", stSet >= 200 && stSet < 300, { status: stSet });
  check("G1: session idle after the kick turn", await waitUntil(idle, CHECK_TIMEOUT_MS, "G1: idle"));

  // G2: the model runs a LONG foreground shell (blocking — not background).
  await host.api.prompt(
    S,
    "Automated goal-loop test. Use your shell tool to run exactly: sleep 120 — in the FOREGROUND " +
      "(blocking; do NOT use background mode) — then reply with the next countdown integer. " +
      "Do NOT call any goal_* tool.",
  );
  const sawShell = await waitUntil(async () => (await runningShell()) !== undefined, CHECK_TIMEOUT_MS, "G2: shell running");
  const shell = await runningShell();
  check("G2: the model's foreground shell is running in the host shell store", sawShell && shell !== undefined, {
    shell: shell ? { id: shell.id, background: shell.metadata?.background ?? false } : undefined,
  });
  if (shell?.metadata?.background === true) {
    check("G2b: the shell is FOREGROUND (the model honored the instruction)", false, { shell });
  }

  // G3: the plugin's scan (30s period) moves it to background after the cap.
  const pluginLogged = await waitUntil(async () => host.stdoutTail().includes("§52 foreground shell"), CHECK_TIMEOUT_MS, "G3: plugin log line");
  check("G3: plugin backgrounded the over-cap foreground shell (log line)", pluginLogged, {
    tail: host.stdoutTail().slice(-300),
  });
  const tAfterBg = new Date().toISOString(); // G6 anchor: a boundary line AFTER this

  // G4: the host injected its "moved to the background" synthetic — the blocked
  // turn is released (this IS the "wake the session to check" — host-side).
  const hasSynthetic = await waitUntil(async () => {
    const msgs = await host.api.context(S);
    return msgs.some((m: any) => String(m?.text ?? "").includes("moved to the background"));
  }, CHECK_TIMEOUT_MS, "G4: host synthetic");
  check("G4: host-injected 'moved to the background' synthetic in the session", hasSynthetic);

  // G5: the shell KEEPS RUNNING (background = observation, not kill).
  const stillRunning = await runningShell();
  check("G5: the shell is still running after backgrounding (work preserved)", stillRunning !== undefined, {
    shell: stillRunning ? { id: stillRunning.id, background: stillRunning.metadata?.background ?? false } : undefined,
  });

  // G6: the loop recovers — the released turn ends, a boundary fires (decision line).
  const recovered = await waitUntil(async () => {
    const d = await decisions();
    return d.some((l) => typeof l.ts === "string" && (l.ts as string) > tAfterBg);
  }, CHECK_TIMEOUT_MS, "G6: boundary after backgrounding");
  check("G6: a new boundary/decision line landed after the backgrounding (loop alive)", recovered, {
    decisions: (await decisions()).map((d) => `${d.decision}@${d.ts}`),
  });

  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

(async () => {
  await main();
})().catch((err) => {
  console.error("[verify-shellbg] fatal:", err);
  process.exit(2);
});
