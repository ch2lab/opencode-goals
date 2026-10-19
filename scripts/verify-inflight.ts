// Real-host verification of the 2026-10-19 query-based in-flight gate (化繁为简).
// Boots the ISOLATED real host (mock LLM, no external creds, no 129), loads the
// plugin from source, and confirms on REAL /api/session data:
//   1. the plugin loads ACTIVE on a real host;
//   2. GET /api/session returns the goal's project's sessions — via BOTH the
//      bracket-query form and the x-opencode-directory HEADER (what sessionList
//      now sends, location-scoped) — the one thing the stub harness cannot prove;
//   3. the in-flight -> done signal my countSubtasksInFlight reads
//      (time.idle absent mid-turn; present & >= updated after) holds on real data.
//
//   bun run scripts/verify-inflight.ts
// NOT a bun test — manual/live use only.
import { startHost, type ProviderSpec } from "./host.ts";

const MOCK_PORT = 47997;
let toolDumped = false;
const server = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text().catch(() => "");
    let stream = false, title = false;
    try {
      const b = JSON.parse(raw || "{}");
      stream = !!b.stream;
      const last = (b.messages ?? [])[b.messages.length - 1];
      title = last?.role === "assistant" && raw.length < 600;
      if (!toolDumped && Array.isArray(b.tools)) {
        toolDumped = true;
        const sa = b.tools.find((t: any) => t?.function?.name === "subagent");
        console.error("subagent tool:", JSON.stringify(sa));
      }
    } catch {}
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mock-model" }] });
    await new Promise((r) => setTimeout(r, title ? 50 : 12_000)); // slow real turn
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

// 1. plugin ACTIVE on the real host
let active = false;
for (let i = 0; i < 40 && !active; i++) {
  const ps = await host.api.plugins();
  const p = (ps ?? []).find((x: any) => x?.id === "opencode-goal");
  active = p?.state?.status === "active";
  if (!active) await Bun.sleep(500);
}
check("1: plugin ACTIVE on real host", active);

const sid = await host.api.createSession();
console.log("session:", sid, "project:", host.project);
const snap = async () => (await get(`/api/session/${sid}`))?.data;

// 2. the raw GET /api/session — the endpoint my sessionList() calls, WITHOUT a
//    location. Does it return the created session? (The whole fix depends on it.)
const listNoLoc = (await get("/api/session"))?.data ?? [];
const listLoc = (await get(`/api/session?location[directory]=${encodeURIComponent(host.project)}`))?.data ?? [];
console.log(`  GET /api/session (no location)   → ${listNoLoc.length} sessions`);
console.log(`  GET /api/session (location-scope)→ ${listLoc.length} sessions`);
check("2a: GET /api/session WITHOUT location returns the session", listNoLoc.some((s: any) => s?.id === sid));
check("2b: GET /api/session location-scoped (bracket query) returns the session", listLoc.some((s: any) => s?.id === sid));
// 2c: THE FORM MY NEW sessionList() ACTUALLY USES — the x-opencode-directory
// header (hostapi locationHeader), not the bracket query. Confirm the real host
// honors the header form for /api/session (the gap left by the bracket-query test).
const listHdr = ((await (await fetch(`${host.baseUrl}/api/session`, {
  headers: { ...H, "x-opencode-directory": encodeURIComponent(host.project) },
})).json()) as any)?.data ?? [];
console.log(`  GET /api/session (x-opencode-directory header) → ${listHdr.length} sessions`);
check("2c: GET /api/session via x-opencode-directory HEADER (what sessionList now sends) returns the session", listHdr.some((s: any) => s?.id === sid));

// 3. in-flight -> done signal on a REAL turn.
const promptP = (async () => {
  const r = await fetch(`${host.baseUrl}/api/session/${sid}/prompt`, {
    method: "POST", headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ text: "reply with exactly: done" }),
  });
  return { status: r.status, len: (await r.text()).length };
})();

let mid: any = null, after: any = null;
for (let i = 0; i < 60 && (mid === null || after === null); i++) {
  const s = await snap();
  if (s?.time) {
    if (mid === null && s.time.idle === undefined) mid = s; // in-flight: no idle yet
    if (after === null && s.time.idle !== undefined && s.time.updated !== undefined && s.time.idle >= s.time.updated) after = s;
  }
  await Bun.sleep(400);
}
await promptP;
console.log("  MID-TURN time:", JSON.stringify(mid?.time));
console.log("  AFTER    time:", JSON.stringify(after?.time));
check("3a: in-flight signal — mid-turn time.idle absent", mid?.time?.idle === undefined, JSON.stringify(mid?.time));
check("3b: done signal — after time.idle present & >= updated", after?.time?.idle !== undefined && after?.time?.idle >= after?.time?.updated, JSON.stringify(after?.time));

// 4. field presence on the real list item (what my normalizer + gate read).
const item = (listLoc.find((s: any) => s?.id === sid) ?? listNoLoc.find((s: any) => s?.id === sid)) as any;
check("4: real session item has id + time.updated", item?.id === sid && item?.time?.updated !== undefined);
// A freshly-created ROOT session has no parentID (the host omits the key) — which
// is correct: it is not anyone's subtask. (A real child's parentID was already
// confirmed on the 129 live data last session; the mock LLM can't spawn subagents.)
check("4b: root session has NO parentID (correctly not a subtask)", item?.parentID === undefined, `parentID=${JSON.stringify(item?.parentID)}`);

console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAIL"}`);
await host.stop();
server.stop();
process.exit(failures === 0 ? 0 : 1);
