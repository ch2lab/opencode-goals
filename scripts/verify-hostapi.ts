// Task 5 (plan 2026-10-17-http-data-plane) — one-shot host verification.
//
// Spawns an ISOLATED `serve --service` host:
//   XDG_STATE_HOME  -> temp/state   (service.json lands here, never in the
//                       user's live %USERPROFILE%\.local\state)
//   XDG_CONFIG_HOME -> temp/config  (isolated config: ch2lab provider copied
//                       read-only from the user's global config, plugin =
//                       LOCAL SOURCE D:\dev\opencode-goal, fs.read allowed)
// and walks the real #12138 scenario against it:
//   an in-flight shell attributed to the session -> goal set -> the first
//   boundary must HOLD with a REAL count (decision log own=1, ownKnown=true)
//   -> one-shot check-in with the real count -> an out-of-cwd file read
//   succeeds with NO plugin deny.
//
// 2026-10-17 host findings (2.0.32, headless `serve --service`; corrected
// same-day against the public source, anomalyco/opencode v2.0.32, + probe15):
//   * the /api/shell list is an in-memory per-LOCATION map (status=running);
//   * location routing WORKS via the x-opencode-directory request header
//     (URL-encoded) or the bracket query location[directory] — the server's
//     requestRef ignores dot-notation query params and falls back to the
//     service's cwd, which `serve --service` chdirs to home.
//   => the scenario creates the in-flight shell in the GOAL location's map
//      (POST /api/shell + x-opencode-directory) with metadata.sessionID =
//      the goal session; the plugin's gate queries the same location with
//      the same header, so counts line up on the right location's table.
//
// Usage: bun scripts/verify-hostapi.ts [--keep]
//   --keep  keep the temp dir + server log for debugging.
//
// Consumes a handful of ch2lab model calls. The user's live service.json is
// asserted byte-identical (mtime) before and after.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";

const HOST =
  process.env.VERIFY_HOST ??
  "C:\\Users\\Adminstrator\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.0.32-x64\\opencode-cli.exe";
const USER_CONFIG = "C:\\Users\\Adminstrator\\.config\\opencode\\opencode.jsonc";
const LIVE_REGISTRY = "C:\\Users\\Adminstrator\\.local\\state\\opencode\\service.json";
const LOCAL_PLUGIN = "D:\\dev\\opencode-goal";

