// Probe (one-shot, NOT a test): which events does the REAL host emit around a
// turn's end? Specifically: does session.idle fire, and how does it sequence
// vs session.execution.succeeded? (The controller treats all three of
// succeeded/failed/session.idle as terminal boundaries; the continuation
// window's sibling-skip assumes a succeeded→idle pair ms apart — this probe
// confirms that assumption on a real host.)
//
//   bun run scripts/probe-idle-event.ts
import { startHost, type ProviderSpec } from "./host.ts";

const MOCK_PORT = 47999;
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

const host = await startHost({ provider, keepDir: true, waitMs: 60_000 });
console.log("host up:", host.baseUrl);
const evFile = await host.startEventCapture(120);
const sid = await host.api.createSession();
console.log("session:", sid);
console.log("starting mock turn (12s)...");
void host.api.prompt(sid, "reply with exactly: done"); // POST may return at enqueue, not at turn end
// Wait until a terminal event lands in the capture file (or 45s).
const { readFile } = await import("node:fs/promises");
let endSeen = false;
for (let i = 0; i < 225 && !endSeen; i++) {
  await Bun.sleep(200);
  try {
    const t = await readFile(evFile, "utf8").catch(() => "");
    endSeen = /"type":"session\.execution\.(succeeded|failed|interrupted)"|"type":"session\.idle"/.test(t);
  } catch {}
}
console.log(`terminal event seen: ${endSeen}`);
// Does session.idle arrive LATER (delayed / on an inactivity timer)?
// Wait 30s past the terminal event, watching for it specifically.
const preLen = (await Bun.file(evFile).text().catch(() => "")).length;
await Bun.sleep(30_000);
const raw = await Bun.file(evFile).text().catch(() => "(no capture file)");
console.log(`session.idle within 30s after terminal: ${/"type":"session\.idle"/.test(raw.slice(preLen))} (+interrupted: ${/"type":"session\.execution\.interrupted"/.test(raw.slice(preLen))})`);

// SSE frames: "data: {...json...}" — extract each event's type (+ id tail + ts).
const frames: Array<{ id: string; type: string; created?: number }> = [];
for (const line of raw.split("\n")) {
  if (!line.startsWith("data:")) continue;
  try {
    const j = JSON.parse(line.slice(5).trim());
    frames.push({ id: String(j.id ?? "").slice(-6), type: String(j.type ?? "?"), created: j.time?.created ?? j.created });
  } catch {}
}
console.log(`\n${frames.length} events captured. Full sequence:`);
for (const f of frames) console.log(`  ${f.type.padEnd(38)} id=...${f.id}` + (f.created ? ` created=${new Date(f.created).toISOString()}` : ""));
// Raw tail for the end-of-turn frames (payloads: sessionID, sibling gap).
console.log("\nRAW TAIL (last 8 data frames):");
const dataLines = raw.split("\n").filter((l) => l.startsWith("data:"));
for (const l of dataLines.slice(-8)) console.log("  " + l.slice(0, 400));
const endTypes = frames.filter((f) => /execution|idle|interrupt/.test(f.type)).map((f) => f.type);
console.log(`\nEND-OF-TURN RELEVANT: ${JSON.stringify(endTypes)}`);

await host.stop();
server.stop();
process.exit(0);
