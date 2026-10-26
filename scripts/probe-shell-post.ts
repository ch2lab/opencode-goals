// One-off §60 diagnostic: POST /api/session/:id/shell response timing/shape.
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
  const auth = `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}`;

  for (const cmd of ["sleep 3", "sleep 3"]) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${host.baseUrl}/api/session/${S}/shell`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ command: cmd }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await r.text();
      console.log(`POST "${cmd}": ${Date.now() - t0}ms status=${r.status} body="${body.slice(0, 200)}"`);
    } catch (err) {
      console.log(`POST "${cmd}": ${Date.now() - t0}ms THREW: ${String(err).slice(0, 200)}`);
    }
  }
  await sleep(100);
  const r2 = await fetch(`${host.baseUrl}/api/shell?location[directory]=${encodeURIComponent(host.project)}`, { headers: { authorization: auth } });
  const j: any = await r2.json();
  console.log("store now:", JSON.stringify(j.data ?? j));
  await host.stop();
}

void main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
