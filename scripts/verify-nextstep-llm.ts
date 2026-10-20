// scripts/verify-nextstep-llm.ts — REAL-LLM sandbox for the goal_next_step loop.
//
// Proves the model-side half that the mock-LLM verify cannot: with the REAL
// lab model (ch2lab/Qwen3.8-27B) the model, on a woken turn, follows the
// record-first wake instruction and calls goal_next_step — the content is the
// model's OWN synthesis (the turn stamp is server-side, never model-supplied)
// — and the NEXT boundary wake replays it (Resume line).
//
// Sandbox = isolated host (private temp dir, random port, lab LLM). The
// running desktop host and real user data are never touched.
//
// LLM credentials: env OPENCODE_LAB_PROVIDER_BASE/_KEY, falling back to the
// local desktop config (%USERPROFILE%\.config\opencode\opencode.jsonc,
// ch2lab provider). Nothing is committed.
//
// Non-determinism contract: the model MAY NOT obey (that is the behavior under
// study). The script reports EVIDENCE, not a silent binary pass:
//   A: record.nextStep set (a real host tool dispatch happened)
//   B: a later wake carries the Resume replay line
//   otherwise: NOTE with the observed wake count (the loop is still fine —
//   the model simply never recorded; re-run or watch production).
//
//   bun run scripts/verify-nextstep-llm.ts

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startHost, labProvider } from "./host.ts";
import { decisionLogPath } from "../src/decisionlog.ts";

// --- lab LLM config (no committed keys) ---
let base = process.env.OPENCODE_LAB_PROVIDER_BASE;
let key = process.env.OPENCODE_LAB_PROVIDER_KEY;
if (!base || !key) {
  try {
    const cfg = await readFile(
      join(process.env.USERPROFILE ?? ".", ".config", "opencode", "opencode.jsonc"),
      "utf8",
    );
    base = base ?? cfg.match(/"baseURL"\s*:\s*"([^"]+)"/)?.[1];
    key = key ?? cfg.match(/"apiKey"\s*:\s*"([^"]+)"/)?.[1];
  } catch {}
}
if (!base || !key) {
  console.error("no lab LLM config: set OPENCODE_LAB_PROVIDER_BASE/_KEY or fix the local desktop config");
  process.exit(2);
}
process.env.OPENCODE_LAB_PROVIDER_BASE = base;
process.env.OPENCODE_LAB_PROVIDER_KEY = key;
process.env.OPENCODE_LIVE_SMOKE_MODEL_ID = "Qwen3.8-27B";
const provider = await labProvider(); // preflight probes GET /models

// --- sandbox host ---
const host = await startHost({ provider, keepDir: true, waitMs: 90_000 });
console.log(`sandbox host up: ${host.baseUrl} (pid ${host.pid})`);
console.log(`sandbox dir (kept): ${host.directory}`);

// Seed the service registry so the plugin's hostapi queries see the host
// (isolated harness boots plain `serve`, which does not write it — same as
// verify-active's host2).
{
  const { mkdir, writeFile } = await import("node:fs/promises");
  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));
}

let active = false;
for (let i = 0; i < 120 && !active; i++) {
  const ps = await host.api.plugins();
  active = (ps ?? []).some((p: any) => p?.id === "opencode-goal" && p?.state?.status === "active");
  if (!active) await Bun.sleep(500);
}
console.log("plugin active:", active);
if (!active) {
  console.log("FATAL: plugin not active on the sandbox host");
  console.log("serve tail:\n" + ((host as any).stdoutTail?.() ?? ""));
  process.exit(1);
}

// --- seed: session + goal (default cap bounds cost; MULTI-STAGE objective —
// the goal must span >=3 wakes for the record-first/Resume loop to be
// exercised; a single-turn-completable objective ends before the first wake) ---
const sid = await host.api.createSession();
const setRes = await host.api.command(
  sid,
  "goal",
  "set Write a short markdown note comparing work-queue and event-loop task scheduling, in THREE explicit stages in the file note.md. Stage 1: outline only — two section headings, three bullets each. Stage 2: replace with full text — one paragraph per strategy plus its two most likely failure modes. Stage 3: add a one-line verdict at the end and check the total is under 300 words. RULES: do exactly ONE stage per turn, end your response right after finishing that stage, never combine stages into one turn, and do NOT call goal_complete before all three stages are written to the file.",
);
console.log("goal set status:", setRes);

const logFile = decisionLogPath(host.pid);
const readDecisions = async (): Promise<Array<Record<string, unknown>>> => {
  try {
    return (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

// --- observe until both halves are proven (15 min cap) ---
const deadline = Date.now() + 15 * 60_000;
let nextStep: unknown;
let resumeSeen = false;
let goalTerminal = "";
while (Date.now() < deadline && !(nextStep && resumeSeen)) {
  const g = await host.api.goalsGet(sid);
  const status = g.output?.status ?? g.error;
  if (status !== "active" && !goalTerminal) goalTerminal = String(status);
  const ns = g.output?.nextStep;
  if (ns && !nextStep) {
    nextStep = ns;
    console.log("  [EVIDENCE-A] model called goal_next_step (record):", JSON.stringify(ns).slice(0, 400));
  }
  if (ns && !resumeSeen) {
    const ctx = await host.api.context(sid);
    const raw = JSON.stringify(ctx);
    const i = raw.indexOf("Resume — your last recorded next step");
    if (i !== -1) {
      resumeSeen = true;
      console.log("  [EVIDENCE-B] a later wake REPLAYS the plan:", raw.slice(i, i + 260).replace(/\\n/g, " "));
    }
  }
  if (goalTerminal !== "" && nextStep === undefined) break; // no more wakes will come
  await Bun.sleep(5_000);
}

// --- evidence dump ---
const decisions = (await readDecisions()).filter((d) => d.sessionID === sid);
console.log("── decision lines ──");
for (const d of decisions) console.log(`  ${d.ts} ${d.decision} q=${d.queued} ${String(d.reason ?? "")}`);
const g2 = await host.api.goalsGet(sid);
console.log("── goal ──");
console.log(JSON.stringify(g2.output ?? g2.error));
console.log("── session message tail (model's own words) ──");
const ctx: any[] = (await host.api.context(sid)) ?? [];
for (const m of ctx.slice(-10)) {
  const text = JSON.stringify(m.content ?? m ?? "")
    .slice(0, 300)
    .replace(/\n/g, " ");
  console.log(`  [${m.type}] ${text}`);
}

console.log("\nRESULT:");
console.log(`  A: model called goal_next_step on the real host — ${nextStep ? "YES" : "NO (model did not record within the window)"}`);
console.log(`  B: a later wake REPLAYED the recorded plan (Resume line) — ${resumeSeen ? "YES" : "NO"}`);
if (!nextStep && decisions.length === 0 && goalTerminal !== "") {
  console.log("  NOTE: goal reached a terminal state with ZERO boundary wakes — the objective was single-turn completable (no record-first wake ever appeared)");
}
process.exit(nextStep !== undefined && resumeSeen ? 0 : 1);
