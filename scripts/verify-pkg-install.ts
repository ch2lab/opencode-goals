// Pre-publish verification (manual/live, NOT a test file — no .test suffix).
//
// Simulates "installing on another terminal" as faithfully as possible WITHOUT
// publishing: `bun install <tarball>` in a scratch dir reproduces the exact
// node_modules layout the host would create after a registry fetch, then an
// isolated host boots with the unpacked package as a directory plugin entry
// (directory install = the host-verified form). Exercises:
//   1. tarball layout (entry stripped, 9 src files, package.json)
//   2. host loads the package -> plugin active
//   3. /goal set -> /goal view (checks the NEW default semantics:
//      "2 turns / unbounded tokens") -> /goal block -> terminal
// The only step not covered (registry resolution) is verified post-publish.
//
// Usage: bun run scripts/verify-pkg-install.ts
import { rm, mkdir, stat, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { startHost, TMP_BASE } from "./host.ts";

// Version-agnostic: derive the staged tarball name from the repo manifest.
const REPO_PKG = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8"));
const TARBALL = join(
  import.meta.dir,
  "..",
  ".publish-staging",
  `${REPO_PKG.name.replace("@", "").replace("/", "-")}-${REPO_PKG.version}.tgz`,
);
const scratch = join(TMP_BASE, "npmpkg-verify");

const results: Array<[string, string]> = [];
const rec = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok ? "PASS" : "FAIL"]);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

// 1. unpack the tarball exactly like a registry install would
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
// bun requires a package.json in cwd to treat the dir as the project root.
await writeFile(join(scratch, "package.json"), '{ "name": "scratch", "private": true }');
execSync(`bun install ${JSON.stringify(TARBALL)}`, { cwd: scratch, stdio: "pipe" });
const pkg = join(scratch, "node_modules", "@ch2lab", "opencode-goals");
for (const f of ["index.ts", "src/state.ts", "src/types.ts", "src/options.ts", "src/controller.ts", "src/judge.ts", "src/evidence.ts", "src/permission.ts", "src/wake.ts", "src/compact.ts", "package.json", "README.md"]) {
  await stat(join(pkg, f)); // throws if missing
}
rec("tarball-layout", true, "bun install unpacked all 12 files (entry + 9 src + package.json + README.md)");
const entry = await readFile(join(pkg, "index.ts"), "utf8");
rec("entry-stripped", !/@opencode\/plugin|Plugin\.define/.test(entry), "published entry has zero host-type imports / wrapper residue");
const pkgJson = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
rec("pkg-metadata", pkgJson.name === REPO_PKG.name && pkgJson.version === REPO_PKG.version, `name=${pkgJson.name} version=${pkgJson.version}`);

// 2+3. isolated host with the unpacked package; set -> view -> block
const host = await startHost({ config: { plugins: [{ package: pkg, options: {} }] } });
let failed = false;
try {
  const plugins = await host.api.plugins();
  // Plugin registration lags host ready by a couple of seconds — poll.
  let ours = plugins.find((p: any) => p.id === "opencode-goal");
  for (let i = 0; !ours && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    ours = (await host.api.plugins()).find((p: any) => p.id === "opencode-goal");
  }
  rec("host-loads-pkg", ours?.state?.status === "active", `plugin state=${ours?.state?.status ?? "MISSING"} (source: ${JSON.stringify(ours?.source ?? {}).slice(0, 120)})`);

  const s = await host.api.createSession();
  const set = await host.api.command(s, "goal", "set 只输出一句话确认收到，不要调用任何工具 --turns 2");
  rec("goal-set", set === 204, `/goal set HTTP ${set}`);
  const g0 = (await host.api.goalsGet(s)).output;
  rec("goal-state", g0?.status === "active" && g0?.cap?.turns === 2 && g0.cap.tokens === undefined, `status=${g0?.status} cap=${JSON.stringify(g0?.cap)}`);

  await host.api.command(s, "goal", "view");
  const ctx = JSON.stringify(await host.api.context(s));
  rec("view-new-semantics", ctx.includes("2 turns / unbounded tokens"), "view reports turns-only default cap (tokens = statistics, published build carries 1773a4f)");

  const block = await host.api.command(s, "goal", "block verify-pkg-install-cleanup");
  const g1 = (await host.api.goalsGet(s)).output;
  rec("goal-block", block === 204 && g1?.status === "blocked", `block HTTP ${block} -> status=${g1?.status}`);
} catch (err) {
  failed = true;
  rec("isolated-host-flow", false, `crashed: ${String(err).slice(0, 300)}`);
} finally {
  await host.stop();
}

console.log(`\n== verify-pkg-install: ${results.filter(([, s]) => s === "FAIL").length === 0 ? "ALL PASS" : "HAS FAILURES"} (${results.length} records) ==`);
await rm(scratch, { recursive: true, force: true });
process.exit(failed || results.some(([, s]) => s === "FAIL") ? 1 : 0);
