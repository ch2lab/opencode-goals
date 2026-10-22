// src/hostapi — HTTP data plane (shell store + inbox) over the host service's
// local registration file (service.json) with Basic auth.
//
// Contract pinned 2026-10-17 against 2.0.32 (protocol d.ts + live probes):
//   registration file: <XDG_STATE_HOME | <home>/.local/state>/opencode/service.json
//                      = { id?, version?, url, pid, password? }
//   auth:              Authorization: Basic base64("opencode:" + password)
//   shell store:       GET    /api/shell, location via x-opencode-directory header
//                      (URL-encoded abs dir; the server's requestRef ignores
//                       dot-notation query params like location.directory=)
//   inbox list:        GET    /api/session/:sessionID/inbox
//   inbox cancel:      DELETE /api/session/:sessionID/inbox/:inboxID
//
// No real network / no real file IO in this file: fetch and registration
// reads are injected (HostApiDeps); the pure helpers are tested directly.
import { expect, test } from "bun:test";
import {
  basicAuthHeader,
  createHostApi,
  parseRegistration,
  resolveRegistrationFile,
  serviceUrl,
} from "../src/hostapi";

// ── pure helpers ───────────────────────────────────────────────────────────

test("resolveRegistrationFile: XDG_STATE_HOME wins", () => {
  expect(resolveRegistrationFile({ XDG_STATE_HOME: "C:/state" }, "C:/Users/me")).toBe(
    "C:/state/opencode/service.json",
  );
});

test("resolveRegistrationFile: falls back to <home>/.local/state", () => {
  expect(resolveRegistrationFile({}, "C:/Users/me")).toBe(
    "C:/Users/me/.local/state/opencode/service.json",
  );
});

test("parseRegistration: full object", () => {
  expect(
    parseRegistration(
      JSON.stringify({ id: "srv1", version: "2.0.32", url: "http://0.0.0.0:45278", pid: 41824, password: "pw" }),
    ),
  ).toEqual({
    url: "http://0.0.0.0:45278",
    pid: 41824,
    password: "pw",
    version: "2.0.32",
    id: "srv1",
  });
});

test("parseRegistration: minimal (url + pid only)", () => {
  expect(parseRegistration(JSON.stringify({ url: "http://127.0.0.1:4096", pid: 7 }))).toEqual({
    url: "http://127.0.0.1:4096",
    pid: 7,
  });
});

test("parseRegistration: malformed JSON -> undefined", () => {
  expect(parseRegistration("not json")).toBeUndefined();
});

test("parseRegistration: missing url -> undefined", () => {
  expect(parseRegistration(JSON.stringify({ pid: 7 }))).toBeUndefined();
});

test("parseRegistration: non-integer pid -> undefined", () => {
  expect(parseRegistration(JSON.stringify({ url: "http://x", pid: "7" }))).toBeUndefined();
});

test("parseRegistration: non-object -> undefined", () => {
  expect(parseRegistration('"hello"')).toBeUndefined();
});

test("serviceUrl: 0.0.0.0 listen address -> 127.0.0.1, port preserved", () => {
  expect(serviceUrl("http://0.0.0.0:45278")).toBe("http://127.0.0.1:45278");
});

test("serviceUrl: :: listen address -> 127.0.0.1", () => {
  expect(serviceUrl("http://[::]:4096")).toBe("http://127.0.0.1:4096");
});

test("serviceUrl: real addresses are untouched", () => {
  expect(serviceUrl("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
  expect(serviceUrl("http://192.168.1.5:4096")).toBe("http://192.168.1.5:4096");
});

test("serviceUrl: unparseable input is returned verbatim", () => {
  expect(serviceUrl("not a url")).toBe("not a url");
});

test("basicAuthHeader: Basic base64('opencode:' + password)", () => {
  const header = basicAuthHeader("abc123");
  expect(header.startsWith("Basic ")).toBe(true);
  expect(atob(header.slice("Basic ".length))).toBe("opencode:abc123");
});

// ── createHostApi (injected fetch + registration reads) ────────────────────

function reg(url: string, pid: number, password?: string): string {
  return JSON.stringify({
    id: "srv",
    version: "2.0.32",
    url,
    pid,
    ...(password === undefined ? {} : { password }),
  });
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Script = (url: string, init: RequestInit | undefined) => Response;

function fakeFetch(script: Script): { fn: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return script(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("no registration file -> unavailable(no-registry), fetch untouched", async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [] }));
  const api = createHostApi({ fetch: f.fn, readRegistration: async () => undefined, myPID: 4242 });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("no-registry");
  expect(f.calls.length).toBe(0);
});

test("malformed registration -> unavailable(bad-registry), fetch untouched", async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [] }));
  const api = createHostApi({ fetch: f.fn, readRegistration: async () => "not json", myPID: 4242 });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("bad-registry");
  expect(f.calls.length).toBe(0);
});

