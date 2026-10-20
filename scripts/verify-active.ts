// Real-host verification of the 2026-10-20 reference-UI in-flight criterion
// (the 1.1.3 zombie-lock fix). Boots the ISOLATED real host (mock LLM, no
// external creds, no 129), loads the plugin from source, and confirms on REAL
// /api/session/active data:
//   1. the plugin loads ACTIVE on a real host;
//   2. GET /api/session/active (x-opencode-directory header — what hostapi
//      activeSessions sends) responds with a sessionID→status MAP (the 129
//      live probe only ever saw the EMPTY map — this pins the shape);
//   3. a session running a real turn appears in the map mid-turn with status
//      "running" (the UI's own signal the gate now reads) and is ABSENT after
//      the turn (the zombie-lock inverse: dead = no entry = not in flight);
//   4. HOST RESTART (real): kill the serve process and boot a second serve on
//      the SAME env dir — the goal survives (kv in the state dir), the new
//      host's in-memory active map starts EMPTY (a zombie lock cannot persist
//      across a restart — the 1.1.3 DB-time-field lock would have), and the
//      next real boundary wakes, logged to the NEW pid's decision file.
// The stub tests pin the counting logic (attribution ∧ running); this script
// pins the contract the counting reads.
//
//   bun run scripts/verify-active.ts
// NOT a bun test — manual/live use only.
import { startHost, type ProviderSpec } from "./host.ts";
import { join } from "node:path";

const MOCK_PORT = 47998;
// Request log: which model calls the host makes per turn (diagnosis of the
// 36s multi-step wake turns — what are the extra calls?).
const mockLog: Array<{ ts: string; msgs: number; len: number; lastRole: string; sys: string; lastUser: string; tools: string }> = [];
// Phase 5l (goal_next_step) + 5m (reactivation): the mock fires scripted
// native tool calls — one per arm (`queued`), on the first real model request
// after arming (tools advertised = not a title call). Self-synchronized, no
// race: the call lands in whichever turn the phase drives next.
const scripted = { queued: 0, fireTs: undefined as string | undefined };
const server = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text().catch(() => "");
    let stream = false, title = false, toolCall = false;
    try {
      const b = JSON.parse(raw || "{}");
      stream = !!b.stream;
      const last = (b.messages ?? [])[b.messages.length - 1];
      title = last?.role === "assistant" && raw.length < 600;
      // Count-based trigger (2026-10-20 run fix): fire on the FIRST real model
      // request after the phase arms (tools advertised = not a title call).
      // The old text trigger ("No recorded next step yet") proved unreachable:
      // by the time the phase armed, the mock loop was already in the stall
      // phase — the stall-report text family carries no record-first line, so
      // the script never fired and 5l-a/b failed on a harness, not a plugin.
      if (
        scripted.queued > 0 &&
        last?.role === "user" &&
        Array.isArray(b.tools) &&
        (b.tools as any[]).length > 0
      ) {
        scripted.queued -= 1;
        scripted.fireTs = new Date().toISOString();
        toolCall = true;
      }
      const msgs: any[] = b.messages ?? [];
      mockLog.push({
        ts: new Date().toISOString(),
        msgs: msgs.length,
        len: raw.length,
        lastRole: String(last?.role ?? "?"),
        sys: String(msgs.find((m) => m.role === "system")?.content ?? "").slice(0, 140).replace(/\s+/g, " "),
        lastUser: String(last?.content ?? "").replace(/\s+/g, " ").slice(0, 600),
        tools: Array.isArray(b.tools)
          ? (b.tools as any[]).map((t) => t?.function?.name ?? t?.name ?? "?").join(",")
          : "-",
      });
    } catch {}
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mock-model" }] });
    await new Promise((r) => setTimeout(r, title ? 50 : 12_000)); // slow real turn
    if (toolCall) {
      // 2026-10-20 ruling (host 2.0.32 subagent precedent): goal_next_step is
      // registered with codemode:false — it sits IN the host's OpenAI `tools`
      // array, so the model calls it DIRECTLY (a clean tool chip in the session
      // record, not an `execute` code block). The scripted response mimics a
      // real model: a native tool_call to goal_next_step. The host must
      // dispatch it to the plugin and persist (5l-0 asserts the native
      // exposure; 5l-a reads the record; 5l-b reads the replay).
      const fn = { name: "goal_next_step", arguments: JSON.stringify({ text: "5l probe: verify the replay loop (judge: n>=9)" }) };
      if (stream) {
        const enc = new TextEncoder();
        const chunks = [
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_5l", type: "function", function: { name: fn.name } }] } }] },
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fn.arguments } }] } }] },
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ];
        return new Response(enc.encode(chunks.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n"), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "x", object: "chat.completion", created: 0, model: "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_5l", type: "function", function: fn }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    const content = "done";
    if (stream) {
      const enc = new TextEncoder();
      const sse =
        [
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] },
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content } }] },
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
          .map((o) => `data: ${JSON.stringify(o)}\n\n`)
          .join("") + "data: [DONE]\n\n";
      return new Response(enc.encode(sse), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "x", object: "chat.completion", created: 0, model: "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
  },
});

