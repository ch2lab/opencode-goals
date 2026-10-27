// probe-steer.ts — REAL-host probe (2026-10-27, 2.2.0): at a STEP BOUNDARY of a
// busy turn (execution active, not suspended on a tool call), does a `steer`-
// delivered prompt reach the model mid-turn while a `queue`-delivered prompt
// stays parked until the session goes idle?
//
// Why this matters: the 129 §54 notice (delivery:"queue") parked forever in a
// busy goal session. The proposed fix is delivery:"steer". A steer lands at a
// step boundary; a queue needs an idle that a busy goal never offers. This probe
// builds exactly that: one turn with SEVERAL sequential steps (shell, shell,
// goal_wait — the goal_wait keeps the session busy so a queue can't idle-out),
// and injects a STEER + a QUEUE marker at a mid-turn step boundary.
//
// Busy recipe (one turn, several steps → step boundaries between them):
//   step1 shell `sleep 8`   step2 shell `sleep 8`   step3 goal_wait(1 min, blocking)
//   → step boundaries at ~8s (after step1) and ~16s (after step2). Inject at
//   t≈9s (just after step1 returns). Expect: STEER delivered at the next
//   boundary (~16s, mid-turn) while QUEUE stays parked until the turn ends
//   (after the goal_wait, ~76s).
//
// Usage (lab LLM creds from env only):
//   OPENCODE_LAB_PROVIDER_BASE / OPENCODE_LAB_PROVIDER_KEY
//   bun run scripts/probe-steer.ts
// NOT a test (no .test suffix) — manual/live diagnostic only.

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const STEER = "STEER-MARKER-9x";
const QUEUE = "QUEUE-MARKER-4y";
const INJECT_AT = 9; // seconds — just after step1's `sleep 8` returns (a step boundary)
const OBSERVE_TO = 100;

async function main(): Promise<void> {
  const provider = await labProvider();
  console.log(`[probe-steer] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.PROBE_KEEP_DIR === "1",
    config: { plugins: [{ package: REPO_ROOT, options: { watchdogTickMs: 2000 } }] },
  });
  console.log(`[probe-steer] isolated host up (port ${host.port}, pid ${host.pid})`);

  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));

  const H = { authorization: "Basic " + Buffer.from(`opencode:${host.password}`).toString("base64"), "content-type": "application/json" };
  const sid = await host.api.createSession();
  console.log(`[probe-steer] session ${sid}`);

  const inject = async (text: string, delivery: "steer" | "queue") => {
    const r = await fetch(`${host.baseUrl}/api/session/${sid}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text, delivery }) });
    return r.status;
  };

  await host.api.prompt(
    sid,
    "Automated delivery test. Do EXACTLY these steps in order, then stop:\n" +
      "1. Run this shell command and wait for it: `sleep 8`\n" +
      "2. Run this shell command and wait for it: `sleep 8`\n" +
      "3. Call the goal_wait tool with minutes set to 1 and NO other parameters (it blocks; wait for it to return).\n" +
      "4. After goal_wait returns, reply with exactly: RECEIVED <comma-list of which you actually saw: STEER-MARKER-9x and/or QUEUE-MARKER-4y, or NONE>. Do not do anything else.",
  );
  console.log(`[probe-steer] kick sent (sleep8 / sleep8 / goal_wait(1m)) at t=0`);

  let injected = false;
  let steerDeliveredAt = -1;
  let queueDeliveredAt = -1;
  let lastActive: string | undefined;
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const t = elapsed();
    const active = (await host.api.sessionActive())?.[sid];
    lastActive = active;
    const inbox = await host.api.inbox(sid);
    const steerParked = inbox.some((m: any) => String(m?.payload?.text ?? "").includes(STEER));
    const queueParked = inbox.some((m: any) => String(m?.payload?.text ?? "").includes(QUEUE));

    if (!injected && t >= INJECT_AT) {
      injected = true;
      const ss = await inject(`[${STEER}] steering notice — you received the steer marker. Continue the current steps.`, "steer");
      const qs = await inject(`[${QUEUE}] queued notice — you received the queue marker. Continue the current steps.`, "queue");
      console.log(`t=${t}s INJECT steer=${ss} queue=${qs} (active=${active})`);
      continue;
    }
    if (injected) {
      if (!steerParked && steerDeliveredAt < 0) steerDeliveredAt = t;
      if (!queueParked && queueDeliveredAt < 0) queueDeliveredAt = t;
    }
    const sTag = steerParked ? "PARKED" : steerDeliveredAt >= 0 ? `delivered@${steerDeliveredAt}s` : "absent?";
    const qTag = queueParked ? "PARKED" : queueDeliveredAt >= 0 ? `delivered@${queueDeliveredAt}s` : "absent?";
    console.log(`t=${t}s active=${active ?? "?"}  [${STEER}] ${sTag}  [${QUEUE}] ${qTag}`);
    if (t >= OBSERVE_TO) break;
    if (steerDeliveredAt > 0 && queueDeliveredAt > 0) break; // both delivered — done
  }

  // Final: what did the model say it received? (context scan for the RECEIVED reply)
  const ctx = (await host.api.context(sid)) as Array<Record<string, unknown>>;
  let reply = "";
  for (const m of ctx) {
    if (m?.type !== "assistant") continue;
    const content = (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>;
    for (const p of content) if (p?.type === "text" && typeof p.text === "string" && p.text.includes("RECEIVED")) reply = p.text;
  }
  console.log(`[probe-steer] SUMMARY steerDeliveredAt=${steerDeliveredAt}s queueDeliveredAt=${queueDeliveredAt}s lastActive=${lastActive}`);
  console.log(`[probe-steer] model RECEIVED reply: ${reply || "(none yet)"}`);
  console.log(`[probe-steer] stdout tail: ${host.stdoutTail().slice(-200)}`);
  await host.stop();
  process.exit(0);
}

void main().catch((err) => {
  console.error("[probe-steer] fatal:", err);
  process.exit(2);
});