test("registration pid !== our pid -> unavailable(pid-mismatch), fetch untouched", async () => {
  const f = fakeFetch(() => jsonRes(200, { data: [] }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:4096", 999999, "pw"),
    myPID: 4242,
  });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("pid-mismatch");
  expect(f.calls.length).toBe(0);
});

test("shellList: GET /api/shell + x-opencode-directory header (URL-encoded) + Basic auth; entries normalized", async () => {
  const f = fakeFetch((url, init) => {
    expect(url).toBe("http://127.0.0.1:45278/api/shell");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-opencode-directory"]).toBe(encodeURIComponent("/proj"));
    expect(headers["Authorization"]).toBe("Basic " + Buffer.from("opencode:pw").toString("base64"));
    return jsonRes(200, {
      location: { directory: "/proj" },
      data: [
        { id: "sh1", status: "running", command: "sleep 60", metadata: { sessionID: "ses_abc" } },
        { id: "sh2", status: "exited", command: "ls", metadata: {} },
        { id: "sh3", status: "running", command: "npm test" },
      ],
    });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://0.0.0.0:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("ok");
  expect(r.value).toEqual([
    { id: "sh1", status: "running", sessionID: "ses_abc", command: "sleep 60" }, // §54: command passthrough
    { id: "sh2", status: "exited", sessionID: undefined, command: "ls" },
    { id: "sh3", status: "running", sessionID: undefined, command: "npm test" },
  ]);
});

test("shellList: empty locationDirectory sends no x-opencode-directory header", async () => {
  const f = fakeFetch((url, init) => {
    expect(url).toBe("http://127.0.0.1:45278/api/shell");
    expect(((init?.headers ?? {}) as Record<string, string>)["x-opencode-directory"]).toBeUndefined();
    return jsonRes(200, { location: { directory: "/proj" }, data: [] });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  expect((await api.shellList("")).state).toBe("ok");
});

test("shellList: registration without password sends no Authorization header", async () => {
  const f = fakeFetch((_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    return jsonRes(200, { location: { directory: "/proj" }, data: [] });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242),
    myPID: 4242,
  });
  expect((await api.shellList("/proj")).state).toBe("ok");
});

test("shellList: 401 -> unavailable(http-401)", async () => {
  const f = fakeFetch(() => jsonRes(401, { _tag: "UnauthorizedError" }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("http-401");
});

test("shellList: network error -> unavailable(network)", async () => {
  const f = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("network");
});

test("shellList: timeout -> unavailable(timeout)", async () => {
  const f = fakeFetch(() => {
    throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.shellList("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("timeout");
});

test("registration file is re-read per query (a server restart is picked up)", async () => {
  let file = reg("http://127.0.0.1:4096", 4242, "pw1");
  const f = fakeFetch((url, init) => {
    expect(((init?.headers ?? {}) as Record<string, string>)["Authorization"]).toBe(
      "Basic " + Buffer.from(`opencode:${file.includes("pw2") ? "pw2" : "pw1"}`).toString("base64"),
    );
    return jsonRes(200, { location: { directory: "/w" }, data: [] });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => file,
    myPID: 4242,
  });
  expect((await api.shellList("/w")).state).toBe("ok");
  file = reg("http://127.0.0.1:4097", 4242, "pw2");
  const r = await api.shellList("/w");
  expect(r.state).toBe("ok");
  expect(f.calls[0].url.startsWith("http://127.0.0.1:4096/")).toBe(true);
  expect(f.calls[1].url.startsWith("http://127.0.0.1:4097/")).toBe(true);
});

test("myPID defaults to process.pid", async () => {
  const f = fakeFetch(() => jsonRes(200, { location: { directory: "/w" }, data: [] }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", process.pid, "pw"),
  });
  expect((await api.shellList("/w")).state).toBe("ok");
});

// ── active map (2026-10-20 reference-UI) ───────────────────────────────────

test("activeSessions: GET /api/session/active + x-opencode-directory; object values normalize to their type token", async () => {
  const f = fakeFetch((url, init) => {
    expect(url).toBe("http://127.0.0.1:45278/api/session/active");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-opencode-directory"]).toBe(encodeURIComponent("/proj"));
    return jsonRes(200, {
      data: {
        ses_a: { type: "running" },
        ses_b: { type: "question" },
        ses_c: "running", // bare string (defensive)
        ses_d: { type: 42 }, // non-string type -> dropped
      },
    });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://0.0.0.0:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.activeSessions("/proj");
  expect(r.state).toBe("ok");
  expect(r.value).toEqual({ ses_a: "running", ses_b: "question", ses_c: "running" });
});

test("activeSessions: empty data -> ok + {}", async () => {
  const f = fakeFetch(() => jsonRes(200, { data: {} }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.activeSessions("/proj");
  expect(r.state).toBe("ok");
  expect(r.value).toEqual({});
});

test("activeSessions: 500 -> unavailable(http-500)", async () => {
  const f = fakeFetch(() => jsonRes(500, { _tag: "UnknownError" }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.activeSessions("/proj");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("http-500");
});

// ── inbox routes ───────────────────────────────────────────────────────────

test("inboxList: 200 normalizes items", async () => {
  const f = fakeFetch((url) => {
    expect(url).toBe("http://127.0.0.1:45278/api/session/ses_abc/inbox");
    return jsonRes(200, {
      data: [
        { id: "m1", sessionID: "ses_abc", type: "user", payload: { text: "hi" }, delivery: "queue" },
        { id: "m2", sessionID: "ses_abc", type: "synthetic", payload: { text: "chk" }, delivery: "steer" },
      ],
    });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.inboxList("ses_abc");
  expect(r.state).toBe("ok");
  expect(r.value).toEqual([
    { id: "m1", sessionID: "ses_abc", type: "user", payload: { text: "hi" }, delivery: "queue" },
    { id: "m2", sessionID: "ses_abc", type: "synthetic", payload: { text: "chk" }, delivery: "steer" },
  ]);
});

test("inboxList: 404 SessionNotFound body -> ok + [] (session gone is not a failure)", async () => {
  const f = fakeFetch(() => jsonRes(404, { _tag: "SessionNotFoundError" }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.inboxList("ses_gone");
  expect(r.state).toBe("ok");
  expect(r.value).toEqual([]);
});

test("inboxList: 500 -> unavailable(http-500)", async () => {
  const f = fakeFetch(() => jsonRes(500, { _tag: "UnknownError" }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.inboxList("ses_abc");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("http-500");
});

test("inboxCancel: DELETE /api/session/:sid/inbox/:iid — 204 -> ok", async () => {
  const f = fakeFetch((url, init) => {
    expect(url).toBe("http://127.0.0.1:45278/api/session/ses_abc/inbox/m1");
    expect(init?.method).toBe("DELETE");
    return new Response(null, { status: 204 });
  });
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.inboxCancel("ses_abc", "m1");
  expect(r.state).toBe("ok");
});

test("inboxCancel: 404 SessionNotFound -> ok (already gone)", async () => {
  const f = fakeFetch(() => jsonRes(404, { _tag: "SessionNotFoundError" }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  expect((await api.inboxCancel("ses_gone", "m1")).state).toBe("ok");
});

test("inboxCancel: 500 -> unavailable(http-500)", async () => {
  const f = fakeFetch(() => jsonRes(500, { _tag: "UnknownError" }));
  const api = createHostApi({
    fetch: f.fn,
    readRegistration: async () => reg("http://127.0.0.1:45278", 4242, "pw"),
    myPID: 4242,
  });
  const r = await api.inboxCancel("ses_abc", "m1");
  expect(r.state).toBe("unavailable");
  expect(r.reason).toBe("http-500");
});
