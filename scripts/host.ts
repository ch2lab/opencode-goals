// Task 13: shared helper for live smoke + diagnostics — boots the OpenCode
// v2.0.29 host (opencode-cli.exe / opencode) FULLY ISOLATED and returns a
// thin REST client for its /api surface.
//
// ISOLATION RECIPE (verified live on Windows 2.0.29 desktop, 2026-10-15):
// The server's data/config/cache/state directories are computed at module
// load from XDG_* env vars with home-relative defaults (verified in the
// @opencode/Global source inside the CLI binary). OPENCODE_TEST_HOME alone
// is NOT sufficient — it only overrides the `home` getter. So all four XDG
// vars are redirected into a private temp dir under the system temp (approved
// C:\Users\Adminstrator\AppData\Local\Temp\opencode\ on this machine), a
// random port is used, and the process + temp dir are cleaned up on exit.
// The real user data dir (C:\Users\Adminstrator\.local\share\opencode) is
// never touched.
//
// NOT a test (no .test suffix) — manual/live use only.

import { spawn } from "bun";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export interface ProviderSpec {
  id: string;
  name: string;
  package: string;
  settings: Record<string, unknown>;
  model: { id: string; name: string; [k: string]: unknown };
  modelID: string; // "provider/model"
}

export interface HostOptions {
  /** Private env dir. Default: a fresh temp dir (auto-removed on stop). */
  dir?: string;
  port?: number;
  /** Extra config merged into the isolated opencode.jsonc. */
  config?: Record<string, unknown>;
  /** Adds a single model provider + default model so a prompt can run. */
  provider?: ProviderSpec;
  /** Keep the env dir after stop (for log inspection). */
  keepDir?: boolean;
  waitMs?: number;
}

export interface Api {
  baseUrl: string;
  ready(): Promise<string>; // raw /api/info text
  commands(): Promise<any[]>;
  plugins(): Promise<any[]>;
  rpc(rpcID: string, method: string, input: unknown): Promise<{ status: number; body: string }>;
  goalsGet(sessionID: string): Promise<{ status: number; output?: any; error?: string }>;
  createSession(): Promise<string>;
  command(sessionID: string, name: string, text: string): Promise<number>;
  prompt(sessionID: string, text: string): Promise<any>;
  sessionShell(sessionID: string, command: string): Promise<number>;
  /** Fire-and-forget session-shell create (see makeApi for why). */
  sessionShellFire(sessionID: string, command: string): Promise<void>;
  createShell(command: string): Promise<any>;
  shellList(): Promise<any[]>;
  shellGet(id: string): Promise<{ status: number; data?: any }>;
  context(sessionID: string): Promise<any[]>;
  inbox(sessionID: string): Promise<any[]>;
  modelList(): Promise<any>;
}

/** Base dir for isolated envs (approved: .../Temp/opencode/ on Windows). */
export const TMP_BASE: string =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"), "Temp", "opencode")
    : (process.env.XDG_RUNTIME_DIR ?? "/tmp");

export interface IsolatedHost {
  port: number;
  password: string;
  baseUrl: string;
  directory: string;
  project: string;
  pid: number;
  logFile: string;
  api: Api;
  /** Subscribe to /api/event, appending SSE data lines to a file (bounded). */
  startEventCapture(timeoutS?: number): Promise<string>;
  stopEventCapture(): void;
  stop(): Promise<void>;
}

