// Real-host end-to-end, part 1: does the isolated real host actually create a
// REAL subtask (child session) with parentID = the parent session, and is that
// child in-flight (time.idle absent) while its turn runs?
//
// The mock LLM dispatches a BACKGROUND `subagent` tool call on the parent's first
// turn (parent returns immediately), then holds the child's turn 15s (a wide
// in-flight window). The host spawns a real child session; we poll
// GET /api/session for a session whose parentID === the parent and check its
// time signal.
//
//   bun run scripts/verify-subtask.ts
// NOT a bun test — manual/live use only.
import { startHost, type ProviderSpec } from "./host.ts";

const MOCK_PORT = 47998;
const server = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text().catch(() => "");
    let b: any = {};
    try { b = JSON.parse(raw || "{}"); } catch {}
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "mock-model" }] });
    const messages = b.messages ?? [];
    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    const isChild = typeof lastUser?.content === "string" && lastUser.content.includes("CHILD_HOLD");
    const hasTool = messages.some((m: any) => m.role === "tool");
    const stream = !!b.stream;

    const finish = (content: string | null, tool?: { name: string; args: any }) => {
      if (stream) {
        const d1: any = { role: "assistant", content: content ?? null };
        if (tool) d1.tool_calls = [{ index: 0, id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }];
        const chunks = [
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: d1 }] },
          { id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
        ];
        const sse = chunks.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(new TextEncoder().encode(sse), { headers: { "content-type": "text/event-stream" } });
      }
      const message: any = { role: "assistant", content };
      if (tool) message.tool_calls = [{ id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }];
      return Response.json({
        id: "x", object: "chat.completion", created: 0, model: "mock-model",
        choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    };

    if (isChild) {
      await new Promise((r) => setTimeout(r, 15_000)); // keep the child in-flight
      return finish("done");
    }
    if (hasTool) return finish("done"); // parent, after the subagent result → end turn
    // parent's first turn → dispatch a BACKGROUND subagent (parent returns immediately)
    return finish(null, { name: "subagent", args: { agent: "general", description: "slow child", prompt: "CHILD_HOLD reply done", background: true } });
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
const H = { authorization: "Basic " + Buffer.from(`opencode:${host.password}`).toString("base64") };
const get = async (p: string): Promise<any> => (await fetch(`${host.baseUrl}${p}`, { headers: H })).json();

const sid = await host.api.createSession();
console.log("parent session:", sid);

const promptP = fetch(`${host.baseUrl}/api/session/${sid}/prompt`, {
  method: "POST", headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify({ text: "dispatch the subagent now" }),
});

// Poll for a child session whose parentID === sid (the real subtask).
let child: any = null;
for (let i = 0; i < 60 && !child; i++) {
  const list = (await get("/api/session"))?.data ?? [];
  child = list.find((s: any) => s?.parentID === sid);
  if (!child) await Bun.sleep(500);
}
console.log("\nCHILD:", JSON.stringify(child ? { id: child.id, parentID: child.parentID, time: child.time, outcome: child.outcome } : null));
const inFlight = !!child && (child.time?.idle === undefined || (child.time?.updated !== undefined && child.time?.idle < child.time?.updated));
console.log("child in-flight (time.idle absent or < updated):", inFlight);
await promptP.catch(() => {});
await host.stop();
server.stop();
console.log(child ? (inFlight ? "\nREAL IN-FLIGHT SUBTASK VERIFIED on real host" : "\nchild exists but not in-flight at sample") : "\nNO child found");
process.exit(child ? 0 : 1);
