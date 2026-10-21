# @ch2lab/opencode-goals

An OpenCode v2 goal-loop plugin: gives the model a "set goal → work autonomously → evidence-gated completion" loop, built for unattended long-running tasks.

Source (MIT): [github.com/ch2lab/opencode-goals](https://github.com/ch2lab/opencode-goals) · Feedback via [GitHub Issues](https://github.com/ch2lab/opencode-goals/issues)

## What It Solves

Unattended long tasks (overnight refactors, migrations, "keep going until the tests pass") fail in three characteristic ways:

- **Silent stall** — the model believes it is done and stops while the work is half-finished, with nobody to notice;
- **Fake completion** — the model declares "done" with no verifiable basis;
- **Long script hangs** — a script runs for a long time; the session idles and nobody checks on it.

This plugin gives the host a goal state machine + a wake mechanism, so the model works "with a supervisor":

| Mechanism | Effect |
|---|---|
| Goal loop | Wakes the model at most once per execution boundary (turn success/failure, session idle); a boundary with background work in flight does not wake immediately — it arms a one-shot progress check after a silence window. The loop keeps the model advancing until the goal terminates or an explicit budget cap is exhausted. |
| Evidence gate | `complete` requires concrete, verifiable evidence (≥24 chars, fact-anchored, grounded in the conversation); otherwise it counts as not done. |
| Stall arbitration | Consecutive no-action wakes (default 3) reaching the limit → **by default the goal is marked stalled outright** (stall report + archive, surfaced to the human); the bypass LLM judge is **opt-in** (with `judgeEnabled` on, it interprets the stall cause at most once per goal before stalling: continue / wrap up / hand off; unparseable judge output = give up, never fabricated). |
| Watchdog | No active checking: a boundary with background work in flight (shells / subtask sessions) does not wake — it arms a one-shot progress check that fires after `checkInDelaySec` of silence, and any activity cancels it. The check-in reminder lists the in-flight items by id and elapsed time (the model never has to re-query). Shell exits are not direct wakes — completion rides the progress check. |
| Budget | **Unbounded by default**; tokens are stats-only by default — caps are opt-in. |
| Task list | Tasks per goal are uncapped, `todo / doing / done` states, surfaced in wake messages / stall reports / the compaction `[GOAL STATE]` block. |
| Wait declaration `goal_wait` | The model declares "I'm waiting" and suspends for N minutes (integer 1–60), without consuming the stall budget. |

## Install

### npm (canonical)

Add the plugin entry to your OpenCode config file; the host fetches it from npm automatically (zero runtime dependencies):

- **Global**: `~/.config/opencode/opencode.jsonc` (applies to all projects)
- **Project**: `opencode.json` / `opencode.jsonc` in the project root (this project only)

If the file already has a `plugins` array, just merge the entry in:

```jsonc
{
  "plugins": [
    { "package": "@ch2lab/opencode-goals", "options": {} }
  ]
}
```

The host hot-reloads the plugin when the config changes (verified on 2.0.29+; restart the host if you prefer). After install, `/goal` appears in the command list and the plugin shows `active`. Leave `options` empty for the defaults; the tunables are in the options table below. Pin a version with `"@ch2lab/opencode-goals@1.1.6"`.

> The entry is a wrapper-stripped, zero-import variant (the host-verified form), immune to `@opencode/plugin` version drift.

Local source directory (for development): clone the source repo; `index.ts` loads directly, no build needed (`@opencode/plugin` pinned to the host version as a dev dependency: `bun add -d @opencode/plugin@2.0.29`):

```bash
git clone https://github.com/ch2lab/opencode-goals
```

```jsonc
{
  "plugins": [
    { "package": "<path to the cloned source directory>", "options": {} }
  ]
}
```

## Usage

### `/goal` commands (user side)

| Command | Description |
|---|---|
| `/goal set <objective> [--turns N] [--tokens N] [--unbounded]` | Start a goal. **Unbounded by default**; `--turns N` / `--tokens N` set explicit caps; `--unbounded` = no cap (the default — kept for compatibility). |
| `/goal view` | View the current goal (status / objective / cap & usage). |
| `/goal pause` | Pause the current goal. |
| `/goal resume` | Resume the current goal (from `paused` / `blocked` / `budget_limited`; `completed` / `stalled` / `cleared` are hard-terminal and cannot be resumed). |
| `/goal complete <evidence>` | Mark complete (evidence-gated). |
| `/goal block <reason>` | Mark blocked (reason required; any user message or `/goal resume` resumes it). |
| `/goal clear` | Clear the goal (fail-closed: the transcript must contain the user's own clear intent). |
| `/goal history` | List archived goals of this session. |
| `/goal task add <title>` | Add a task (uncapped). |
| `/goal task <n> <todo\|doing\|done>` | Change a task's status; `n` = 1-based index or task id. |

Each subcommand is also registered as a fine-grained command (`/goal-set` / … / `/goal-clear`), visible as separate `/` menu lines with per-command argument help — bare `/goal` prints the usage menu.

**Every user command's result line kicks a short model reply turn** — 2.1.x hosts do not render pure record lines in the UI, so the model's one-line reply is the visible output (spec §49-rev, 2026-10-21). The five machine-originated terminal/pause notices (completed / blocked / stalled / budget_limited / provider-pause) stay pure records and never kick.

### Typical Flow

```
/goal set Refactor the auth module, keep all tests passing --turns 15
```

The model then enters the goal loop: it is woken at each execution boundary to keep going; check progress any time with `/goal view`; when the bar is met it completes itself via `goal_complete` (evidence-gated); a stall (no-action wakes reaching `stallLimit`) marks the goal stalled by default (the report is for the human), or runs one judge arbitration first when enabled; an EXPLICIT budget cap, when set, ends the goal automatically (goals are unbounded by default).

### Typical dialogue scenarios

Once a goal is set, the whole lifecycle can be managed in plain conversation — the model maps your words to the matching `goal_*` tool; behavior is identical to the `/goal` commands (same implementation core).

| You say (example) | The model calls |
|---|---|
| "see this refactor through, stop when the tests are green" | `goal_set` |
| "where are we at on the budget?" | `goal_view` |
| "hold on" / "pause this goal" | `goal_pause` |
| "keep going" / "resume that goal" | `goal_resume` |
| "add a todo: …" | `goal_add_task` |
| "mark task 2 done" | `goal_update_task` |
| "stop here until someone decides" (with a reason) | `goal_block` (any later user message or "keep going" resumes) |
| "check back in 20 min once the deploy lands" | `goal_wait` |
| "I confirm it's done" / "wrap it up" | `goal_complete` (evidence-gated) |
| "drop this goal" | `goal_clear` (must quote your own words) |

The command surface is unaffected: `/goal …` and the fine-grained commands (`/goal-pause`, …) keep working — the two are just two faces of the same capability.

### Options (the plugin's `options`)

| option | type | default | description |
|---|---|---|---|
| `stallLimit` | number | `3` | Consecutive no-action wakes before the stall: by default the goal is stalled outright; with `judgeEnabled` on, a one-shot bypass-judge arbitration runs first. |
| `providerFailLimit` | number | `2` | Consecutive provider-error boundaries before a silent pause: no wakes, no turns burned, no stall count, one synthetic notice per incident; a clean boundary auto-resumes and resets the streak. |
| `providerPauseMs` | number | `1800000` | Provider-failure pause duration in ms (default 30 min); a one-shot retry wake fires at expiry, and failed retries extend the pause without re-noticing. |
| `defaultCapTurns` | number | (none = unbounded) | **Unbounded by default**; set (positive integer) to cap goals that omit `--turns`. |
| `defaultCapTokens` | number | (none) | Default token cap. **Omitted = tokens are stats-only**; set it to cap goals that omit `--tokens`. |
| `judgeEnabled` | boolean | `false` | Enable the bypass judge (**default off**: at the stall limit the goal stalls and surfaces to the human; when on, unparseable output = give up, fail-closed). |
| `judgeMaxPerGoal` | number | `1` | Resolved but **behavior is spec-fixed to at most once per goal** (anti judge/agent kick-loop; other values have no effect). |
| `watchdogTickMs` | number | `30000` | Watchdog tick period (one timer per active goal). |
| `checkInDelaySec` | number | `300` | Background in-flight gate: a boundary with background work in flight (shells / subtask sessions) does not wake immediately; it arms a one-shot progress check after this many SECONDS of silence. Any activity cancels it. |
| `timeoutWrap` | boolean | `false` | Opt-in: while any goal in this instance is active, spawns with `timeout === 0` get `timeout` rewritten in place to `checkInDelaySec × 1000`. |
| `wakeText` | string | (none) | Custom wake text; appended as a final `Extra instruction: <wakeText>` line to boundary/judge-downgrade wake messages (the background progress check uses its own text). |
| `model` | string | (session model) | Model used for bypass generation (judge + compaction summary), `"providerID/modelID"`. **Omitted = follow the session's current model** (per-session, including mid-session switches; falls back to the host default when the session has no explicit model). Strict two-segment format; invalid values warn and fall back. |

Numbers must be positive integers, booleans must be boolean literals; anything else silently falls back to the default (pure-function parsing, no side effects).

## Design

- **One wake per boundary, and the wake message is a plain state message** — no special audit channel, no state escalation: the model decides how to continue from its own context; the loop never hijacks the host's normal conversation flow.
- **fail-closed**: in-flight facts come from per-boundary live queries (active map / shell store / inbox) — a failed query skips the boundary, never causes a false wake; unparseable judge output → give up; insufficient evidence → treated as not done; `clear` without the user's own words → refused.
- **Control plane / data plane separation**: all 12 `goal_*` tools declare the dedicated permission action `goal.control`; the plugin self-grants allow when "the session has a goal record (any status) and belongs to this instance" (the control plane covers goal existence, so the goal stays manageable in conversation); the data-plane path sandbox engages only while a goal is active, and never relaxes user-configured deny rules.
- **Bypass generation follows the session's current model by default**; pin a cheaper one via `model` — the judge and compaction summary never pollute the main conversation context.
- **Zero runtime dependencies**: the published entry is a wrapper-stripped, zero-import variant, immune to `@opencode/plugin` version drift.
- **Stream self-healing (§50)**: a dead or errored host event stream is re-subscribed (≥1s backoff, loudly logged) instead of terminating the loop; an independent global liveness scan (30s period; 5min of silence while a started turn has no terminal) forces a re-subscribe + boundary re-arbitration, so a dropped subscription can no longer freeze the goal (origin: the 2026-10-21 incident — a clean stream end froze a production goal for ~4.5h with zero logs).

## Tools (model-facing)

All 12 tools declare the `goal.control` permission, and each shares the same implementation core as its `/goal` command (behavioral equivalence — every capability is invokable in conversation). One-line gating rule per tool:

| Tool | Gating |
|---|---|
| `goal_set` | Refused while a non-terminal goal exists (complete/block/clear first). |
| `goal_complete` | Requires an active goal; evidence must pass the three-layer check (length / anchoring / grounding). |
| `goal_block` | Requires an active goal + non-empty reason. |
| `goal_clear` | Requires an active goal; the request must quote the user's own words (grounded in non-assistant messages; fail-closed). |
| `goal_history` | Read-only; works without a goal. |
| `goal_add_task` | Requires a non-terminal goal; the task ledger is uncapped. |
| `goal_update_task` | Requires a non-terminal goal with tasks; `status ∈ todo\|doing\|done`. |
| `goal_wait` | Requires an active goal; suspends the wake for N minutes (integer 1–60), declares "I'm waiting", does not consume the stall budget. |
| `goal_pause` | Requires an active goal; suspends the loop (no wakes, no stall counting); resumed via `goal_resume` / `/goal resume`. |
| `goal_resume` | Resumes from `paused` (silent) / `blocked` (stale blocker cleared + re-wake) / `budget_limited` (re-wake; a one-shot post-resume budget grace lets the resume's own boundary pass — the next over-cap boundary re-limits, spec §49); `completed` / `stalled` / `cleared` are hard-terminal. |
| `goal_next_step` | No gating (recordable at any time); records the model's own next-step plan, persisted with the goal and replayed at the next wake. **If the session's goal has ended (completed/paused/blocked/stalled), the call re-activates it as a fresh phase** (counters reset, same cap, prior evidence archived); `cleared` / `budget_limited` stay terminal. |
| `goal_view` | Read-only, no side effects (no wake, no state change); a session without a goal record gets a notice. |

## Unattended Safety

- **Path sandbox**: engages in permission evaluation only while a goal is active, and only for write actions (`fs.write`); absolute paths inside the session working directory → auto-allow, outside → auto-deny (the message steers the model to `goal_block`). Read actions and indistinguishable actions are unrestricted (the plugin takes no stance; reads open, writes contained only).
- **deny is never relaxed**: user-configured deny entries are never overridden by the plugin; non-path resources (URLs, commands) are left undecided (the host's own policy applies).
- **fail-closed**: in-flight facts come from per-boundary live queries (active map / shell store / inbox) — a failed query skips the boundary, never causes a false wake; unparseable judge output → give up; insufficient evidence → treated as not done.

## Data plane

The plugin reads host state over the host's own **HTTP client surface** (in-process `ctx.rpc` is the host→plugin registration channel; plugin→host queries are unavailable on 2.0.32 — spec appendix §17):

- **Discovery**: `%USERPROFILE%\.local\state\opencode\service.json` (`XDG_STATE_HOME`-redirectable): `{id, version, url, pid, password}` — the managed-service registration file.
- **Auth**: HTTP Basic, username fixed `opencode`, password from the registration file.
- **Self-identification**: the registration file's `pid` must equal the host process that loaded this plugin; mismatch / parse failure → the query-failure path (never guess, never connect to the wrong host).
- **Endpoints**: `GET /api/shell` (in-flight background shells; the location is passed via the `x-opencode-directory` request header, URL-encoded — the server's `requestRef` only honors that header or the bracket query `location[directory]`; dot-notation params like `location.directory=` are invisible and silently fall back to the service's cwd, which is always home under `serve --service`), `GET /api/session` (session list + `parentID` — subtask attribution; same location header), `GET /api/session/active` (active map: `sessionID→status`; `"running"` = a turn is executing; the same signal the host UI reads; same location header), `GET /api/session/:id/inbox`, `DELETE /api/session/:id/inbox/:inboxID` (a 404 `SessionNotFoundError` = empty-list / already-done semantics, not an error).
- **Gate signal**: the in-flight signal is `{own, other, queued, ownKnown}` — `own` = the session's running shells; `other` = subtasks whose `parentID` chain reaches this session AND the active map says `"running"`; `queued` = undelivered inbox items (pending input **never triggers a synchronous wake** — a wake queued behind the user's own message breaks the "a wake never appears in the queue" invariant); a failed query reports `own=0, other=0, queued=0, ownKnown=false` (never a fake count): that boundary is **skipped** (no wake, no check-in arm, no stall budget spend) — the host context is dead, and reviving sessions is not the plugin's job. Every wake / hold / skip appends one line to the **decision log** `<tempdir>/opencode-goal/decisions-<hostpid>.jsonl` (append-only, best-effort; each of the four signals carries its own field).

## Test & Verification

- **Host contract: opencode 2.0.32 (original) and 2.1.1 (2026-10-21 batch)** — protocol d.ts + binary forensics + live probes; the "Known Limitations" entries marked with a host version were measured on that host.
- **Three verification layers; host-behavior claims come only from the last two**: ① `bun test` — in-process stub host, fast, but contract data is faked: **not real-host evidence**; ② `scripts/verify-*.ts` — a one-shot isolated real host on this machine (`opencode serve`; isolated config/state + blank dir; LLM = an env-configured lab provider or a scripted mock); ③ the production host — seeded build + log / decision-log observation, no intrusive probes.
- **Known environment delta**: the isolated harness boots plain `serve` (which does NOT write the service.json registration file; only `serve --service` does) — the verify scripts write `{url,pid,password}` after boot to match production (hostapi re-reads the registration file per query).

## Known Limitations (host behavior measured on 2.0.29–2.1.1; plugin behavior as of 1.1.6, §51 pending the next release)

1. **(measured on 2.0.29; resolved under 2.0.32 + native registration)** the CLI serve form used to reject the model's `goal_*` calls (the tools were then registered in the Code Mode channel); under the current combination (2.0.32 + tools registered native, `codemode:false`) **both the serve and desktop forms expose all 12 `goal_*` tools to the model and the host dispatches them** (isolated 2.0.32 serve host: all 12 in the model request's tools array, the host dispatched a model `goal_next_step` into the plugin; the production desktop form shows the same).
2. **The plugin→host data channel is the HTTP client surface (2026-10-17 change; 2026-10-20 gate made pure-query)**: in-process `ctx.rpc` (the host→plugin registration channel) is unavailable for plugin-side queries on 2.0.32 — the earlier zero-probe / events-only ruling is replaced. The gate is a **per-boundary live query**: the active map (`GET /api/session/active`, `"running"` = in flight) ∧ the session list's `parentID` chains (subtask attribution) ∧ the shell store (`GET /api/shell`, the session's running shells) ∧ the inbox (`GET /api/session/:id/inbox`, queued input — pending input never triggers a synchronous wake, see "Gate signal" above); a failed query = the host context is dead → the boundary is skipped (fail-closed); the watchdog is a per-active-goal timer tick (`watchdogTickMs`), no longer event-driven; the progress check (check-in) remains a queued-message delivery with in-plugin-memory cancellation.
3. **Two-level wake delivery**: the host delivers queued inbox items only when the session is idle; delivery is deferred while the model's own turn is in flight (including when blocked on a `question` form) — host scheduling behavior, not a plugin defect; this delivery semantics is exactly what the queued gate relies on: the plugin never delivers or rushes — it waits for the host's idle-time delivery and the natural arrival of the next boundary.
4. **Host restart** (killing the service while idling on a shell): shell records vanish and the host sends no cancellation notice (host fact, unchanged); the plugin does not reconcile on restart (removed 2026-10-17) and, since 1.1.4, **holds no cross-restart in-flight state** (the gate is a per-boundary live query) — the host's in-memory tables reset with the new process (the active map is empty; a zombie lock cannot survive a restart), and the first post-restart boundary recovers the loop via fresh queries and wakes normally (isolated 2.0.32 host: the goal record's kv survives, the plugin reloads, the first post-restart boundary truly wakes, in-flight 0).
5. **Host-native recovery not triggered** (killing the serve process mid-turn and restarting): no restart synthetic message, no suspended-session sweep — verified in the serve form (2.0.29; host-side behavior the plugin does not rely on).
6. **Host quirk** (measured on 2.0.29; host-side): with no model configured the host falls back to the built-in (deprecated) `exo-free`; the `POST /api/session/:id/shell` response only returns **when the shell exits** (long scripts hang the POST).
7. **(retracted 2026-10-17) the earlier "location-routing gap" was the plugin's own probe encoding error, not a host gap**: the shell list (`GET /api/shell`) is a **per-location in-memory table** (lists only `status=running`), but location routing works — the server's `requestRef` only honors the `x-opencode-directory` header (URL-encoded) or the bracket query param `location[directory]`; early probes sent dot-notation `location.directory=`, which is invisible to the server and silently falls back to the service's cwd (`serve --service` chdirs to home), so every request "landed on home" and was misdiagnosed as a gap. The plugin's `shellList` now sends the `x-opencode-directory` header (checked against the public source + 5/5 live verification against an isolated host); in-flight shells in a non-default location (including the model's own background shells) are now visible, and the gate covers the right location's table.
8. **2.1.1 host deltas (measured 2026-10-21; host-side behavior the plugin adapts to)**: (a) a command/synthetic/prompt sent into a **running** session is STEERED into the in-flight turn (no new turn starts, nothing queued) — the plugin's kick semantics account for this; (b) the goalControl result-line synthetic may be delivered to the inbox as a `user`-typed item — the plugin classifies by the `goalControl` metadata, not the item type; (c) `resume:false` record lines are **not rendered in the UI** (they stay in `session_inbox`, never promoted to `session_message`) — hence §49-rev: every user command result line kicks a visible model reply; (d) the root cause of the event stream's silent death is **not pinned** (clean end, zero host errors — candidate: tunnel / bus scope lifetime) — the plugin self-heals via §50 (re-subscribe + liveness recheck), independent of the host version.

## Development

Model-dependent scripts (the `verify-*.ts` real-host batches, live smoke without `--skip-model`, the diagnostics) need a local LLM; credentials are read **only from environment variables** (no default credentials in code):

```bash
export OPENCODE_LAB_PROVIDER_BASE="http://<lab-host>:8000/v1"
export OPENCODE_LAB_PROVIDER_KEY="<key>"          # scripts exit with code 2 when missing
# optional: OPENCODE_LIVE_SMOKE_MODEL_ID

bun test            # full unit + integration suite (the gate)
bun run typecheck   # tsc --noEmit
bun run scripts/live-smoke.ts            # live smoke (isolated, safe; --skip-model needs no credentials)
bun run scripts/verify-wake.ts            # real-host batch: kick semantics + budget grace (§48/§49/§49-rev)
bun run scripts/verify-heal.ts            # real-host batch: §50 stream self-heal (probe-killed subscription)
bun run scripts/verify-checkin.ts         # real-host batch: §51 check-in in-flight roster
bun run scripts/verify-active.ts          # real-host batch: in-flight gate / resurrection phase
bun run scripts/verify-subtask.ts         # real-host batch: subtask attribution
bun run scripts/verify-sandbox.ts         # real-host batch: path sandbox
bun run scripts/diagnostics-callback.ts  # diagnostic: lost script callback (manual read, not gated)
bun run scripts/diagnostics-restart.ts   # diagnostic: kill/restart while idling on a shell
bun run scripts/diagnostics-native-resume.ts  # diagnostic: kill/restart mid-turn (needs local LLM)
```
