// One-off §60 diagnostic: what does GET /api/shell actually return for a
// server-fired shell (metadata? sessionID? timing?), and does the same
// before/after claim logic the controller uses find it?
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { startHost, labProvider, type IsolatedHost } from "./host.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const provider = await labProvider();
  const host: IsolatedHost = await startHost({ provider, waitMs: 30_000, keepDir: process.env.KEEP_DIR === "1" });
  const svcDir = join(host.directory, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: host.baseUrl, pid: host.pid, password: host.password }));
  const S = await host.api.createSession();
  console.log(`session ${S}`);

  const raw = async (): Promise<any> => {
    const loc = `location[directory]=${encodeURIComponent(host.project)}`;
    const r = await fetch(`${host.baseUrl}/api/shell?${loc}`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}` },
    });
    return { status: r.status, body: await r.json().catch(() => r.text()) };
  };

  console.log("before fire:", JSON.stringify(await raw()));
  const fired = await (async () => {
    const r = await fetch(`${host.baseUrl}/api/session/${S}/shell`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "sleep 5" }),
    });
    console.log("POST /shell:", r.status, JSON.stringify(await r.text()));
  })();
  console.log("fire result:", JSON.stringify(fired));

  for (let i = 1; i <= 6; i++) {
    await sleep(500);
    const { status, body } = await raw();
    const data = Array.isArray(body) ? body : body?.data ?? [];
    console.log(`t=${i * 500}ms status=${status} entries=${data.length}`);
    for (const e of data) console.log("  entry:", JSON.stringify(e));
    if (i === 3) break; // the controller polls 6x500ms; the shape at t=1.5s is what matters
  }
  await host.stop();
}

void main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
