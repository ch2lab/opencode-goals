// probe-steer3.ts — REAL-host END-TO-END probe (2026-10-27, 2.2.0): trigger the
// plugin's ACTUAL §52→§54 path (a model-run foreground shell outlives the cap →
// the plugin backgrounds it + injects its own notice, now delivery:"steer") in
// a busy goal session, and observe that the notice is DELIVERED (leaves the
// inbox while the session is still running) rather than parked.
//
// This closes the loop that probe-steer2 left open: probe-steer2 injected a
// steer marker via the HTTP prompt endpoint; here the PLUGIN itself fires §54
// (in-process ctx.session.prompt, delivery:"steer" per the fix) and we verify
// the real notice reaches the model in a busy session.
//
// Recipe: foregroundShellBackgroundMs=6000, watchdogTickMs=2000. Model runs a
// foreground `sleep 60`; at ~6s the §52 scan backgrounds it + injects the §54
// notice (steer). The model is told to goal_wait(1) afterward (keeps the session
// busy, so a queue notice would park — the incident shape). We track the §54
// notice (metadata.goalControl + "moved it to background") in the inbox over time.
//
// Usage: OPENCODE_LAB_PROVIDER_BASE / OPENCODE_LAB_PROVIDER_KEY
//   bun run scripts/probe-steer3.ts
// NOT a test — manual/live diagnostic only.

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const OBSERVE_TO = 110;

async function main(): Promise<void> {
  const provider = await labProvider();
  console.log(`[probe-steer3] lab model: ${provider.modelID}`);
  const host: IsolatedHost = await startHost({
    provider,
    waitMs: 60_000,
    keepDir: process.env.PROBE_KEEP_DIR === "1",
    config: {
      plugins: [{ package: REPO_ROOT, options: { watchdogTickMs: 2000, foregroundShellBackgroundMs: 6000, foregroundNoticeCommandChars: 200 } }],
    },
  });
  console.log(`[probe-steer3] isolated host up (port ${host.port}, pid ${host.pid})`);

  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));

  const sid = await host.api.createSession();
  console.log(`[probe-steer3] session ${sid}`);

  // Start a goal (goal session + goal_wait available + keeps the loop active).
  await host.api.command(sid, "goal", "set Automated test — keep working; do not complete. --turns 1000");

  await host.api.prompt(
    sid,
    "Automated goal-plugin test. Do EXACTLY:\n" +
      "1. Run this shell command in the FOREGROUND and WAIT for it: `sleep 60`\n" +
      "2. If the shell finishes early or is moved to the background, IMMEDIATELY call the goal_wait tool with minutes set to 1 and NO other parameters.\n" +
      "3. After goal_wait returns, reply with exactly: REPORT <you saw the 'moved it to background' notice> or REPORT <you did NOT see any such notice>.\n" +
      "Do not do anything else.",
  );
  console.log(`[probe-steer3] kick sent (goal + sleep60 foreground → goal_wait(1m)) at t=0`);

  const isNotice = (m: any) => {
    const meta = m?.payload?.metadata ?? {};
    return meta.goalControl === true && String(m?.payload?.text ?? "").includes("moved it to background automatically");
  };
  let noticeDeliveredAt = -1;
  let sawNoticeInInbox = false;
  let lastActive: string | undefined;
  const t0 = Date.now();
  const elapsed = () => Math.round((Date.now() - t0) / 1000);

  for (let i = 0; i < 45; i++) {
    await sleep(3000);
    const t = elapsed();
    const active = (await host.api.sessionActive())?.[sid];
    lastActive = active;
    const inbox = await host.api.inbox(sid);
    const noticeParked = inbox.some(isNotice);
    if (noticeParked) sawNoticeInInbox = true;
    if (sawNoticeInInbox && !noticeParked && noticeDeliveredAt < 0) noticeDeliveredAt = t;
    console.log(`t=${t}s active=${active ?? "?"}  §54-notice: ${sawNoticeInInbox ? (noticeParked ? "PARKED" : `delivered@${noticeDeliveredAt}s`) : "not-injected-yet"}`);
    if (t >= OBSERVE_TO) break;
    if (noticeDeliveredAt > 0) break; // delivered — we have our answer
  }

  const ctx = (await host.api.context(sid)) as Array<Record<string, unknown>>;
  let reply = "";
  for (const m of ctx) {
    if (m?.type !== "assistant") continue;
    const content = (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>;
    for (const p of content) if (p?.type === "text" && typeof p.text === "string" && p.text.includes("REPORT")) reply = p.text;
  }
  console.log(`[probe-steer3] SUMMARY noticeDeliveredAt=${noticeDeliveredAt}s lastActive=${lastActive} sawInbox=${sawNoticeInInbox}`);
  console.log(`[probe-steer3] model REPORT: ${reply || "(none yet)"}`);
  console.log(`[probe-steer3] stdout tail: ${host.stdoutTail().slice(-260)}`);
  await host.stop();
  process.exit(0);
}

void main().catch((err) => {
  console.error("[probe-steer3] fatal:", err);
  process.exit(2);
});