const provider: ProviderSpec = {
  id: "mock", name: "mock", package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `http://127.0.0.1:${MOCK_PORT}`, apiKey: "dummy" },
  model: { id: "mock-model", name: "mock-model", limit: { context: 32768, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } },
  modelID: "mock/mock-model",
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const host = await startHost({ provider, keepDir: true, waitMs: 60_000 });
console.log("host up:", host.baseUrl);
const H = { authorization: "Basic " + Buffer.from(`opencode:${host.password}`).toString("base64") };
const get = async (p: string): Promise<any> => (await fetch(`${host.baseUrl}${p}`, { headers: H })).json();
// The header form hostapi activeSessions() actually sends (location-scoped).
const activeMap = async (): Promise<Record<string, unknown>> => {
  const r = await fetch(`${host.baseUrl}/api/session/active`, {
    headers: { ...H, "x-opencode-directory": encodeURIComponent(host.project) },
  });
  const j = (await r.json()) as any;
  return r.ok && j?.data && typeof j.data === "object" ? (j.data as Record<string, unknown>) : {};
};

// 1. plugin ACTIVE on the real host
let active = false;
for (let i = 0; i < 40 && !active; i++) {
  const ps = await host.api.plugins();
  const p = (ps ?? []).find((x: any) => x?.id === "opencode-goal");
  active = p?.state?.status === "active";
  if (!active) await Bun.sleep(500);
}
check("1: plugin ACTIVE on real host", active);

// 2. the raw GET /api/session/active — the endpoint my activeSessions() calls.
const idleMap = await activeMap();
check("2a: GET /api/session/active (header form) responds with a map", Object.keys(idleMap).length >= 0, JSON.stringify(idleMap));

const sid = await host.api.createSession();
console.log("session:", sid, "project:", host.project);

// 3. mid-turn: the session appears in the active map as "running" — the UI's
//    own signal. The mock turn is slow (12s) so the window is wide.
const promptP = (async () => {
  const r = await fetch(`${host.baseUrl}/api/session/${sid}/prompt`, {
    method: "POST", headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ text: "reply with exactly: done" }),
  });
  return { status: r.status, len: (await r.text()).length };
})();

// The raw value is an object ({type:"running"} — the real contract, pinned by
// this verify run); a bare string is also accepted (defensive).
function statusOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string") {
    return (v as { type: string }).type;
  }
  return undefined;
}

let midStatus: string | undefined;
for (let i = 0; i < 80 && midStatus === undefined; i++) {
  midStatus = statusOf((await activeMap())[sid]);
  await Bun.sleep(400);
}
await promptP;
console.log("  MID-TURN active entry:", JSON.stringify(midStatus));
check("3a: session appears in the active map mid-turn", midStatus !== undefined, `status=${JSON.stringify(midStatus)}`);
check("3b: mid-turn status is \"running\" (the gate's criterion token)", midStatus === "running", `status=${JSON.stringify(midStatus)}`);

// 4. after the turn: the entry is gone (dead = absent = not in flight — the
//    zombie-lock inverse).
let settled = false;
for (let i = 0; i < 40 && !settled; i++) {
  const m = await activeMap();
  settled = statusOf(m[sid]) === undefined;
  if (!settled) await Bun.sleep(400);
}
check("4: after the turn the session has NO active entry (absent = idle = not in flight)", settled, `after=${JSON.stringify((await activeMap())[sid])}`);

