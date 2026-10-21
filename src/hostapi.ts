// HTTP data plane for the goal loop (2026-10-17: replaces the dead
// in-process ctx.rpc.call channel — the host's own services are not in the
// in-process RPC registry; they live on the HTTP API surface).
//
// The plugin talks to ITS OWN host service: discovery via the local
// registration file (re-read on every query — a server restart swaps
// url/password, so caching is forbidden), Basic auth, and pid
// self-identification (a registration written by ANOTHER service is not
// ours to query).
//
// Contract pinned 2026-10-17 against 2.0.32 (protocol d.ts + live probes):
//   registration file: <XDG_STATE_HOME | <home>/.local/state>/opencode/service.json
//                      = { id?, version?, url, pid, password? }
//   auth:              Authorization: Basic base64("opencode:" + password)
//   shell store:       GET    /api/shell + header x-opencode-directory: <enc abs dir>
//                      (the server's requestRef only honors that header or the
//                       bracket query location[directory]; dot-notation params are
//                       invisible -> silent fallback to the service's cwd, which
//                       for `serve --service` is always home)
//   active map:        GET    /api/session/active + header x-opencode-directory
//                      (2026-10-20 reference-UI contract, 2.0.32 binary forensics
//                       + 129 live probe + isolated real-host verify:
//                       {data: Map<sessionID, {type: status}>} — the host's
//                       in-memory liveness state the UI reads; an absent entry
//                       = "idle", {type:"running"} = a turn is executing now)
//   inbox list:        GET    /api/session/:sessionID/inbox
//   inbox cancel:      DELETE /api/session/:sessionID/inbox/:inboxID
//                      (a 404 SessionNotFound body on inbox routes means
//                       "session gone": the list is empty, the cancel is done)
//
// Failure taxonomy (all -> state "unavailable"):
//   no-registry | bad-registry | registry-error | pid-mismatch
//   | timeout | network | http-<status>
// A failure means the host context is dead (ruling 2026-10-17): the caller
// logs and skips — no retries, no revival.
import type { HostSession, InboxItem, ShellEntry } from "./types";

export type HostApiState = "ok" | "unavailable";

export interface HostApiResult<T> {
  state: HostApiState;
  value?: T;
  reason?: string;
}

interface Registration {
  url: string;
  pid: number;
  password?: string;
  version?: string;
  id?: string;
}

export interface HostApi {
  shellList(locationDirectory: string): Promise<HostApiResult<ShellEntry[]>>;
  sessionList(locationDirectory: string): Promise<HostApiResult<HostSession[]>>;
  activeSessions(locationDirectory: string): Promise<HostApiResult<Record<string, string>>>;
  inboxList(sessionID: string): Promise<HostApiResult<InboxItem[]>>;
  inboxCancel(sessionID: string, inboxID: string): Promise<HostApiResult<undefined>>;
}

export interface HostApiDeps {
  /** Inject a fake in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Registration file content or undefined (missing). Injected in tests. */
  readRegistration?: () => Promise<string | undefined>;
  /** Self-identification check; defaults to process.pid. */
  myPID?: number;
  /** Per-request timeout; defaults to 3000ms. */
  timeoutMs?: number;
}

/** XDG_STATE_HOME wins, otherwise <home>/.local/state; + /opencode/service.json. */
export function resolveRegistrationFile(env: Record<string, string | undefined>, home: string): string {
  const base = (env.XDG_STATE_HOME ?? `${home.replace(/[\\/]+$/, "")}/.local/state`).replace(/[\\/]+$/, "");
  return `${base}/opencode/service.json`;
}

/** Defensive parse; malformed JSON or missing url/pid -> undefined. */
export function parseRegistration(raw: string): Registration | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  if (typeof o.url !== "string" || o.url === "") return undefined;
  if (typeof o.pid !== "number" || !Number.isInteger(o.pid)) return undefined;
  const out: Registration = { url: o.url, pid: o.pid };
  if (typeof o.password === "string" && o.password !== "") out.password = o.password;
  if (typeof o.version === "string") out.version = o.version;
  if (typeof o.id === "string") out.id = o.id;
  return out;
}

/** 0.0.0.0 / :: listen addresses -> 127.0.0.1; everything else verbatim. */
export function serviceUrl(url: string): string {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/^\[(.*)\]$/, "$1"); // IPv6 keeps its brackets in some URL impls
    const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : u.hostname;
    const port = u.port !== "" ? `:${u.port}` : "";
    return `${u.protocol}//${host}${port}`;
  } catch {
    return url;
  }
}

