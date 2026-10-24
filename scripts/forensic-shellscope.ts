// READ-ONLY forensics (2026-10-24, host 2.1.4): verify-checkin K4 failed with
// `own=0, ownKnown=true` on every boundary while the raw global /api/shell
// DID show the server-fired shell running. Question: does the LOCATION-SCOPED
// /api/shell query (x-opencode-directory header — the plugin's view) still
// return the entry on 2.1.4? Isolated throwaway host, no plugin, no provider.
import { startHost, type IsolatedHost } from "./host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const host: IsolatedHost = await startHost({ waitMs: 60_000, config: { plugins: [] } });
  console.log(`[forensic] host up (port ${host.port}, pid ${host.pid})`);
  const auth = {
    Authorization: "Basic " + Buffer.from(`opencode:${host.password}`).toString("base64"),
  };
  const get = async (p: string, extra?: Record<string, string>) => {
    const r = await fetch(host.baseUrl + p, { headers: { ...auth, ...(extra ?? {}) } });
    return { status: r.status, body: await r.text() };
  };

  const S = await host.api.createSession();
  console.log(`[forensic] session ${S}`);
  const sessRes = await get("/api/session");
  const sessions = (JSON.parse(sessRes.body).data ?? []) as Array<{ id: string; location?: { directory?: string } }>;
  const me = sessions.find((s) => s.id === S);
  const dir = me?.location?.directory;
  console.log(`[forensic] session location: ${JSON.stringify(me?.location)} (dir=${dir})`);

  await host.api.sessionShellFire(S, "sleep 60");
  await sleep(3000);
  const raw = await get("/api/shell");
  console.log(`[forensic] RAW global /api/shell (status ${raw.status}): ${raw.body.slice(0, 2500)}`);
  if (dir) {
    const scoped = await get("/api/shell", { "x-opencode-directory": encodeURIComponent(dir) });
    console.log(`[forensic] SCOPED /api/shell x-opencode-directory=${dir} (status ${scoped.status}): ${scoped.body.slice(0, 2500)}`);
  }
  const active = await get("/api/session/active");
  console.log(`[forensic] active: ${active.body.slice(0, 400)}`);
  await host.stop();
}

main().catch((e) => {
  console.error("[forensic] fatal:", e);
  process.exit(1);
});