/** Repo root (this file lives in <root>/scripts/). Directory path for plugins. */
export const REPO_ROOT: string = (() => {
  let root = new URL("..", import.meta.url).pathname;
  if (process.platform === "win32") root = root.replace(/^\//, "").replace(/\//g, "\\");
  else root = posix.normalize(root);
  return root;
})();

/** Locate the opencode CLI: $OPENCODE_CLI > desktop install > PATH. */
export function findCli(): string {
  const fromEnv = process.env.OPENCODE_CLI;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const desktop =
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local"),
          "Programs", "@opencodedesktop", "resources", "opencode-cli.exe",
        )
      : "";
  try {
    if (desktop && existsSync(desktop)) return desktop;
  } catch {}
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function basic(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

/**
 * Kill the serve process and its whole tree. On Windows a plain kill leaves
 * spawned children (pwsh shells, etc.) behind and the serve process itself
 * may survive — taskkill /F /T takes the tree (verified: needed for the
 * restart diagnostic, where a surviving first host wedged the second boot).
 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      const tk = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await tk.exited;
    } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
    await Bun.sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

async function startEventCaptureImpl(host: IsolatedHost, timeoutS: number): Promise<string> {
  const file = join(host.directory, `events-${Date.now()}.txt`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutS * 1000);
  (host as any).evAbort = ctrl;
  (host as any).evTimer = timer;
  void (async () => {
    try {
      const res = await fetch(`${host.baseUrl}/api/event`, {
        headers: { authorization: basic(host.password) },
        signal: ctrl.signal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeFile(file, dec.decode(value), { flag: "a" }).catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error(`[host] event capture ended: ${err}`);
      }
    }
  })();
  return file;
}

/**
 * The local lab LLM used by live-smoke / diagnostics (ISOLATED host only).
 * Credentials come from the environment ONLY — nothing is committed (the
 * key is lab-LAN-scoped; a previously committed default was removed in the
 * Task-13 review fix):
 *   OPENCODE_LAB_PROVIDER_BASE   (required for a model run)
 *   OPENCODE_LAB_PROVIDER_KEY    (required for a model run)
 * Optional:
 *   OPENCODE_LIVE_SMOKE_MODEL_ID            (default: Qwen3.8-27B)
 *   OPENCODE_LIVE_SMOKE_PROVIDER_PACKAGE
 * Throws with a clear message when a model run is requested without the env
 * vars (callers: pass --skip-model on live-smoke, or set the vars).
 * Preflight (2026-10-16 incident): the lab model ROSTER ROTATES — a dead model
 * ID fails every execution with a 400 and the whole run becomes noise (the
 * wake loop then spins on failed-execution boundaries with 0 tokens). So the
 * ID is verified against GET <base>/models BEFORE the host boots; a probe
 * failure only warns (network down is indistinguishable from an empty list
 * and the run would fail fast in the model phase anyway).
 */
export async function labProvider(): Promise<ProviderSpec> {
  const base = process.env.OPENCODE_LAB_PROVIDER_BASE;
  const key = process.env.OPENCODE_LAB_PROVIDER_KEY;
  if (!base || !key) {
    throw new Error(
      "lab LLM not configured: set OPENCODE_LAB_PROVIDER_BASE and OPENCODE_LAB_PROVIDER_KEY " +
        "(or run scripts/live-smoke.ts --skip-model for a registration-only smoke)",
    );
  }
  const modelID = process.env.OPENCODE_LIVE_SMOKE_MODEL_ID ?? "Qwen3.8-27B";
  let available: string[] = [];
  try {
    const r = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 200) {
      const j: any = await r.json();
      available = ((j?.data ?? []) as Array<{ id?: string }>).map((m) => m?.id ?? "");
    }
  } catch (err) {
    console.error(`[host] lab model preflight probe failed (${String(err).slice(0, 160)}) — continuing without the roster check`);
  }
  if (available.length > 0 && !available.includes(modelID)) {
    throw new Error(
      `lab model "${modelID}" is not on ${base} — available: ${available.join(", ")} ` +
        `(set OPENCODE_LIVE_SMOKE_MODEL_ID)`,
    );
  }
  return {
    id: "ch2lab",
    name: "ch2lab",
    package: process.env.OPENCODE_LIVE_SMOKE_PROVIDER_PACKAGE ?? "@opencode/ai/providers/openai-compatible",
    settings: {
      baseURL: base,
      apiKey: key,
    },
    model: {
      id: modelID,
      name: modelID,
      limit: { context: 32768, output: 1024 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      body: { temperature: 0.1, chat_template_kwargs: { enable_thinking: false } },
    },
    modelID: `ch2lab/${modelID}`,
  };
}

export async function startHost(opts: HostOptions = {}): Promise<IsolatedHost> {
  const keepDir = opts.keepDir ?? false;
  const tmpBase = TMP_BASE;
  const directory = opts.dir ?? join(tmpBase, `ocgoal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const project = join(directory, "proj");
  const password = `ocgoal-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const port = opts.port ?? 47000 + (Date.now() % 900);

  for (const d of [join(directory, "data"), join(directory, "cache"), join(directory, "state"), project]) {
    await mkdir(d, { recursive: true });
  }
  await mkdir(join(directory, "config", "opencode"), { recursive: true });

  const config: Record<string, unknown> = {
    plugins: [{ package: REPO_ROOT, options: {} }],
    ...(opts.provider
      ? {
          model: opts.provider.modelID,
          providers: { [opts.provider.id]: buildProvider(opts.provider) },
        }
      : {}),
    ...(opts.config ?? {}),
  };
  await writeFile(join(directory, "config", "opencode", "opencode.jsonc"), JSON.stringify(config, null, 2));

  const child = spawn(
    [findCli(), "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_TEST_HOME: directory,
        XDG_DATA_HOME: join(directory, "data"),
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
        XDG_STATE_HOME: join(directory, "state"),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    },
  );
  // Drain pipes so the child never blocks; keep the tail for diagnosis.
  let tail = "";
  const drain = (s: ReadableStream<Uint8Array>) =>
    (async () => {
      try {
        const r = s.getReader();
        while (true) {
          const { done, value } = await r.read();
          if (done) break;
          tail = (tail + Buffer.from(value).toString()).slice(-4000);
        }
      } catch {}
    })();
  drain(child.stdout!);
  drain(child.stderr!);
  (child as any).getStdout = () => tail;

  const baseUrl = `http://127.0.0.1:${port}`;
  const api = makeApi(baseUrl, password, project);

  // Wait for readiness.
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${baseUrl}/api/info`, { headers: { authorization: basic(password) } });
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {}
    await Bun.sleep(300);
  }
  if (!up) {
    if (child.pid !== undefined) await killTree(child.pid);
    // Respect keepDir, and never delete a caller-provided dir (opts.dir):
    // on a failed boot the env dir is the most valuable diagnostic artifact.
    const weCreatedIt = opts.dir === undefined;
    if (!keepDir && weCreatedIt) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    throw new Error(
      `isolated host did not become ready within ${opts.waitMs ?? 30_000}ms (exit=${child.exitCode}).\n` +
        (keepDir || !weCreatedIt ? `env dir kept: ${directory}\n` : "") +
        `serve output tail:\n${tail}`,
    );
  }

  const host: IsolatedHost = {
    port,
    password,
    baseUrl,
    directory,
    project,
    pid: child.pid ?? -1,
    logFile: join(directory, "data", "opencode", "log", "opencode.log"),
    api,
    startEventCapture: (t?: number) => startEventCaptureImpl(host, t ?? 180),
    stopEventCapture: () => {
      try {
        (host as any).evAbort?.abort();
        clearTimeout((host as any).evTimer);
      } catch {}
    },
    stop: async () => {
      (host as any).evAbort?.abort();
      clearTimeout((host as any).evTimer);
      if (child.pid !== undefined) await killTree(child.pid);
      for (let i = 0; i < 50 && child.exitCode === null; i++) await Bun.sleep(100);
      if (!keepDir) await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
  return host;
}

function buildProvider(p: ProviderSpec): Record<string, unknown> {
  return {
    name: p.name,
    package: p.package,
    settings: p.settings,
    models: { [p.model.id]: p.model },
  };
}

function makeApi(baseUrl: string, password: string, project: string): Api {
  const H = { authorization: basic(password) };
  const loc = `location[directory]=${encodeURIComponent(project)}`;
  // Every request gets a 15s timeout — a wedged host must fail FAST with a
  // diagnosable error, never hang the script (observed: a hung command POST
  // swallowed a 5-minute run with zero output).
  const to = (ms: number) => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { c, t };
  };
  const get = async (p: string, locQ = true) => {
    const u = `${baseUrl}${p}${locQ ? `?${loc}` : ""}`;
    const { c, t } = to(15_000);
    try {
      const r = await fetch(u, { headers: H, signal: c.signal });
      return { status: r.status, text: await r.text() };
    } finally {
      clearTimeout(t);
    }
  };
  const post = async (p: string, body: unknown, locQ = true) => {
    const u = `${baseUrl}${p}${locQ ? `?${loc}` : ""}`;
    const { c, t } = to(15_000);
    try {
      const r = await fetch(u, {
        method: "POST",
        headers: { ...H, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: c.signal,
      });
      return { status: r.status, text: await r.text() };
    } finally {
      clearTimeout(t);
    }
  };
  const j = (t: string): any => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  return {
    baseUrl,
    ready: async () => (await get("/api/info", false)).text,
    commands: async () => j((await get("/api/command")).text)?.data ?? [],
    plugins: async () => j((await get("/api/plugin")).text)?.data ?? [],
    rpc: async (rpcID, method, input) => {
      const { status, text } = await post(
        `/api/rpc/${encodeURIComponent(rpcID)}/${encodeURIComponent(method)}`,
        { input },
      );
      return { status, body: text };
    },
    goalsGet: async (sessionID) => {
      const { status, text } = await post("/api/rpc/opencode-goal/get", { input: { sessionID } });
      const body = j(text);
      return {
        status,
        output: body?.output,
        error: body?.message ?? (status === 200 ? undefined : text),
      };
    },
    createSession: async () => {
      const { status, text } = await post("/api/session", { location: { directory: project } });
      if (status !== 200) throw new Error(`session create failed: ${status} ${text}`);
      return j(text)?.data?.id as string;
    },
    command: async (sessionID, name, text) => {
      const { status } = await post(`/api/session/${sessionID}/command`, { name, text });
      return status;
    },
    prompt: async (sessionID, text) => {
      const { status, text: t } = await post(`/api/session/${sessionID}/prompt`, { text });
      if (status !== 200) throw new Error(`prompt failed: ${status} ${t}`);
      return j(t)?.data;
    },
    sessionShell: async (sessionID, command) => {
      const { status } = await post(`/api/session/${sessionID}/shell`, { command });
      return status;
    },
    // The session-shell POST is a STREAMING ATTACH: the host holds the
    // connection for the shell's lifetime (verified on 129: the client curl
    // gave up at 8s — http=000 — while the shell ran to completion and
    // emitted started/ended). Awaiting it here would trip the 15s api
    // timeout on any long command and abort the caller. So: fire the
    // request (the host spawns the shell server-side on request receipt),
    // abort after a short grace, swallow the abort; callers verify via
    // shellList() / plugin state.
    sessionShellFire: async (sessionID, command) => {
      const u = `${baseUrl}/api/session/${sessionID}/shell?${loc}`;
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 4_000);
      try {
        await fetch(u, {
          method: "POST",
          headers: { ...H, "content-type": "application/json" },
          body: JSON.stringify({ command }),
          signal: c.signal,
        });
      } catch {
        // expected when the 4s grace aborts mid-attach — the shell is
        // already running server-side
      } finally {
        clearTimeout(t);
      }
    },
    createShell: async (command) => {
      const { status, text } = await post("/api/shell", { command, location: { directory: project } });
      if (status !== 200) throw new Error(`shell create failed: ${status} ${text}`);
      return j(text)?.data;
    },
    shellList: async () => j((await get("/api/shell")).text)?.data ?? [],
    shellGet: async (id) => {
      const { status, text } = await get(`/api/shell/${encodeURIComponent(id)}`);
      return { status, data: j(text)?.data };
    },
    context: async (sessionID) => j((await get(`/api/session/${sessionID}/context`)).text)?.data ?? [],
    inbox: async (sessionID) => j((await get(`/api/session/${sessionID}/inbox`)).text)?.data ?? [],
    modelList: async () => j((await get("/api/model")).text) ?? {},
  };
}

export async function readLogFile(host: IsolatedHost, tailLines = 60): Promise<string> {
  try {
    const t = await readFile(host.logFile, "utf8");
    return t.split("\n").slice(-tailLines).join("\n");
  } catch {
    return "(no log file)";
  }
}
