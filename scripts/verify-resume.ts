// §55 真宿主验证批（2026-10-24 裁定：user-message 恢复只碰未完成的 goal，
// 且不再立即注入唤醒）：在【隔离真实宿主】上验证
//   1. 模型 goal_block（blocked goal）
//   2. 用户消息到达 → 决策日志出现 decision:"resume" 行（新代码路径实锤）
//   3. 用户消息与模型回复之间**无插件唤醒消息**（旧行为：立即 injectWake）
//   4. 循环在下一边界恢复节奏（resume 行之后有新的决策行）
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-resume.ts

import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

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
  console.log(`  (timeout waiting for ${label})`);
  return false;
}

async function main(): Promise<void> {
  const provider = await labProvider(); // throws with a clear message when env is unset
  console.log(`[verify-resume] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.VERIFY_KEEP_DIR === "1",
    config: {
      plugins: [{ package: REPO_ROOT, options: {} }],
    },
  });
  console.log(`[verify-resume] isolated host up (port ${host.port}, pid ${host.pid}, dir ${host.directory})`);

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
  const context = async () => {
    const msgs = (await host.api.context(S)) as Array<Record<string, unknown>>;
    return msgs.map((m) => {
      const parts = Array.isArray(m?.content) ? (m.content as Array<Record<string, unknown>>) : [];
      const text = [typeof m?.text === "string" ? m.text : "", ...parts.map((p) => (typeof p?.text === "string" ? p.text : ""))].join(" ");
      return { role: m?.role ?? m?.type ?? "", text };
    });
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

  // R0: set the goal.
  const stSet = await host.api.command(
    S,
    "goal",
    "set Countdown: each turn reply with the next integer counting DOWN from 5, nothing else. This goal is never completed by itself. --turns 3",
  );
  check("R0: /goal set accepted", stSet >= 200 && stSet < 300, { status: stSet });
  check("R1: idle after the kick turn", await waitUntil(idle, CHECK_TIMEOUT_MS, "R1: idle"));

  // R2: the model blocks the goal (waiting on the user).
  await host.api.prompt(
    S,
    "Automated goal-loop test. Use your goal_block tool to block the goal with the exact reason " +
      '"waiting for user confirmation", then reply with exactly: blocked. waiting',
  );
  // Loose match: the lab model streams replies in split assistant messages,
  // so the confirmation text may span two — any "block" mention suffices (the
  // goal state itself is proven by R3's resume line).
  const blockedSeen = await waitUntil(async () => {
    const msgs = await context();
    return msgs.some((m) => m.role === "assistant" && m.text.toLowerCase().includes("block"));
  }, CHECK_TIMEOUT_MS, "R2: model blocked");
  check("R2: the model blocked the goal (assistant mentioned the block)", blockedSeen);
  check("R2b: idle after the block turn", await waitUntil(idle, CHECK_TIMEOUT_MS, "R2b: idle"));

  // R3: the user message arrives → the goal auto-resumes (unfinished/blocked only).
  const tBefore = Date.now();
  await host.api.prompt(S, "User reply: continue. Reply with the next countdown integer.");
  const resumeLine = await waitUntil(async () => {
    const d = await decisions();
    return d.some((l) => l.decision === "resume" && String(l.reason).includes("user message resumed blocked goal"));
  }, CHECK_TIMEOUT_MS, "R3: resume decision line");
  check("R3: a decision:'resume' line landed for the user message (new §55 code path live on a real host)", resumeLine, {
    line: (await decisions()).filter((l) => l.decision === "resume").map((l) => `${l.decision}:${l.reason}@${l.ts}`),
  });

  // R4: NO plugin wake message between the user message and the model's reply
  // (the old behavior injected a wake right at enqueue).
  const idleDone = await waitUntil(idle, CHECK_TIMEOUT_MS, "R4: idle after user turn");
  const msgs = await context();
  const ui = [...msgs].reverse().findIndex((m) => m.role === "user" && m.text.includes("User reply: continue"));
  const userIdx = ui === -1 ? -1 : msgs.length - 1 - ui;
  const replyIdx = userIdx >= 0 ? msgs.findIndex((m, i) => i > userIdx && m.role === "assistant" && m.text.length > 0) : -1;
  const wakeIdx = userIdx >= 0 ? msgs.findIndex((m, i) => i > userIdx && m.text.startsWith("[goal] turn")) : -1;
  check("R4: no immediate plugin wake between the user message and the model's reply", idleDone && userIdx >= 0 && replyIdx >= 0 && (wakeIdx === -1 || wakeIdx > replyIdx), {
    userIdx,
    replyIdx,
    wakeIdx,
    afterUser: msgs.slice(userIdx >= 0 ? userIdx : 0, (userIdx >= 0 ? userIdx : 0) + 5).map((m) => `${m.role}: ${m.text.slice(0, 40)}`),
  });

  // R5: the loop recovered its rhythm — a boundary/decision line after the resume.
  const recovered = await waitUntil(async () => {
    const d = await decisions();
    return d.some((l) => typeof l.ts === "string" && new Date(l.ts as string).getTime() >= tBefore && l.decision !== "resume");
  }, CHECK_TIMEOUT_MS, "R5: post-resume boundary");
  check("R5: a post-resume boundary decision line landed (loop rhythm recovered)", recovered, {
    decisions: (await decisions()).slice(-3).map((l) => `${l.decision}:${l.reason}`),
  });

  await host.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

(async () => {
  await main();
})().catch((err) => {
  console.error("[verify-resume] fatal:", err);
  process.exit(2);
});