// ── 5. HOST RESTART (real) ─────────────────────────────────────────────────
// Kill this host and boot a SECOND serve on the SAME env dir (same XDG dirs →
// same state DB, config, service.json location). This is the production "host
// restart" scenario (129 hosts do restart). Asserts:
//   5a-5b: a goal can be set and is active before the restart;
//   5e:    the goal record SURVIVES the restart (kv lives in the state dir);
//   5d:    the plugin reloads ACTIVE on the new process;
//   5f:    the new host's active map starts EMPTY — the 1.1.4 gate's input is
//          in-memory, so a zombie lock CANNOT persist across a restart
//          (the 1.1.3 lock was DB-time-field-based and would have);
//   5g-5h: the next REAL boundary after the restart (a mock turn) is
//          arbitrated: wake, in-flight 0, written to the NEW pid's decision
//          file (per-host-pid files — the old one is gone on real restarts);
//   5i-5k: QUEUED-INPUT GATE (the 129 incident): follow-ups sent mid-turn are
//          queued (real /inbox shape pinned); the busy turn's boundary HOLDS
//          with queued >= 1 (the wake never lands in the queue); the queued
//          messages are delivered and a later boundary WAKES (no silence).
const setRes = await host.api.command(sid, "goal", "set RestartProbe");
check("5a: /goal set on the real host", setRes === 200 || setRes === 204, `status=${setRes}`);
let goalActive = false;
for (let i = 0; i < 40 && !goalActive; i++) {
  const g = await host.api.goalsGet(sid);
  goalActive = g.output?.status === "active";
  if (!goalActive) await Bun.sleep(500);
}
check("5b: goal active before restart", goalActive, JSON.stringify((await host.api.goalsGet(sid)).output ?? (await host.api.goalsGet(sid)).error));

await host.stop(); // kills the whole tree; keepDir retains the env dir
const host2 = await startHost({ provider, dir: host.directory, keepDir: true, waitMs: 60_000 });
console.log("host2 up:", host2.baseUrl, "(pid", host2.pid, "— first host was pid", host.pid + ")");
check("5c: restart = a real new process", host2.pid > 0 && host2.pid !== host.pid);
// The production host runs `serve --service` and writes the registration file
// (<state>/opencode/service.json) itself; the isolated harness boots a plain
// `serve`, which does NOT (verified: state/opencode/ stays empty) — so the
// plugin's data plane sees no-registry and skips. Seed the file to match
// production; hostapi re-reads it per query, so timing is free.
{
  const { mkdir: mkSvc, writeFile: writeSvc } = await import("node:fs/promises");
  const svcDir = join(host2.directory, "state", "opencode");
  await mkSvc(svcDir, { recursive: true });
  await writeSvc(join(svcDir, "service.json"), JSON.stringify({ url: host2.baseUrl, pid: host2.pid, password: host2.password }));
}
const H2 = { authorization: "Basic " + Buffer.from(`opencode:${host2.password}`).toString("base64") };
const activeMap2 = async (): Promise<Record<string, unknown>> => {
  const r = await fetch(`${host2.baseUrl}/api/session/active`, {
    headers: { ...H2, "x-opencode-directory": encodeURIComponent(host2.project) },
  });
  const j = (await r.json()) as any;
  return r.ok && j?.data && typeof j.data === "object" ? (j.data as Record<string, unknown>) : {};
};
let active2 = false;
for (let i = 0; i < 40 && !active2; i++) {
  const ps = await host2.api.plugins();
  const p = (ps ?? []).find((x: any) => x?.id === "opencode-goal");
  active2 = p?.state?.status === "active";
  if (!active2) await Bun.sleep(500);
}
check("5d: plugin ACTIVE on the restarted host", active2);
const g2 = await host2.api.goalsGet(sid);
check("5e: goal record survived the restart (kv persists in the state dir)", g2.output?.status === "active", JSON.stringify(g2.output ?? g2.error));
const map2 = await activeMap2();
check("5f: new host's active map is EMPTY (in-memory gate input reset — a zombie lock cannot survive a restart)", Object.keys(map2).length === 0, JSON.stringify(map2));
// Event capture (independent /api/event SSE subscriber): ground truth for
// WHAT THE HOST EMITTED — separates "host never emitted the boundary event"
// from "plugin dropped/failed on it" (2026-10-20 5j-missing diagnosis).
const evCapFile = await host2.startEventCapture(600);