/** Basic auth header for the opencode service (username is fixed). */
export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/**
 * Build the data plane. All dependencies are injectable; with no deps this
 * is the real thing: registration file at the XDG/home state path, global
 * fetch, process.pid self-identification.
 */
export function createHostApi(deps?: HostApiDeps): HostApi {
  const fetchFn = deps?.fetch ?? globalThis.fetch;
  const myPID = deps?.myPID ?? process.pid;
  const timeoutMs = deps?.timeoutMs ?? 3000;
  const readRegistration = deps?.readRegistration ?? defaultReadRegistration;

  interface Prepared {
    base: string;
    headers: Record<string, string>;
  }

  async function prepare(): Promise<Prepared | HostApiResult<never>> {
    let raw: string | undefined;
    try {
      raw = await readRegistration();
    } catch {
      return { state: "unavailable", reason: "registry-error" };
    }
    if (raw === undefined) return { state: "unavailable", reason: "no-registry" };
    const reg = parseRegistration(raw);
    if (reg === undefined) return { state: "unavailable", reason: "bad-registry" };
    if (reg.pid !== myPID) return { state: "unavailable", reason: "pid-mismatch" };
    const headers: Record<string, string> = {};
    if (reg.password !== undefined) headers["Authorization"] = basicAuthHeader(reg.password);
    return { base: serviceUrl(reg.url), headers };
  }

  type Fetched = Response | { reason: string };

  async function doFetch(
    path: string,
    method: "GET" | "DELETE" = "GET",
    extraHeaders?: Record<string, string>,
  ): Promise<Fetched> {
    const p = await prepare();
    if ("state" in p) return { reason: p.reason ?? "unknown" };
    try {
      return await fetchFn(p.base + path, {
        method,
        headers: extraHeaders ? { ...p.headers, ...extraHeaders } : p.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
      return { reason };
    }
  }

  /**
   * Location routing header (undefined for the default location). The server's
   * requestRef only honors x-opencode-directory (or the bracket query
   * location[directory]) — a dot-notation query param is invisible and silently
   * falls back to the service's cwd, which `serve --service` chdirs to home.
   */
  function locationHeader(locationDirectory: string): Record<string, string> | undefined {
    return locationDirectory !== "" ? { "x-opencode-directory": encodeURIComponent(locationDirectory) } : undefined;
  }

  /** 404 with a structured SessionNotFound body (not a plain 404). */
  async function isSessionNotFound(res: Response): Promise<boolean> {
    const body = await safeJson(res);
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>)._tag === "SessionNotFoundError"
    );
  }

  async function shellList(locationDirectory: string): Promise<HostApiResult<ShellEntry[]>> {
    const r = await doFetch("/api/shell", "GET", locationHeader(locationDirectory));
    if ("reason" in r) return { state: "unavailable", reason: r.reason };
    if (!r.ok) return { state: "unavailable", reason: `http-${r.status}` };
    const body = await safeJson(r);
    const data =
      typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : [];
    return { state: "ok", value: normalizeShells(data) };
  }

  /** Session list (2026-10-19 in-flight query): GET /api/session, location-
   * scoped like shellList (x-opencode-directory header) — the goal's project's
   * sessions, each with `parentID` (subtask attribution; the in-process
   * `ctx.session.get` does not return `parentID`). The caller filters by
   * parentID chain. */
  async function sessionList(locationDirectory: string): Promise<HostApiResult<HostSession[]>> {
    const r = await doFetch("/api/session", "GET", locationHeader(locationDirectory));
    if ("reason" in r) return { state: "unavailable", reason: r.reason };
    if (!r.ok) return { state: "unavailable", reason: `http-${r.status}` };
    const body = await safeJson(r);
    const data =
      typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : [];
    const out: HostSession[] = [];
    for (const raw of data) {
      if (typeof raw !== "object" || raw === null) continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.id !== "string") continue;
      const t = (typeof o.time === "object" && o.time !== null ? o.time : {}) as Record<string, unknown>;
      out.push({
        id: o.id,
        projectID: typeof o.projectID === "string" ? o.projectID : undefined,
        parentID: typeof o.parentID === "string" ? o.parentID : undefined,
        outcome: typeof o.outcome === "string" ? o.outcome : undefined,
        time: {
          created: typeof t.created === "number" ? t.created : undefined,
          updated: typeof t.updated === "number" ? t.updated : undefined,
          idle: typeof t.idle === "number" ? t.idle : undefined,
          viewed: typeof t.viewed === "number" ? t.viewed : undefined,
        },
      });
    }
    return { state: "ok", value: out };
  }

  /** Active map (2026-10-20 reference-UI ruling): GET /api/session/active,
   * location-scoped like sessionList → {data: Map<sessionID, {type: status}>}
   * (isolated real-host verify 2026-10-20: the mid-turn value is
   * {type:"running"}; a bare string is accepted defensively). The host's own
   * in-memory liveness state (the signal the UI reads for its running badge):
   * "running" = a turn is executing right now (including a turn waiting on a
   * long shell/tool); an absent entry = "idle". This is the in-flight subtask
   * criterion — the 1.1.3 time.idle/updated guess is gone (stale time fields
   * counted dead sessions in-flight forever). */
  async function activeSessions(locationDirectory: string): Promise<HostApiResult<Record<string, string>>> {
    const r = await doFetch("/api/session/active", "GET", locationHeader(locationDirectory));
    if ("reason" in r) return { state: "unavailable", reason: r.reason };
    if (!r.ok) return { state: "unavailable", reason: `http-${r.status}` };
    const body = await safeJson(r);
    const data =
      typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).data === "object" &&
      (body as Record<string, unknown>).data !== null
        ? ((body as Record<string, unknown>).data as Record<string, unknown>)
        : {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).type === "string") {
        out[k] = (v as Record<string, unknown>).type as string;
      }
    }
    return { state: "ok", value: out };
  }

  async function inboxList(sessionID: string): Promise<HostApiResult<InboxItem[]>> {
    const r = await doFetch(`/api/session/${encodeURIComponent(sessionID)}/inbox`);
    if ("reason" in r) return { state: "unavailable", reason: r.reason };
    if (!r.ok) {
      if (r.status === 404 && (await isSessionNotFound(r))) return { state: "ok", value: [] };
      return { state: "unavailable", reason: `http-${r.status}` };
    }
    const body = await safeJson(r);
    const data =
      typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : [];
    return { state: "ok", value: normalizeInbox(data) };
  }

  async function inboxCancel(sessionID: string, inboxID: string): Promise<HostApiResult<undefined>> {
    const r = await doFetch(
      `/api/session/${encodeURIComponent(sessionID)}/inbox/${encodeURIComponent(inboxID)}`,
      "DELETE",
    );
    if ("reason" in r) return { state: "unavailable", reason: r.reason };
    if (!r.ok) {
      if (r.status === 404 && (await isSessionNotFound(r))) return { state: "ok" };
      return { state: "unavailable", reason: `http-${r.status}` };
    }
    return { state: "ok" };
  }

  return { shellList, sessionList, activeSessions, inboxList, inboxCancel };
}

