// §48/§49/§49-rev/§50 真宿主验证批（2026-10-20 批 + 2026-10-21 B 断言翻转）：
// 在【隔离真实宿主】上验证
//   A: /goal set 结果行 kick（宿主 auto-wake → 模型 turn 真的起来，§47 机制存活）
//   B: /goal view 结果行 kick（§49-rev：2.1.1 不渲染 resume:false 记录行——
//      模型的可见回复才是用户可见输出；kick turn 不链式再唤醒）
//   C: budget_limited 终态通知 resume:false → 不再白踢（§48）
//   D: budget_limited → /goal resume：kick turn 走真边界、post-resume budget
//      grace 消耗（decision:"hold" 日志行）、goal 保持 active 不被立刻打回（§49）
//   E: grace 一次性：下一个 over-cap 边界照常 re-limit（§49）
//
// 用法（本机一次性测试宿主，隔离 config + 端口 + 空白目录；lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-wake.ts
//
// turn 计数 = 事件流里本会话的 session.execution.started 条数——"kick"的宿主侧
// 直接物证（宿主收到 resume:false 的 synthetic 不会起 turn，started 数不变）。

import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { startHost, labProvider, type IsolatedHost } from "./host.ts";

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
  console.log(`[verify] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({ provider, waitMs: 60_000, keepDir: process.env.VERIFY_KEEP_DIR === "1" });
  console.log(`[verify] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

  // memory #12243: plain serve does NOT write the registry file the plugin's
  // data plane needs — write <state>/opencode/service.json ourselves.
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
  const goalStatus = async (): Promise<string | undefined> =>
    (await host.api.goalsGet(S)).output?.status ?? undefined;
  const graceLogLine = async (): Promise<Record<string, unknown> | undefined> => {
    // decisions log: <tempdir>/opencode-goal/decisions-<pid>.jsonl (this host's pid).
    const dir = process.env.TEMP ?? process.env.TMP ?? "C:\\Windows\\Temp";
    const raw = await readFile(join(dir, "opencode-goal", `decisions-${host.pid}.jsonl`), "utf8").catch(() => "");
    const lines = raw
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
    return lines.filter((l) => String(l.reason ?? "").includes("budget grace")).pop();
  };

  // §50: 2.1.1 STEERs a command-synthetic/prompt sent into a RUNNING session
  // into the in-flight turn (no new started event) — every phase therefore
  // waits for the session to be idle before issuing its command/prompt.
  const idle = async (): Promise<boolean> => {
    try {
      return (await host.api.sessionActive())[S] !== "running";
    } catch {
      return true; // query failure must not wedge the run
    }
  };

  // A: /goal set kicks — the result line is the host's steer+wake (spec §47/§49).
  // Objective framed as an endless countdown: the model has nothing to
  // "complete" (a first run of this script let the model call goal_complete on
  // a vague objective — model compliance, not plugin behavior).
  const stSet = await host.api.command(
    S,
    "goal",
    "set Endless countdown: each turn reply with the next integer counting DOWN from 1000, nothing else. This goal is never completed. --turns 1",
  );
  check("A0: /goal set accepted", stSet >= 200 && stSet < 300, { status: stSet });
  check("A: the set's result line kicked a model turn (host auto-wake alive)", await waitUntil(async () => (await turnCount()) >= 1, CHECK_TIMEOUT_MS, "A: kick turn"));
  check("A2: session idle before the view command (2.1.1 busy-steer guard)", await waitUntil(idle, CHECK_TIMEOUT_MS, "A2: idle"));

  // B: /goal view result line KICKS a visible-reply turn (§49-rev 2026-10-21:
  // 2.1.1 hosts do not render resume:false record lines in the UI — the model's
  // one-line reply IS the user-visible output). That kick turn's boundary sees
  // a control lastInbox → no chained wake (the parked loop does not restart).
  const stView = await host.api.command(S, "goal", "view");
  check("B0: /goal view accepted", stView >= 200 && stView < 300, { status: stView });
  check(
    "B: view result line kicked a visible-reply turn (§49-rev)",
    await waitUntil(async () => (await turnCount()) >= 2, CHECK_TIMEOUT_MS, "B: view kick"),
    { turns: await turnCount() },
  );
  await waitUntil(idle, CHECK_TIMEOUT_MS, "B2: idle before the prompt");

  // C: drive to budget_limited (--turns 1). A user prompt triggers the wake
  // ladder; the cap trips at the next boundary; the budget_limited terminal
  // notice (resume:false) must NOT kick.
  const PROMPT =
    "Automated goal-loop test. Reply with ONLY the next countdown integer per the goal objective. " +
    "Do NOT call any tool — especially never goal_complete, goal_block, goal_pause, goal_wait or goal_next_step.";
  await host.api.prompt(S, PROMPT);
  check("C0: prompt turn started", await waitUntil(async () => (await turnCount()) >= 3, CHECK_TIMEOUT_MS, "C0: prompt turn"));
  const budget = await waitUntil(async () => (await goalStatus()) === "budget_limited", 240_000, "C: budget_limited");
  // C1 is a guard against model intervention, not a timing assertion: a model
  // goal_* call would land on completed/blocked/paused (or an extra turn),
  // never on budget_limited — so the goal arriving there with EXACTLY 4 turns
  // (set kick + view kick + prompt + injected wake) proves the ladder ran
  // plugin-driven. (§49-rev: the view kick adds one turn to the count.)
  check("C1: budget_limited reached via the turn ladder (exactly 4 turns, no goal_* intervention)",
    budget && (await turnCount()) === 4,
    { status: await goalStatus(), turns: await turnCount() });
  check("C0b: goal reached budget_limited", budget, { status: await goalStatus(), turns: await turnCount() });
  const cAfterNotice = await turnCount();
  await waitUntil(async () => (await turnCount()) > cAfterNotice, 25_000, "C: (expect no kick)");
  check("C: budget_limited terminal notice did NOT kick a turn (§48)", (await turnCount()) === cAfterNotice, { before: cAfterNotice, after: await turnCount() });

  // D: /goal resume — the result line kicks; that turn's boundary consumes the
  // one-shot post-resume budget grace (decision:"hold") and the goal stays active
  // (pre-§49: the same kick turn immediately re-limited it on the real host).
  const stResume = await host.api.command(S, "goal", "resume");
  check("D0: /goal resume accepted", stResume >= 200 && stResume < 300, { status: stResume });
  const graceOk = await waitUntil(async () => {
    const l = await graceLogLine();
    return l !== undefined && (await goalStatus()) === "active";
  }, CHECK_TIMEOUT_MS, "D: grace consumed + active");
  check("D: resume from budget_limited stayed ACTIVE (grace consumed by its kick turn)", graceOk, {
    status: await goalStatus(),
    grace: await graceLogLine(),
  });
  const graceLine = await graceLogLine();
  check("D2: grace consumption logged (decision:hold, reason mentions grace)", graceLine?.decision === "hold", graceLine);

  // E: one-shot — the next over-cap boundary re-limits (a user prompt drives it).
  // Total: 4 (C) + 1 (resume kick, D) + 1 (prompt, E) = 6.
  await host.api.prompt(S, PROMPT);
  const relimit = await waitUntil(async () => (await goalStatus()) === "budget_limited", 240_000, "E: re-limit");
  check(
    "E: grace was one-shot — next over-cap boundary re-limits to budget_limited (6 turns total, no intervention)",
    relimit && (await turnCount()) === 6,
    { status: await goalStatus(), turns: await turnCount() },
  );

  host.stopEventCapture();
  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify] fatal:", err);
  process.exit(2);
});
