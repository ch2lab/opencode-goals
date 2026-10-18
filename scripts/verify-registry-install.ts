// End-to-end registry verification (manual/live, NOT a test file).
// Simulates "install on another terminal": an isolated host (fresh XDG envs,
// empty plugin cache) with ONLY the registry spec — the host itself fetches
// @ch2lab/opencode-goals from the public npm registry, then we poll /api/plugin
// until the plugin reports active and exercise the goal lifecycle.
//
// Usage: bun run scripts/verify-registry-install.ts
import { startHost } from "./host.ts";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const results: Array<[string, string, string]> = [];
const rec = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok ? "PASS" : "FAIL", detail]);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

const host = await startHost({ config: { plugins: [{ package: "@ch2lab/opencode-goals", options: {} }] } });
let failed = false;
try {
  // The host fetches from npm asynchronously; plugin registration lags ready.
  let ours: any = undefined;
  for (let i = 0; i < 45; i++) {
    ours = (await host.api.plugins()).find((p: any) => p.id === "opencode-goal");
    if (ours) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  rec("registry-fetch+active", ours?.state?.status === "active", `state=${ours?.state?.status ?? "MISSING"} (source: ${JSON.stringify(ours?.source ?? {}).slice(0, 140)})`);

  const s = await host.api.createSession();
  const set = await host.api.command(s, "goal", "set 只输出一句话确认收到 --turns 2");
  const g0 = (await host.api.goalsGet(s)).output;
  rec("goal-lifecycle", set === 204 && g0?.status === "active" && g0?.cap?.turns === 2 && g0.cap.tokens === undefined, `set HTTP ${set}, status=${g0?.status}, cap=${JSON.stringify(g0?.cap)}`);
  await host.api.command(s, "goal", "block verify-registry-install-cleanup");
  const g1 = (await host.api.goalsGet(s)).output;
  rec("goal-block", g1?.status === "blocked", `terminal=${g1?.status}`);

  // The fetched package should now sit in the host's private cache.
  const cached = join(host.directory, "cache");
  rec("cache-populated", (await stat(cached).then(() => true).catch(() => false)), `host cache dir present at ${cached}`);
} catch (err) {
  failed = true;
  rec("isolated-host-flow", false, `crashed: ${String(err).slice(0, 300)}`);
} finally {
  await host.stop();
}

const fails = results.filter(([, s]) => s === "FAIL").length;
console.log(`\n== verify-registry-install: ${fails === 0 ? "ALL PASS" : "HAS FAILURES"} (${results.length} records) ==`);
process.exit(failed || fails > 0 ? 1 : 0);
