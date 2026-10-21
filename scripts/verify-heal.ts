// §50 真宿主自愈验证批（2026-10-21）：在【隔离真实宿主】上验证事件循环自愈——
// 129 sm70 incident 的受控复现与恢复证明：
//   1. /goal set（kick turn 运行中）
//   2. 探针 OPENCODE_GOAL_KILL_STREAM=1：插件在首个 turn 开始处自杀一次事件
//      订阅（模拟宿主侧断流——129 的死法，但可控、可断言）
//   3. 断言：done 路径大声日志 + 重订阅；新订阅继续收事件：prompt → turn →
//      边界处理 → 注入 wake（决策日志实锤）→ 循环自治到 budget_limited
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-heal.ts
// （OPENCODE_GOAL_KILL_STREAM 由本脚本自身设置，随 spawn 传给宿主）

import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { startHost, labProvider, type IsolatedHost } from "./host.ts";

process.env.OPENCODE_GOAL_KILL_STREAM = "1"; // inherited by the spawned host

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
  console.log(`[verify-heal] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({ provider, waitMs: 60_000, keepDir: process.env.VERIFY_KEEP_DIR === "1" });
  console.log(`[verify-heal] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));

  const evFile = await host.startEventCapture(900);
  const S = await host.api.createSession();
  const turnCount = async (): Promise<number> => {
    const raw = await readFile(evFile, "utf8").catch(() => "");
    let n = 0;
    for (const line of raw.split("\n")) {
      if (line.includes("session.execution.started") && line.includes(S)) n++;
    }
    return n;
  };
  const decisions = async (): Promise<Record<string, unknown>[]> => {
    // plugin decisions log: <temp>/opencode-goal/decisions-<hostpid>.jsonl
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

  // H0: set the goal (kick turn). The probe kills the stream at this turn's
  // start (the 129 shape: turn started, then the pipe dies).
  const stSet = await host.api.command(
    S,
    "goal",
    "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 2",
  );
  check("H0: /goal set accepted", stSet >= 200 && stSet < 300, { status: stSet });
  check("H1a: kick turn started", await waitUntil(async () => (await turnCount()) >= 1, CHECK_TIMEOUT_MS, "H1a"));

  // H1b: the probe killed the stream; the loop's done path re-subscribed
  // (both lines on the host's stdout — the plugin logs there).
  check(
    "H1b: stream death + re-subscribe logged (§50 self-heal)",
    await waitUntil(async () => {
      const t = host.stdoutTail();
      return t.includes("force-killing event stream") && t.includes("event stream ended — re-subscribing");
    }, CHECK_TIMEOUT_MS, "H1b"),
    { tail: host.stdoutTail().slice(-400) },
  );

  // H2: the loop receives events on the NEW subscription — a prompt turn starts.
  await host.api.prompt(
    S,
    "Automated goal-loop test. Reply with ONLY the next countdown integer per the goal objective. " +
      "Do NOT call any tool — especially never goal_complete, goal_block, goal_pause, goal_wait or goal_next_step.",
  );
  check("H2: prompt turn started AFTER the stream death", await waitUntil(async () => (await turnCount()) >= 2, CHECK_TIMEOUT_MS, "H2"));

  // H3: a boundary was processed on the new subscription and injected a WAKE —
  // the decisions log is the ground truth (its absence was the 129 symptom).
  check(
    "H3: boundary on the NEW subscription injected a wake (loop self-drives)",
    await waitUntil(async () => (await decisions()).some((d) => d.decision === "wake"), CHECK_TIMEOUT_MS, "H3"),
    { decisions: await decisions() },
  );

  // H4: the loop drove the goal to budget_limited fully plugin-side.
  const budget = await waitUntil(async () => (await host.api.goalsGet(S)).output?.status === "budget_limited", 240_000, "H4");
  check(
    "H4: goal self-drove to budget_limited after the heal (>= 3 turns)",
    budget && (await turnCount()) >= 3,
    { status: (await host.api.goalsGet(S)).output?.status, turns: await turnCount() },
  );

  host.stopEventCapture();
  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify-heal] fatal:", err);
  process.exit(2);
});
