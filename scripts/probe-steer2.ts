// probe-steer2.ts — REAL-host probe (2026-10-27, 2.2.0): reproduce the EXACT
// 129 incident sequence and test the fix timing:
//   1. model turn blocked on a long FOREGROUND shell (`sleep 90`)
//   2. at t≈15s, POST /api/session/:id/background  (the §52 action — releases
//      the blocked turn; this is when the shell becomes a step boundary)
//   3. IMMEDIATELY inject a STEER marker + a QUEUE marker (the §54 moment)
//   4. the model is told to enter goal_wait(1m) after the shell, so the session
//      stays BUSY (goal_wait) → a queue can't idle-out (the incident's core)
// Question: at the shell-background step boundary, does the STEER reach the
// model (mid-turn) while the QUEUE stays parked (busy goal session)?
//
// Usage: OPENCODE_LAB_PROVIDER_BASE / OPENCODE_LAB_PROVIDER_KEY, then
//   bun run scripts/probe-steer2.ts
// NOT a test — manual/live diagnostic only.

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const STEER = "STEER-MARKER-9x";
const QUEUE = "QUEUE-MARKER-4y";
const BG_AT = 15; // seconds — when to background the shell
const OBSERVE_TO = 110;

async function main(): Promise<void> {
  const provider = await labProvider();
  console.log(`[probe-steer2] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.PROBE_KEEP_DIR === "1",
    config: { plugins: [{ package: REPO_ROOT, options: { watchdogTickMs: 2000 } }] },
  });
  console.log(`[probe-steer2] isolated host up (port ${host.port}, pid ${host.pid})`);

  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));

  const H = { authorization: "Basic " + Buffer.from(`opencode:${host.password}`).toString("base64"), "content-type": "application/json" };
  const sid = await host.api.createSession();
  console.log(`[probe-steer2] session ${sid}`);
  const inject = async (text: string, delivery: "steer" | "queue") => {
    const r = await fetch(`${host.baseUrl}/api/session/${sid}/prompt`, { method: "POST", headers: H, body: JSON.stringify({ text, delivery }) });
    return r.status;
  };

  await host.api.prompt(
    sid,
    "Automated delivery test. Do EXACTLY this:\n" +
      "1. Run this shell command and WAIT for it to finish: `sleep 90`\n" +
      "2. If the shell finishes early or is moved to the background, IMMEDIATELY call the goal_wait tool with minutes set to 1 and NO other parameters (it blocks; wait for it).\n" +
      "3. After goal_wait returns, reply with exactly: RECEIVED <comma-list of which you actually saw: STEER-MARKER-9x and/or QUEUE-MARKER-4y, or NONE>. Do not do anything else.",
  );
  console.log(`[probe-steer2] kick sent (sleep90 → goal_wait(1m)) at t=0`);

  let injected = false;
  let bgAt = -1;
  let steerDeliveredAt = -1;
  let queueDeliveredAt = -1;
  let lastActive: string | undefined;
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  for (let i = 0; i < 45; i++) {
    await sleep(3000);
    const t = elapsed();
    const active = (await host.api.sessionActive())?.[sid];
    lastActive = active;
    const inbox = await host.api.inbox(sid);
    const steerParked = inbox.some((m: any) => String(m?.payload?.text ?? "").includes(STEER));
    const queueParked = inbox.some((m: any) => String(m?.payload?.text ?? "").includes(QUEUE));

    if (!injected && t >= BG_AT) {
      injected = true;
      bgAt = t;
      // §52 moment: background the foreground shell → releases the blocked turn.
      const bg = await fetch(`${host.baseUrl}/api/session/${sid}/background`, { method: "POST", headers: H });
      // §54 moment: IMMEDIATELY inject both markers (steer = the fix, queue = the current).
      const ss = await inject(`[${STEER}] steering notice — you received the steer marker. Continue.`, "steer");
      const qs = await inject(`[${QUEUE}] queued notice — you received the queue marker. Continue.`, "queue");
      console.log(`t=${t}s BACKGROUND status=${bg.status} INJECT steer=${ss} queue=${qs} (active=${active})`);
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
    if (steerDeliveredAt > 0 && queueDeliveredAt > 0) break;
  }

  const ctx = (await host.api.context(sid)) as Array<Record<string, unknown>>;
  let reply = "";
  for (const m of ctx) {
    if (m?.type !== "assistant") continue;
    const content = (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>;
    for (const p of content) if (p?.type === "text" && typeof p.text === "string" && p.text.includes("RECEIVED")) reply = p.text;
  }
  console.log(`[probe-steer2] SUMMARY bg@${bgAt}s steerDeliveredAt=${steerDeliveredAt}s queueDeliveredAt=${queueDeliveredAt}s lastActive=${lastActive}`);
  console.log(`[probe-steer2] model RECEIVED reply: ${reply || "(none yet)"}`);
  console.log(`[probe-steer2] stdout tail: ${host.stdoutTail().slice(-200)}`);
  await host.stop();
  process.exit(0);
}

void main().catch((err) => {
  console.error("[probe-steer2] fatal:", err);
  process.exit(2);
});
