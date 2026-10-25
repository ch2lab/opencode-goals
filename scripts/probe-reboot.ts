// PROBE: which pre-existing file(s) block a SECOND `serve` boot in the same
// data dir (the verify-persist P5b failure — host B halts after "cli
// starting": no db bootstrap, no plugin load, while HTTP half-answers).
// Matrix: fresh dir (control) / as-left / -wal+-shm removed / state wiped /
// cache wiped. Each variant: start host, wait, judge by its log lines.
import { join } from "node:path";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { startHost, type IsolatedHost } from "./host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeStateDir(): Promise<{ dir: string; host: IsolatedHost }> {
  // variant 0: a pristine host (gives us a data dir with db + service.json)
  const h = await startHost({ waitMs: 60_000, keepDir: true, config: { plugins: [] } });
  await sleep(3000); // let it write db + service.json
  return { dir: h.directory, host: h };
}

async function judge(dir: string, tag: string): Promise<boolean> {
  // did the boot proceed past "cli starting"?
  const log = join(dir, "data", "opencode", "log", "opencode.log");
  const h = await startHost({ waitMs: 60_000, keepDir: true, dir: dir, config: { plugins: [] } });
  await sleep(12_000);
  const lines = (await readdir(join(dir, "data", "opencode", "log")).then(() => import("node:fs")).then(fs => fs.readFileSync(log, "utf8"))).split("\n").filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const progressed = lines.some((l) => l.includes("location services booted") || l.includes("database schema bootstrap completed"));
  console.log(`${tag}: ${lines.length} log lines; last="${last.slice(0, 120)}"; progressed=${progressed}`);
  await h.stop();
  return progressed;
}

async function main(): Promise<void> {
  const { dir, host } = await makeStateDir();
  console.log(`state dir ready: ${dir}`);
  await host.stop(); // hard kill, like the incident

  // V1: as-left (db + wal + shm + state + cache)
  await judge(dir, "V1 as-left          ");

  // V2: checkpoint WAL first, then remove -wal/-shm
  {
    const db = new Database(join(dir, "data", "opencode", "opencode.db"));
    db.query("PRAGMA wal_checkpoint(TRUNCATE);").all();
    db.close();
  }
  for (const f of ["-wal", "-shm"]) {
    await rm(join(dir, "data", "opencode", `opencode.db${f}`), { force: true });
  }
  await judge(dir, "V2 wal checkpointed");

  // V3: also wipe the state dir
  await rm(join(dir, "state"), { recursive: true, force: true });
  await mkdir(join(dir, "state", "opencode"), { recursive: true });
  await judge(dir, "V3 state wiped      ");

  // V4: also wipe the cache dir
  await rm(join(dir, "cache"), { recursive: true, force: true });
  await mkdir(join(dir, "cache"), { recursive: true });
  await judge(dir, "V4 cache wiped      ");
}

main().catch((e) => {
  console.error("probe fatal:", e);
  process.exit(1);
});
