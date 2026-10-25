// §58 真宿主验证批（2026-10-25 过夜事故：check-in 期限在 机器休眠+location 重启 中丢失
// → goal 停摆一夜）：在【隔离真实宿主】上验证
//   1. in-flight 边界武装 check-in（期限持久化进 goal 记录——decisions 行实证武装）
//   2. 整个宿主进程重启（= location evict/reboot 的可控模拟，更强：进程全死）
//   3. 新实例的 initRearm 恢复持久化期限 → check-in 实际落地（过期即补发）且一次性
//
// 用法（lab LLM 凭据只从 env 取）：
//   set OPENCODE_LAB_PROVIDER_BASE=http://...
//   set OPENCODE_LAB_PROVIDER_KEY=...
//   bun run scripts/verify-persist.ts

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { startHost, labProvider, REPO_ROOT, type IsolatedHost } from "./host.ts";

const CHECK_TIMEOUT_MS = 120_000;
const CHECKIN_DELAY_SEC = 15; // plugin option, injected below

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true;
    await sleep(1000);
  }
  return false;
}

async function main(): Promise<void> {
  const provider = await labProvider(); // throws with a clear message when env is unset
  console.log(`[verify-persist] lab model: ${provider.modelID}`);
  const pluginConfig = {
    plugins: [
      {
        package: REPO_ROOT,
        // watchdogTickMs fast (deadline heartbeat); stallLimit high (the
        // countdown goal's pure-text replies must not self-stall mid-test —
        // the 2026-10-24 flake); checkInDelaySec short (fast deadline).
        options: { watchdogTickMs: 2000, checkInDelaySec: CHECKIN_DELAY_SEC, stallLimit: 100 },
      },
    ],
  };
  const hostOpts = { provider, waitMs: 60_000, keepDir: process.env.VERIFY_KEEP_DIR === "1", config: { ...pluginConfig } };

  const h1: IsolatedHost = await startHost(hostOpts);
  console.log(`[verify-persist] host A up (port ${h1.port}, pid ${h1.pid}, dir ${h1.directory})`);
  const dir1 = h1.directory;
  const svcDir = join(dir1, "state", "opencode");
  await mkdir(svcDir, { recursive: true });
  await writeFile(join(svcDir, "service.json"), JSON.stringify({ url: h1.baseUrl, pid: h1.pid, password: h1.password }));

  const S = await h1.api.createSession();
  const idle1 = async (): Promise<boolean> => {
    try {
      return (await h1.api.sessionActive())[S] !== "running";
    } catch {
      return true;
    }
  };
  const checkinMessage = async (host: IsolatedHost): Promise<string | undefined> => {
    const msgs = await host.api.context(S);
    for (const m of msgs) {
      const t = String(m?.text ?? "");
      if (t.includes("Background check-in")) return t;
    }
    return undefined;
  };
  const decisions = (pid: number): string[] => {
    try {
      return readFileSync(join(process.env.TEMP ?? "C:\\Windows\\Temp", "opencode-goal", `decisions-${pid}.jsonl`), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const sawArmLine = async (): Promise<boolean> =>
    decisions(h1.pid).some((l) => {
      try {
        const e = JSON.parse(l);
        return e?.sessionID === S && e?.decision === "hold" && String(e?.reason).includes("check-in armed");
      } catch {
        return false;
      }
    });

  // P0: goal + idle.
  const stSet = await h1.api.command(S, "goal", "set Endless countdown: each turn reply with the next integer counting DOWN from 100, nothing else. This goal is never completed. --turns 30");
  check("P0: /goal set accepted", stSet >= 200, { status: stSet });
  check("P1: session idle after the kick turn", await waitUntil(idle1, CHECK_TIMEOUT_MS));

  // P2: a long background shell (server-side fire — the work the goal waits on).
  const findRunningShell = async (host: IsolatedHost) => {
    const list = (await host.api.shellList()) as Array<{ id?: string; status?: string; metadata?: { sessionID?: string } }>;
    return list.find((e) => e?.metadata?.sessionID === S && e?.status === "running");
  };
  await h1.api.sessionShellFire(S, "sleep 240");
  const found = await waitUntil(async () => (await findRunningShell(h1)) !== undefined, 30_000);
  check("P2: background shell running in the host shell store", found, { shell: (await findRunningShell(h1))?.id });

  // P3: a prompt turn ends IN FLIGHT → the boundary arms the check-in
  // (deadline persisted with the goal record — §58's arm mirror).
  await h1.api.prompt(S, "Automated goal-loop test. Reply with exactly: ok — and stop. Do NOT call any tool.");
  const armed = await waitUntil(sawArmLine, CHECK_TIMEOUT_MS);
  if (!armed) {
    // Diagnostics: compare the raw global shell list against the
    // LOCATION-SCOPED query the plugin uses (x-opencode-directory header).
    try {
      const auth = { Authorization: "Basic " + Buffer.from(`opencode:${h1.password}`).toString("base64") };
      const sessBody = (await (await fetch(h1.baseUrl + "/api/session", { headers: auth })).json()) as { data: Array<{ id?: string; location?: { directory?: string } }> };
      const me = sessBody.data.find((s) => s?.id === S);
      const raw = (await (await fetch(h1.baseUrl + "/api/shell", { headers: auth })).text());
      const scoped = me?.location?.directory
        ? (await (await fetch(h1.baseUrl + "/api/shell", { headers: { ...auth, "x-opencode-directory": encodeURIComponent(me.location.directory) } })).text())
        : "(no location.directory on the session)";
      console.log(`[verify-persist] P3 diagnostics: session.location=${JSON.stringify(me?.location)}\n  RAW=${raw.slice(0, 900)}\n  SCOPED=${String(scoped).slice(0, 900)}`);
    } catch (err) {
      console.log(`[verify-persist] P3 diagnostics failed:`, err);
    }
  }
  check("P3: check-in armed at the in-flight boundary (decision log line)", armed, {
    tail: decisions(h1.pid).slice(-2),
  });

  // P4: KILL the whole host process — the controllable analog of the
  // 2026-10-25 01:03 location evict/reboot (the plugin instance dies with its
  // in-memory deadline + watchdog; the data dir — sessions, shell store,
  // plugin kv — survives).
  await h1.stop();
  console.log("[verify-persist] host A killed (the reload)");

  // P5: restart the host on the SAME data dir (opts.dir — startHost would
  // otherwise mint a fresh one: same state, same sessions, same plugin kv) —
  // a fresh plugin instance.
  const h2: IsolatedHost = await startHost({ ...hostOpts, dir: dir1 });
  console.log(`[verify-persist] host B up (port ${h2.port}, pid ${h2.pid}, dir ${h2.directory})`);
  check("P5: same data dir (state survived the restart)", h2.directory === dir1, { dir: h2.directory });

  // P6: initRearm restored the persisted deadline → the check-in lands
  // (past-due → first tick; future → within checkInDelaySec).
  const landed = await waitUntil(async () => (await checkinMessage(h2)) !== undefined, CHECK_TIMEOUT_MS);
  const text = await checkinMessage(h2);
  if (!landed) {
    // Diagnostics: (1) the persisted record — was checkinDue actually saved?
    // (2) host B's stdout — did initRearm log a re-arm / a scan failure?
    try {
      const { Database } = require("bun:sqlite");
      const dbPath = join(dir1, "data", "opencode", "opencode.db");
      const db = new Database(dbPath, { readonly: true });
      const rows = db.query("SELECT key, value FROM kv WHERE key LIKE ?").all(`%${S}%`);
      for (const r of rows as Array<{ key: string; value: string }>) {
        const visible = [...r.key].filter((c) => c !== "\0").join("");
        if (visible.includes("archived")) continue;
        const g = JSON.parse(r.value) as Record<string, unknown>;
        console.log(
          `[verify-persist] P6 diagnostics: goal ${g.id} status=${g.status} ` +
            `checkinDue=${JSON.stringify(g.checkinDue)} waitUntil=${g.waitUntil} updatedAt=${new Date(Number(g.updatedAt)).toISOString()}`,
        );
      }
    } catch (err) {
      console.log(`[verify-persist] P6 db dump failed:`, err);
    }
    console.log(`[verify-persist] P6 diagnostics: host B stdout tail:\n${h2.stdoutTail().slice(-4000)}`);
  }
  check("P6: the persisted check-in deadline FIRED after the restart (the overnight-incident shape)", landed, {
    text: text?.slice(0, 200),
    tail: landed ? undefined : h2.stdoutTail().slice(-300),
  });
  const firedLine = decisions(h2.pid).some((l) => {
    try {
      const e = JSON.parse(l);
      return e?.sessionID === S && e?.decision === "watchdog" && String(e?.reason).includes("check-in");
    } catch {
      return false;
    }
  });
  check("P7: decision log line 'watchdog check-in' in the SUCCESSOR instance", firedLine, { tail: decisions(h2.pid).slice(-3) });

  // P8: one-shot — the consumed deadline must not fire again.
  await sleep(20_000);
  const count = await (async () => {
    const msgs = await h2.api.context(S);
    let n = 0;
    for (const m of msgs) if (String(m?.text ?? "").includes("Background check-in")) n++;
    return n;
  })();
  check("P8: ONE-SHOT — no second check-in in the 20s grace (the work is gone — its child died with host A)", count === 1, { count });

  await h2.stop();
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error("[verify-persist] fatal:", err);
  process.exit(2);
});