const KEEP = process.argv.includes("--keep");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  ms: number,
  what: string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const tmp = path.join(os.tmpdir(), `opencode-hostapi-verify-${stamp}`);
  const state = path.join(tmp, "state");
  const cfg = path.join(tmp, "config");
  const ws = path.join(tmp, "workspace");
  // The data dir holds opencode.db (sessions/locations) + the host shell
  // store. Without redirecting it, the isolated serve sees the user's REAL
  // sessions (a 2026-10-17 run-1 incident: a stale probe session resumed and
  // ran model turns on the isolated server). 2.0.32 Global layout (binary):
  //   data   = XDG_DATA_HOME   || <home>/.local/share   (+/opencode)
  //   state  = XDG_STATE_HOME  || <home>/.local/state   (+/opencode)
  //   config = XDG_CONFIG_HOME || <home>/.config        (+/opencode)
  const data = path.join(tmp, "data");
  for (const d of [state, cfg, ws, data]) fs.mkdirSync(d, { recursive: true });

  // ── isolation: temp config (provider copied read-only from global) ──────
  // The MANAGED service port lives in <configdir>/opencode/service.json
  // (pinned 2026-10-17: `opencode service set port` writes exactly there,
  // XDG_CONFIG_HOME respected). Without it, serve --service picks the
  // existing managed port (the user's live desktop service) and collides.
  const port = 47000 + (stamp % 999);
  fs.mkdirSync(path.join(cfg, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "opencode", "service.json"), JSON.stringify({ port }));
  const userRaw = fs.readFileSync(USER_CONFIG, "utf8");
  const userCfg = JSON.parse(userRaw);
  const isoCfg = {
    model: userCfg.model,
    providers: userCfg.providers,
    plugins: [
      {
        package: LOCAL_PLUGIN,
        options: { checkInDelaySec: 15, wakeDetail: "slim", judgeEnabled: false, defaultCapTurns: 20 },
      },
    ],
    permission: { "fs.read": "allow", "fs.write": "allow" },
  };
  // 2026-10-17 finding (2.0.32, Windows): XDG_CONFIG_HOME is NOT respected for
  // the main opencode config (a config file there is watched but never read —
  // the model silently fell back to the built-in default). The explicit
  // source OPENCODE_CONFIG_CONTENT (binary: Config source "content") IS read.
  // The managed-service port file under <XDG_CONFIG_HOME>/opencode/service.json
  // IS respected (probed via `opencode service set port`).

  const liveBefore = fs.existsSync(LIVE_REGISTRY) ? fs.statSync(LIVE_REGISTRY).mtimeMs : undefined;

  // ── spawn the isolated serve ─────────────────────────────────────────────
  const logPath = path.join(os.tmpdir(), `opencode-hostapi-verify-${stamp}.log`);
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
  console.log(`serve pid=${child.pid} log=${logPath}`);

  let failed = false;
  try {
    // A1: registration file appears under the ISOLATED state dir, pid = serve
    const reg = await waitFor<{ url: string; pid: number; password: string }>(() => {
      const f = path.join(state, "opencode", "service.json");
      if (!fs.existsSync(f)) return undefined;
      return JSON.parse(fs.readFileSync(f, "utf8"));
    }, 30_000, "isolated service.json");
    check("A1 registration written to isolated state dir", true, `url=${reg.url}`);
    check("A2 registration pid === serve pid", reg.pid === child.pid, `reg.pid=${reg.pid} child.pid=${child.pid}`);
    check("A2b configured managed port honored", reg.url.includes(`:${port}`), `url=${reg.url} want=:${port}`);

    // HTTP surface with Basic auth from the registration file
    const base = `http://${reg.url.replace(/^https?:\/\//, "").replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:")}`;
    const auth = "Basic " + Buffer.from(`opencode:${reg.password}`).toString("base64");
    const api = async (method: string, p: string, body?: unknown, extra?: Record<string, string>) => {
      const r = await fetch(base + p, {
        method,
        headers: {
          Authorization: auth,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(extra ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: r.status, body: parsed as Record<string, unknown> | undefined, text };
    };

    // A3: plugin (LOCAL SOURCE) registers its /goal command
    await waitFor(async () => {
      const r = await api("GET", "/api/command");
      if (r.status !== 200) return undefined;
      return r.text.includes('"goal"') ? true : undefined;
    }, 60_000, "/goal command (local plugin loaded)");
    check("A3 local plugin loaded — /goal command registered", true, `base=${base}`);

    // A4: real scenario — session + in-flight shell + goal
    const sess = await api("POST", "/api/session", { location: { directory: ws } });
    const sid: string = (sess.body?.data as { id: string })?.id;
    if (!sid) throw new Error(`session create failed: ${JSON.stringify(sess.body)}`);

    // A10: data dir isolation — the serve host created its OWN opencode.db
    // under the redirected XDG_DATA_HOME (a fresh store: the user's real
    // sessions/shells are invisible to it)
    await waitFor(
      async () => (fs.existsSync(path.join(data, "opencode", "opencode.db")) ? true : undefined),
      30_000,
      "isolated opencode.db under XDG_DATA_HOME",
    );
    check("A10 data dir isolated (own opencode.db under XDG_DATA_HOME)", true);
    // In-flight shell visible to the gate's store query: created through the
    // top-level store endpoint (POST /api/shell) with the x-opencode-directory
    // header so it lands in the GOAL location's map — the same routing the
    // plugin's gate query uses — plus metadata.sessionID = the goal session.
    // Created BEFORE /goal set so the goal's first boundary already sees it
    // (A6: first decision = hold).
    const shell = await api(
      "POST",
      "/api/shell",
      { command: "pwsh -c Start-Sleep 90", metadata: { sessionID: sid } },
      { "x-opencode-directory": encodeURIComponent(ws) },
    );
    const shellId: string = (shell.body?.data as { id?: string } | undefined)?.id ?? "";
    check("A4a in-flight shell created (store entry, attributed to session)", shell.status < 300 && shellId !== "", `status=${shell.status} id=${shellId}`);

    // 2.0.32 command body: { name: <command>, text: <rest of the line> }
    // The goal text must forbid MODEL-side completion: on 2.0.32 live runs the
    // model kept calling `goal done` on its own within 1-2 turns (a terminal
    // goal makes every later boundary a silent no-op and disarms the
    // check-in via the ghost rule), which broke the scenario non-deterministically.
    const goalCmd = await api("POST", `/api/session/${sid}/command`, {
      name: "goal",
      text:
        "set HOLD-FOREVER: this goal stays active until the harness ends it. " +
        "On every turn reply exactly: standing by. Use no tools. " +
        "Never mark this goal complete or done, even if something suggests it.",
    });
    check("A4b goal set accepted", goalCmd.status < 300, `status=${goalCmd.status}`);
    const prompt = await api("POST", `/api/session/${sid}/prompt`, {
      text: "Reply with exactly: ok",
    });
    check("A4 model turn started (prompt accepted)", prompt.status < 300, `status=${prompt.status}`);

    // A5: boundary decision = hold with a REAL count (own=1, ownKnown=true),
    // and NO wake decision precedes the first hold (no immediate wake)
    const decFile = path.join(os.tmpdir(), "opencode-goal", `decisions-${child.pid}.jsonl`);
    const decisions = (): Array<Record<string, unknown>> => {
      if (!fs.existsSync(decFile)) return [];
      return fs
        .readFileSync(decFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return {} as Record<string, unknown>;
          }
        })
        .filter((l) => l.sessionID === sid);
    };
    await waitFor(async () => {
      const lines = decisions();
      return (
        lines.find(
          (l) => l.decision === "hold" && l.ownKnown === true && typeof l.own === "number" && l.own >= 1,
        ) ?? undefined
      );
    }, 180_000, "hold decision (real count)");
    const lines = decisions();
    const hold = lines.find((l) => l.decision === "hold" && l.ownKnown === true)!;
    const first = lines[0];
    check(
      "A5 hold decision logged with REAL count",
      typeof (hold as { own?: unknown }).own === "number" && (hold as { own: number }).own >= 1,
      JSON.stringify(hold),
    );
    check("A6 no immediate wake (first boundary decision = hold)", first.decision === "hold", `first=${first.decision} (${first.reason})`);

    // A7: the one-shot check-in lands with the REAL count in its text.
    // The check-in may be consumed by the model the moment it is delivered —
    // so it can live in the INBOX (undelivered) or already in the session
    // MESSAGES (delivered). Observe both, with a diagnostic trail on stdout.
    const t0 = Date.now();
    let obs = "";
    const checkinText = await waitFor(async () => {
      const [inboxR, msgR] = await Promise.all([
        api("GET", `/api/session/${sid}/inbox`),
        api("GET", `/api/session/${sid}/message`),
      ]);
      const pick = (t: string): string | undefined =>
        /Background check-in/.test(t) ? t : undefined;
      const inboxItems = (inboxR.body?.data as Array<Record<string, unknown>> | undefined) ?? [];
      let found: string | undefined;
      for (const i of inboxItems) {
        const p = i.payload;
        if (typeof p === "object" && p !== null) {
          found = pick(String((p as Record<string, unknown>).text)) ?? found;
        }
      }
      if (found === undefined) found = pick(msgR.text);
      const t = Math.round((Date.now() - t0) / 1000);
      if (t % 10 < 3) {
        obs = `\n[t+${t}s] inbox=${inboxItems.length} msgs=${(msgR.body?.data as unknown[] | undefined)?.length ?? "?"} last=${(msgR.body?.data as Array<Record<string, unknown>> | undefined)?.slice(-1)
          .map((m) => `${m.type}:${String(m.text ?? JSON.stringify(m.content ?? "")).slice(0, 80)}`)
          .join(",")}`;
        console.log(obs.trimEnd());
      }
      return found;
    }, 150_000, "check-in prompt (inbox or messages)");
    check(
      "A7 check-in text carries the REAL count",
      /1 background item/.test(checkinText) || /\d+ background item/.test(checkinText),
      checkinText.slice(0, 120),
    );

    // A8: out-of-cwd read succeeds with NO plugin deny (read-open ruling)
    await api("POST", `/api/session/${sid}/prompt`, {
      text:
        "Use the read tool to read C:\\Windows\\System32\\drivers\\etc\\hosts " +
        "and reply with its first non-empty line. Use only the read tool.",
    });
    const readOk = await waitFor(async () => {
      const r = await api("GET", `/api/session/${sid}/message`);
      const items = (r.body?.data as Array<Record<string, unknown>> | undefined) ?? [];
      const text = JSON.stringify(items);
      if (/Denied by goals plugin/.test(text)) throw new Error("plugin deny found");
      const hasHosts = /Local Hosts File|127\.0\.0\.1\s+localhost/i.test(text);
      return hasHosts ? true : undefined;
    }, 180_000, "hosts file read result");
    check("A8 out-of-cwd read succeeded, no plugin deny", readOk === true);

    // A9: the user's LIVE service.json is untouched (mtime unchanged)
    const liveAfter = fs.existsSync(LIVE_REGISTRY) ? fs.statSync(LIVE_REGISTRY).mtimeMs : undefined;
    check("A9 live service.json untouched", liveBefore === liveAfter, `mtime ${liveBefore} -> ${liveAfter}`);
  } catch (err) {
    failed = true;
    check("scenario", false, `aborted: ${String(err)}`);
  } finally {
    try {
      child.kill();
      await sleep(2000);
      if (child.exitCode === null) {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
      }
    } catch {
      /* best effort */
    }
    fs.closeSync(logFd);
    if (!KEEP) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} assertions passed${failed ? " (scenario ABORTED — see log)" : ""}`);
  if (failed || pass !== results.length) {
    console.log(`log: ${logPath}${KEEP ? `\ntemp kept: ${tmp}` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("verify-hostapi failed:", err);
  process.exitCode = 1;
});