/**
 * Real registration file read (default dep): the host binary writes this at
 * the same XDG/home state path (last-write-wins; `serve --service`).
 */
async function defaultReadRegistration(): Promise<string | undefined> {
  const [fs, os] = await Promise.all([import("node:fs"), import("node:os")]);
  const file = resolveRegistrationFile(process.env, os.homedir());
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function normalizeShells(data: unknown[]): ShellEntry[] {
  const out: ShellEntry[] = [];
  for (const e of data) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.status !== "string") continue;
    const meta =
      typeof o.metadata === "object" && o.metadata !== null ? (o.metadata as Record<string, unknown>) : {};
    const t = (typeof o.time === "object" && o.time !== null ? o.time : {}) as Record<string, unknown>;
    out.push({
      id: o.id,
      status: o.status,
      sessionID: typeof meta.sessionID === "string" ? meta.sessionID : undefined,
      time: typeof t.started === "number" ? { started: t.started } : undefined, // §51: elapsed in the check-in roster
    });
  }
  return out;
}

function normalizeInbox(data: unknown[]): InboxItem[] {
  const out: InboxItem[] = [];
  for (const e of data) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.id !== "string") continue;
    out.push({
      id: o.id,
      sessionID: typeof o.sessionID === "string" ? o.sessionID : "",
      type:
        o.type === "user" || o.type === "synthetic" || o.type === "compaction" || o.type === "move"
          ? o.type
          : "user",
      payload:
        typeof o.payload === "object" && o.payload !== null
          ? (o.payload as Record<string, unknown>)
          : undefined,
      delivery: o.delivery === "steer" || o.delivery === "queue" ? o.delivery : undefined,
    });
  }
  return out;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
