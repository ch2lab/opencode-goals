// Probe: what field on GET /api/session marks a session as CURRENTLY EXECUTING
// (mid-turn)? The in-flight gate (query-based discovery) needs a reliable
// "is this subtask turn running" signal. Boots the real isolated host
// (scripts/host.ts) with a LOCAL MOCK LLM (slow response, no external creds),
// fires a prompt, and snapshots the session object mid-turn vs. after, to diff
// out the liveness field.
//
//   bun run scripts/probe-executing.ts
//
// NOT a test (no .test suffix, not in the `bun test` gate) — manual/live use.

import { startHost, type ProviderSpec } from "./host.ts";

const MOCK_PORT = 47999;
// Local OpenAI-compatible mock: /models -> roster; anything else -> a valid
// completion after a 12s hold (a "slow" turn, giving a wide observation window).
const server = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text().catch(() => "");
    let stream = false;
    let roleHint = "";
    try {
      const b = JSON.parse(raw || "{}");
      stream = !!b.stream;
      const last = (b.messages ?? [])[b.messages.length - 1];
      roleHint = last?.role ?? "";
    } catch {}
    console.log(`[mock] ${req.method} ${url.pathname} stream=${stream} lastRole=${roleHint} t=${Date.now()}`);
    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "mock-model", object: "model", created: 0, owned_by: "mock" }],
      });
    }
    // Title generation (short system/assistant, no tools) returns instantly so
    // it doesn't eat the observation window; the real prompt gets the 10s hold.
    const isTitle = roleHint === "assistant" && raw.length < 600;
    await new Promise((r) => setTimeout(r, isTitle ? 50 : 10_000));
    const content = isTitle ? "mock title" : "done";
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
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
  },
});

const provider: ProviderSpec = {
  id: "mock",
  name: "mock",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: `http://127.0.0.1:${MOCK_PORT}`, apiKey: "dummy" },
  model: {
    id: "mock-model",
    name: "mock-model",
    limit: { context: 32768, output: 1024 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
  modelID: "mock/mock-model",
};

const host = await startHost({ provider, keepDir: true });
console.log("host up:", host.baseUrl, "dir:", host.directory);
const H = { authorization: "Basic " + Buffer.from(`opencode:${host.password}`).toString("base64") };
const get = async (p: string): Promise<any> => (await fetch(`${host.baseUrl}${p}`, { headers: H })).json();

const sid = await host.api.createSession();
console.log("session:", sid);
const snap = async () => (await get(`/api/session/${sid}`))?.data;

const t0 = Date.now();
// Fire the prompt; drain the body so the connection stays open for the whole
// turn (mirrors the host.ts session-shell fire pattern).
const promptP = (async () => {
  const r = await fetch(`${host.baseUrl}/api/session/${sid}/prompt`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ text: "reply with exactly: done" }),
  });
  const body = await r.text();
  return { status: r.status, len: body.length };
})();

for (let i = 0; i < 40; i++) {
  const s = await snap();
  if (s) {
    const brief = {
      outcome: s.outcome,
      time: s.time,
      busy: s.busy,
      running: s.running,
      executing: s.executing,
      state: s.state,
      status: s.status,
    };
    console.log(`t=${Date.now() - t0}ms`, JSON.stringify(brief));
    if (i === 6) console.log("FULL MID-TURN:\n" + JSON.stringify(s, null, 2));
  }
  await Bun.sleep(400);
}
console.log("prompt result:", JSON.stringify(await promptP));
console.log("AFTER:\n" + JSON.stringify(await snap(), null, 2));

await host.stop();
server.stop();