// 5g/5h: the next REAL boundary after the restart.
const { decisionLogPath } = await import("../src/decisionlog.ts");
const { readFile } = await import("node:fs/promises");
const logFile = decisionLogPath(host2.pid);
const turnP = host2.api.prompt(sid, "reply with exactly: done");
let line: Record<string, unknown> | undefined;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !line) {
  await turnP.catch(() => {});
  try {
    const raw = await readFile(logFile, "utf8");
    for (const l of raw.trim().split("\n")) {
      if (!l) continue;
      const d = JSON.parse(l) as Record<string, unknown>;
      if (d.sessionID === sid) line = d;
    }
  } catch {}
  await Bun.sleep(500);
}
check("5g: first post-restart boundary WAKES (goal loop recovered on the real host)", line !== undefined && line.decision === "wake", JSON.stringify(line));
check("5h: gate reads in-flight 0 on the fresh host (no zombies carry over)", line !== undefined && line.own === 0 && line.other === 0, JSON.stringify(line));

// ── 5i–5k: queued-input gate (2026-10-20 ruling; the 129 incident) ─────────
// Timing matters (field-observed 2026-10-20, event capture + /inbox sampler):
// the host delivers queued items at the INTERMEDIATE STEP boundaries of a
// RUNNING multi-step turn — a 36s/3-model-call turn drains the queue between
// its calls, so nothing is left at its terminal. In every run ~one wake turn
// is multi-step (context-driven, varies which one); the rest are single-step
// 12s turns with NO intermediate boundary — items queued during them survive
// to the turn's terminal: the exact 129 incident setup (a user message
// undelivered at the boundary). We therefore retry: send two follow-ups
// mid-turn, watch that turn's boundary; if it WAKED (items were drained
// mid-turn), the attempt was on a multi-step turn — retry on the next turn.
// A single-step turn → the gate must HOLD with queued >= 1 (a wake injected
// there would land IN THE QUEUE behind the user's messages). Then each queued
// item is delivered as its own turn; the LAST one's boundary WAKES
// (attribution: the last inbox was the user's) — the loop continues, no
// silence. The raw /inbox samples pin the real shape ({data: Item[]},
// "not yet delivered" items, any kind).
const readDecisions = async (): Promise<Array<Record<string, unknown>>> => {
  try {
    return (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};
const queueLoc = `?${new URLSearchParams({ "location[directory]": host2.project }).toString()}`;
const queuePrompt = async (text: string): Promise<number> => {
  const r = await fetch(`${host2.baseUrl}/api/session/${sid}/prompt${queueLoc}`, {
    method: "POST",
    headers: H2,
    body: JSON.stringify({ text, delivery: "queue" }),
  });
  return r.status;
};
// Continuous external /inbox sampler: pins WHEN the host's pending list
// empties relative to turn ends / deliveries (claim-gap diagnosis — if the
// host claims queued items at turn end, /inbox reads [] at exactly the
// boundary moment the gate must see them).
const inboxRaw = async (): Promise<unknown> => {
  const r = await fetch(`${host2.baseUrl}/api/session/${sid}/inbox`, { headers: H2 });
  return (await r.json().catch(() => undefined)) ?? null;
};
const samples: Array<{ ts: string; n: number; ids: string[] }> = [];
let sampling = true;
void (async () => {
  while (sampling) {
    try {
      const j = await inboxRaw();
      const data = (j as any)?.data;
      samples.push({
        ts: new Date().toISOString(),
        n: Array.isArray(data) ? data.length : -1,
        ids: Array.isArray(data) ? data.map((x: any) => String(x.id ?? "?").slice(-6)) : [],
      });
    } catch {}
    await Bun.sleep(400);
  }
})();
// Follow-ups: two queued prompts sent mid-turn. REAL-HOST CONTRACT (field,
// 7 runs — /inbox sampler + event capture + mock request log): the host
// consumes queued items into the running execution's SUBSEQUENT model calls,
// and EXTENDS the execution while items are pending (pure turns = 1×12s call;
// a drip-fed turn ran 600s+ / 50+ calls). So /inbox is empty at every
// terminal — the 129 terminal shape (a NON-empty inbox at a boundary) is
// structurally unreachable in this lab: any pending item keeps the execution
// alive until it is consumed. (A positive hold is stub-proven — tests
// 27–30 — and will be observed on 129 in production, where real LLM turns
// have a wide final window: no model call follows the last one.)
// What the real host proves here:
//   5i — the real /inbox shape with queued items ({data: Item[]});
//   5j — the gate ran the real inbox query at EVERY boundary (every decision
//        line carries queued + ownKnown:true), and the 129 invariant held
//        across all of them: NO wake line with queued > 0;
//   5k — the loop keeps waking at successive boundaries (no silence).
// 5l arms HERE (not after 5k): the scripted execute call must land in a LIVE
// loop. Armed late, the no-action mock turns have already exhausted the stall
// limit and the loop's final request is a stall report — the script never
// fires. Armed now, the follow-up's turn carries the tool round-trip (a tool
// call IS an action — the stall counter resets, the loop lives on), and that
// turn's boundary wake is the Resume replay 5l-b looks for.
scripted.queued = 1;
console.log("5l: armed scripted goal_next_step (fires on the first real model request from here)");
const qStatus = await Promise.all([queuePrompt("follow-up one"), queuePrompt("follow-up two")]);
console.log("queued prompts (sent mid-turn):", JSON.stringify(qStatus));
// Wait for the phase's boundaries (5g's line + at least 3 more).
let boundaryLines: Array<Record<string, unknown>> = [];
{
  const dl = Date.now() + 420_000;
  while (Date.now() < dl) {
    boundaryLines = (await readDecisions()).filter((d) => d.sessionID === sid);
    if (boundaryLines.length >= 3) break;
    await Bun.sleep(500);
  }
}
// 5i: the sampler caught a queued item (the two follow-ups park in /inbox
// before being consumed mid-turn).
const inboxShape = samples.find((s) => s.n >= 2) ?? samples.find((s) => s.n >= 1);
check("5i: follow-ups sent mid-turn are QUEUED — /api/session/:id/inbox returns {data: Item[]}", inboxShape !== undefined, JSON.stringify(inboxShape ?? "(never saw a pending item)"));
// 5j: the gate consulted the real inbox at every boundary, and the 129
// invariant held: no wake was ever injected with pending queue items.
// (>= 3 lines: 5g's line + two post-queue boundaries — a drip-fed merge turn
// can shorten the wake sequence to exactly 3 before the stall limit; the
// invariant evidence is per-line, not a line count.)
{
  const gateRan =
    boundaryLines.length >= 3 &&
    boundaryLines.every((d) => typeof d.queued === "number" && d.ownKnown === true);
  const badWake = boundaryLines.find(
    (d) => d.decision === "wake" && typeof d.queued === "number" && (d.queued as number) > 0,
  );
  check(
    "5j: gate consulted the real inbox at EVERY boundary (queued + ownKnown on every line) and no wake carried a pending queue (the 129 invariant)",
    gateRan && badWake === undefined,
    `lines=${boundaryLines.length} badWake=${JSON.stringify(badWake ?? null)}`,
  );
}
check(
  "5k: the loop keeps WAKING at successive boundaries (queue drains, loop continues — no silence)",
  boundaryLines.filter((d) => d.decision === "wake" && (d.ts as string) > (boundaryLines[0]?.ts as string)).length >= 2,
  JSON.stringify(boundaryLines.map((d) => [d.ts, d.decision, d.queued])),
);

// ── 5l: goal_next_step record → host dispatch → replay loop (2026-10-20 ruling) ─
// The scripted mock fires ONE goal_next_step tool call on the first real model
// request after 5i armed it (count-based, tools-guarded — see the mock
// handler); it lands in the follow-up's turn. What the real host must prove:
// (a) dispatch the model's tool call to the plugin's tool and persist the
// record (5l-a), (b) the NEXT boundary wake replays the recorded plan as its
// Resume line (5l-b).
{
  // 5l-0: native exposure — ALL twelve goal_* tools sit in the host's model
  // tools array (2026-10-20 ruling extension: every goal tool is codemode:false;
  // the scripted call above is a direct tool_call, not an `execute` block).
  const goalToolNames = ["goal_set", "goal_complete", "goal_block", "goal_clear", "goal_history", "goal_add_task", "goal_update_task", "goal_next_step", "goal_wait", "goal_pause", "goal_resume", "goal_view"];
  const allNative = mockLog.find((m) => goalToolNames.every((n) => m.tools.includes(n)));
  check(
    "5l-0: all 12 goal_* tools are natively exposed (present in the host's tools array — codemode:false)",
    allNative !== undefined,
    allNative ? `tools=[${allNative.tools}]` : `never all present; last request tools=[${mockLog.at(-1)?.tools}]`,
  );
  let nextStep: unknown;
  const dlA = Date.now() + 180_000;
  while (Date.now() < dlA && !nextStep) {
    const g = await host2.api.goalsGet(sid);
    nextStep = g.output?.nextStep;
    if (!nextStep) await Bun.sleep(500);
  }
  check(
    "5l-a: the real host dispatched goal_next_step to the plugin and persisted it (record.nextStep set)",
    nextStep !== undefined && nextStep !== null,
    JSON.stringify(nextStep ?? null),
  );
  let resumeSeen: string | undefined;
  const dlB = Date.now() + 240_000;
  while (Date.now() < dlB && !resumeSeen) {
    for (const m of mockLog) {
      if (m.ts >= (scripted.fireTs ?? "0") && m.lastUser.includes("Resume — your last recorded next step")) {
        resumeSeen = m.lastUser;
        break;
      }
    }
    if (!resumeSeen) await Bun.sleep(500);
  }
  check(
    "5l-b: the next boundary wake REPLAYS the recorded plan (Resume line in the real model request)",
    resumeSeen !== undefined,
    JSON.stringify(resumeSeen ?? null),
  );
}

// ── 5m: reactivation + unbounded default (2026-10-20 ruling, spec §44) ──────
// The "done" mock never acts, so the loop exhausts the stall ladder and the
// goal STALLS (terminal; judge off by default). A terminal goal is never
// woken — a scripted call can only land on a USER-DRIVEN turn: exactly the
// external gating the ruling relies on. Sequence:
//   5m-0: the default goal is UNBOUNDED (no default cap — cap has no dims);
//   5m-a: the no-action loop STALLS the goal on the real host;
//   5m-b: a user prompt drives a turn whose first model request carries the
//         scripted NATIVE goal_next_step — the host dispatches it to the
//         plugin, which re-activates the goal (active + reactivation.from
//         "stalled" + used reset + fresh nextStep);
//   5m-c: the loop RESUMES — the next boundary wake carries the reactivation
//         line in a real model request.
{
  // 5m-0: unbounded by default — /goal set without --turns sets no cap.
  const g0 = await host2.api.goalsGet(sid);
  check(
    "5m-0: default goal is UNBOUNDED (no default cap — 2026-10-20 ruling)",
    (g0.output?.cap?.turns === undefined || g0.output?.cap?.turns === null) &&
      (g0.output?.cap?.tokens === undefined || g0.output?.cap?.tokens === null),
    JSON.stringify(g0.output?.cap ?? null),
  );
  // 5m-a: three no-action wake boundaries exhaust the stall ladder (stallLimit 3).
  let stalled = false;
  {
    const dlA = Date.now() + 300_000;
    while (Date.now() < dlA && !stalled) {
      const g = await host2.api.goalsGet(sid);
      stalled = g.output?.status === "stalled";
      if (!stalled) await Bun.sleep(1000);
    }
  }
  check(
    "5m-a: the no-action loop STALLS the goal on the real host (terminal — the loop goes silent)",
    stalled,
    JSON.stringify((await host2.api.goalsGet(sid)).output ?? null),
  );
  // 5m-b: arm the scripted native goal_next_step, then drive a USER turn —
  // the only way a terminal goal's next_step call can land (external gating).
  scripted.queued = 1;
  await host2.api.prompt(sid, "continue the work");
  let reactivated: any;
  {
    const dlB = Date.now() + 180_000;
    while (Date.now() < dlB && !reactivated) {
      const g = await host2.api.goalsGet(sid);
      reactivated = g.output?.status === "active" ? g.output : undefined;
      if (!reactivated) await Bun.sleep(1000);
    }
  }
  check(
    "5m-b: a user-driven goal_next_step RE-ACTIVATES the stalled goal (active + reactivation.from=stalled + used reset + fresh nextStep)",
    reactivated !== undefined &&
      reactivated?.reactivation?.from === "stalled" &&
      reactivated?.used?.turns === 0 &&
      reactivated?.used?.tokens === 0 &&
      reactivated?.nextStep !== undefined,
    JSON.stringify(reactivated ?? (await host2.api.goalsGet(sid)).output ?? null),
  );
  // 5m-c: the loop resumes — the next wake carries the reactivation line.
  let reactLine: string | undefined;
  {
    const dlC = Date.now() + 240_000;
    while (Date.now() < dlC && !reactLine) {
      for (const m of mockLog) {
        if (m.ts >= (scripted.fireTs ?? "0") && m.lastUser.includes("Reactivated from stalled")) {
          reactLine = m.lastUser;
          break;
        }
      }
      if (!reactLine) await Bun.sleep(500);
    }
  }
  check(
    "5m-c: the next boundary wake RESUMES the loop with the reactivation line (real model request)",
    reactLine !== undefined,
    JSON.stringify(reactLine ?? null),
  );
}

// ── Diagnostics (always, before stop): what the host EMITTED + what the
// plugin WARNED. The plugin's console.warn lands on serve stdout; the event
// capture file is a parallel /api/event subscriber (independent of the
// plugin's own subscription). Together they separate host-side event loss
// from plugin-side handling failures.
{
  host2.stopEventCapture();
  sampling = false;
  console.log("── mock model calls (which calls does the host make) ──");
  for (const m of mockLog) console.log(`  ${m.ts} msgs=${m.msgs} len=${m.len} last=${m.lastRole} tools=${m.tools} sys="${m.sys}" user="${m.lastUser}"`);
  console.log("── /inbox sample series (external poller, n changes only) ──");
  let lastN = -2;
  for (const s of samples) {
    if (s.n !== lastN) {
      console.log(`  ${s.ts} n=${s.n} ids=[${s.ids.join(", ")}]`);
      lastN = s.n;
    }
  }
  console.log("── plugin warnings (serve stdout, opencode-goal lines) ──");
  const warns = host2.stdoutTail().split("\n").filter((l) => l.includes("opencode-goal"));
  console.log(warns.length ? warns.join("\n") : "(none)");
  console.log("── host-emitted events (event capture, this session) ──");
  try {
    const raw = await readFile(evCapFile, "utf8");
    const lines = raw
      .split("data:")
      .map((seg) => seg.trim())
      .map((seg) => {
        try {
          const j = JSON.parse(seg.replace(/\n/g, " ").trim()) as Record<string, unknown>;
          return j as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((j): j is Record<string, unknown> => j !== undefined && (j.data as Record<string, unknown>)?.sessionID === sid || (j as Record<string, unknown>)?.sessionID === sid);
    for (const j of lines) {
      const d = (j.data ?? j) as Record<string, unknown>;
      const t = (j.type ?? d.type) as string;
      const ts = (j.created ?? (d.time as { created?: unknown } | undefined)?.created ?? (d as { time?: Record<string, unknown> }).time) ?? "";
      const extra = /inbox/.test(t) ? ` ${JSON.stringify({ inboxID: d.inboxID, itemID: (d.item as Record<string, unknown>)?.id })}` : "";
      if (/execution|inbox|prompt/.test(t)) console.log(`  ${t} ${JSON.stringify(ts)}${extra}`);
    }
  } catch (err) {
    console.log(`  (capture read failed: ${err})`);
  }
}

if (failures > 0) {
  // Diagnostics on FAIL: the plugin's console.warn (the real query failure
  // reason) lands on the host's stdout, not opencode.log — dump the tail.
  console.error("── host2 stdout tail ──");
  console.error(host2.stdoutTail() || "(empty)");
  console.error("── host2 log tail ──");
  try {
    console.error((await readFile(host2.logFile, "utf8")).split("\n").slice(-40).join("\n"));
  } catch {}
}
console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAIL"}`);
await host2.stop();
server.stop();
process.exit(failures === 0 ? 0 : 1);
