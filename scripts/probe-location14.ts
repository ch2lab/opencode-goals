// probe 14: location query with FULL path (no 8.3 short name) — does it route?
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execSync } from "node:child_process";

const HOST =
  "C:\\Users\\Adminstrator\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.0.32-x64\\opencode-cli.exe";
const USER_CONFIG = "C:\\Users\\Adminstrator\\.config\\opencode\\opencode.jsonc";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const userCfg = JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
const stamp = Date.now();
// force FULL names everywhere (os.tmpdir() returns the 8.3 short name ADMINS~1)
const tmp = path.join("C:\\Users\\Adminstrator\\AppData\\Local\\Temp", `opencode-probe14-${stamp}`);
const state = path.join(tmp, "state");
const ws = path.join(tmp, "workspace");
const data = path.join(tmp, "data");
const cfg = path.join(tmp, "config");
for (const d of [state, ws, data, cfg]) fs.mkdirSync(d, { recursive: true });
const port = 53000 + (stamp % 299);
fs.mkdirSync(path.join(state, "opencode"), { recursive: true });
fs.mkdirSync(path.join(cfg, "opencode"), { recursive: true });
fs.writeFileSync(path.join(cfg, "opencode", "service.json"), JSON.stringify({ port }));
const isoCfg = { model: userCfg.model, providers: userCfg.providers, plugins: [] };
const logPath = path.join(os.tmpdir(), `opencode-probe14-${stamp}.log`);
const logFd = fs.openSync(logPath, "w");
const child = spawn(HOST, ["serve", "--service", "--print-logs"], {
  cwd: ws,
  env: {
    ...process.env,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: cfg,
    XDG_DATA_HOME: data,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(isoCfg),
  },
  stdio: ["ignore", logFd, logFd],
});

let base = "";
let auth = "";
const api = async (method: string, p: string, body?: unknown) => {
  try {
    const r = await fetch(base + p, {
      method,
      headers: { Authorization: auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: -1, text: `ERR ${(e as Error).message}` };
  }
};

try {
  const regFile = path.join(state, "opencode", "service.json");
  const end = Date.now() + 30_000;
  let reg;
  while (!reg) {
    if (Date.now() > end) throw new Error("no service.json");
    if (fs.existsSync(regFile)) reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
    else await sleep(300);
  }
  base = `http://${reg.url.replace(/^https?:\/\//, "").replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:")}`;
  auth = "Basic " + Buffer.from(`opencode:${reg.password}`).toString("base64");
  console.log(`ws=${ws}`);

  const r1 = await api("POST", "/api/session", { location: { directory: ws } });
  const sid = (JSON.parse(r1.text || "{}").data as { id: string } | undefined)?.id;
  console.log(`session=${sid} (status ${r1.status})`);

  // A: bare POST (no query)
  console.log(`bare POST /api/shell -> ${(await api("POST", "/api/shell", { command: "pwsh -c Start-Sleep 3" })).status}`);
  // B: POST with location query (FULL path)
  const c1 = await api("POST", `/api/shell?location.directory=${encodeURIComponent(ws)}`, {
    command: "pwsh -c Start-Sleep 25",
    metadata: { probe: "14" },
  });
  console.log(`CREATE with loc query: ${c1.status} ${c1.text.slice(0, 300)}`);
  const id1 = (JSON.parse(c1.text || "{}").data as { id?: string } | undefined)?.id;
  // C: LIST with location query
  await sleep(1500);
  const l1 = await api("GET", `/api/shell?location.directory=${encodeURIComponent(ws)}`);
  console.log(`LIST with loc query: ${l1.status} ${l1.text.slice(0, 300)}`);
  console.log(`>> listed id ${id1 ?? "?"}: ${l1.text.includes(id1 ?? "zzz")}`);
  // D: disk evidence
  await sleep(1000);
  const disk = fs
    .readdirSync(path.join(data, "opencode", "shell"), { recursive: true })
    .filter((f) => String(f).endsWith(".out"));
  console.log("disk .out:", disk.join("\n  "));
} finally {
  try {
    child.kill();
    await sleep(1500);
    if (child.exitCode === null) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* */
  }
  fs.closeSync(logFd);
}
console.log(`log: ${logPath}`);
