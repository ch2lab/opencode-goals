// Publish @ch2lab/opencode-goals to npm.
//
// Why a build step: the repo entry (index.ts) wraps the plugin in
// Plugin.define from "@opencode/plugin" (a devDependency used for typing
// only). The HOST-VERIFIED form is the stripped variant — a plain
// `{ id, setup }` export with zero runtime imports (this is what every live
// seed ran with). Publishing the stripped variant keeps the published
// package dependency-free and immune to @opencode/plugin version drift.
//
// Usage: bun run scripts/publish.mjs [publish|pack]
//   pack    — stage + verify + produce the tarball (default, no auth needed)
//   publish — pack, then `npm publish --access public`
import { readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const STAGE = join(ROOT, ".publish-staging");
const mode = process.argv[2] ?? "pack";

// --- strip the wrapper (same transform as the live-seed recipe) -----------
let src = readFileSync(join(ROOT, "index.ts"), "utf8");
const stripped = src
  .replace(/^import \{ Plugin \} from "@opencode\/plugin";\r?\n/m, "")
  .replace(/^import type \{ Registration \} from "@opencode\/plugin\/promise\/registration";\r?\n/m, "")
  .replace(/^type PendingRegistration = Promise<Registration \| undefined>;\r?\n/m, "")
  .replace("export default Plugin.define({", "export default {")
  .replace(/\}\);[ \t]*\r?\n?$/, "};\n");
// Hard gate: the published entry must have zero host-type imports.
if (/@opencode\/plugin|Plugin\.define/.test(stripped)) {
  console.error("FATAL: strip transform left wrapper residue — refusing to publish");
  process.exit(1);
}

// --- stage ----------------------------------------------------------------
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "src"), { recursive: true });
writeFileSync(join(STAGE, "index.ts"), stripped);
cpSync(join(ROOT, "src"), join(STAGE, "src"), { recursive: true });
// The staged package.json "files" declares README.md — it must exist here
// or npm pack silently ships 11 files without it (npmjs page: "no README").
cpSync(join(ROOT, "README.md"), join(STAGE, "README.md"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
writeFileSync(join(STAGE, "package.json"), JSON.stringify(pkg, null, 2));
console.log(`staged ${STAGE} (entry stripped, ${pkg.name}@${pkg.version})`);

// --- pack / publish ---------------------------------------------------------
const out = execSync(`npm pack --pack-destination "${STAGE}"`, { cwd: STAGE, encoding: "utf8" });
console.log(out.trim());
const tarball = STAGE + "/" + out.trim().split(/\r?\n/).pop();
console.log("tarball:", tarball);

// --- hard gate: the packed tarball must contain every declared file --------
// `files` in package.json is a promise; npm silently ships only what is
// physically present in STAGE (missing entries vanish without error).
// The npm pack *text output* is unreliable to parse (ANSI codes split file
// names mid-token even in captured output), so read the actual tarball index
// with `tar -tf` — the ground truth of what will be published.
const tarListing = execSync(`tar -tf "${tarball}"`, { encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .map((l) => l.replace(/^package\//, ""))
  .filter(Boolean);
const missing = (Array.isArray(pkg.files) ? pkg.files : []).filter((entry) => {
  const isDir = existsSync(join(STAGE, entry)) && statSync(join(STAGE, entry)).isDirectory();
  return !tarListing.some((p) => (isDir ? p.startsWith(entry + "/") : p === entry));
});
if (missing.length > 0) {
  console.error(`FATAL: tarball is missing declared file(s): ${missing.join(", ")} — refusing to publish`);
  console.error("tarball index:\n" + tarListing.join("\n"));
  process.exit(1);
}
console.log(`listing gate: PASS (${tarListing.length} files in tarball, all declared files present)`);
if (mode === "publish") {
  if (!existsSync(tarball)) throw new Error("tarball missing after pack");
  execSync(`npm publish "${tarball}" --access public`, { cwd: STAGE, stdio: "inherit" });
  console.log("published @ch2lab/opencode-goals");
} else {
  console.log("dry run (pack only). Re-run with [publish] after `npm login`.");
}
