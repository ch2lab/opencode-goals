// Goal lifecycle controller (Task 7 + Task 8 + Task 10 + Task 11): command + tool
// surface, storage discipline, snapshot, the boundary arbiter + wake loop
// (spec §6 arbitration sequence, §11 budget, §15-9 blocked resume) AND the
// shell-wait background gate (spec §7.1: in-flight boundary does not wake —
// it arms a one-shot progress check; the event-driven shell exit wake).
// Composes the tested pure modules (state / options / evidence / judge /
// wake) over the WakeProbe host surface — none of their logic is
// reimplemented here.
//
// Fault-tolerance discipline (Task 7 + Task 8 briefs):
// - every command/tool handler converts ALL failures into synthetic / text
//   feedback and never throws into the host;
// - storage writes, archiving, and synthetic delivery are best-effort:
//   failures are logged and swallowed (the event loop must never break);
// - every event is processed behind its own try/catch: a single event
//   failure is logged and the loop continues.
//
// Task 9: at the stall threshold the ONLY non-mechanical step is the
// deps.judge call; its verdict is disposed inline (continue / complete /
// needs_human / give_up) — see disposeVerdict + stallGoal (spec §8).
import {
  addTask,
  archivedGoalKey,
  createGoal,
  goalStorageKey,
  isCapReached,
  isTerminal,
  resolveTaskRef,
  type GoalRecord,
  type GoalStatus,
  type GoalTaskStatus,
} from "./state";
import type { Options } from "./options";
import {
  CLEAR_KEYWORD_RE,
  MIN_CLEAR_REQUEST_LENGTH,
  validateClearRequest,
  validateEvidence,
  type TranscriptMessage,
} from "./evidence";
import type { Judge, JudgeVerdict } from "./judge";
import { backgroundCheckInText, buildWakeMessage, providerPauseNoticeText, providerPauseRetryText } from "./wake";
import { buildCompactionPrompt, composeCompactionSummary } from "./compact";
import { decidePermission, GOAL_CONTROL_ACTION } from "./permission";
import { appendDecision } from "./decisionlog";
import type { HostEvent, PermissionDecision, PermissionHookInput, SessionMessage, WakeProbe } from "./types";

// ---------------------------------------------------------------------------
// Single-instance guard — v2 (2026-10-17 field follow-up, aiserver5/129).
//
// v1 (2026-10-16 incident): the host's plugin hot-reload re-runs setup()
// WITHOUT disposing the previous instance (host log: 3x "loading plugin"
// within one second on the config swap, zero unload lines) → N live
// controllers on the same event stream + shared storage → every terminal
// boundary arbitrated N times → N duplicate boundary wakes (identical turn
// stamp).
//
// v2 fixes the v1 race: v1 claimed its registry slot at the END of start()
// (after `await reconcile()`), so concurrent loads (field evidence: 7 plugin
// loads in the 52s after a serve restart, pairs 110–210ms apart) could both
// read an empty slot and both arm → 2–3 live consumers survived. Symptoms:
// duplicate wakes again (goalTurn 8×3, 11–34 mostly ×2) AND inflated
// used.turns (every duplicate injection bumps the shared counter) → the
// turn budget burned 2–3x faster than real model turns (cap 10 turns hit in
// ~10 model turns; the budget_limited notice was delivered ×4).
//
// v2: EXACTLY ONE live controller per host process, claimed on the FIRST
// line of start() (before any await). The predecessor is stopped right after
// the claim; a start displaced mid-flight aborts before arming its loop.
// One-per-process is correct for this plugin: the adapter pins
// probe.projectID = undefined (every instance sees every session) and all
// instances share one event stream + one storage — a second consumer can
// only duplicate work, never specialize per location.
//
// The slot lives on globalThis, NOT module state: a host hot-reload can
// re-import the plugin module, which would reset module-level variables.
// ---------------------------------------------------------------------------

const LIVE_SLOT = Symbol.for("opencode-goal:live-controller");

type LiveSlot = { stop: () => Promise<void> };

function liveSlotHolder(): { slot: LiveSlot | undefined } {
  const g = globalThis as unknown as Record<symbol, unknown>;
  let holder = g[LIVE_SLOT] as { slot: LiveSlot | undefined } | undefined;
  if (holder === undefined) {
    holder = { slot: undefined };
    g[LIVE_SLOT] = holder;
  }
  return holder;
}

/** Bounded wait: the takeover must never hang on a stuck previous instance. */
function stopWithTimeout(stop: () => Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([
    stop().catch((err) => {
      console.warn(`opencode-goal: ${label}:`, err);
    }),
    timeout,
  ]).finally(() => {
    clearTimeout(timer);
  });
}

export interface ControllerDeps {
  judge?: Judge;
  tickMs?: number;
  /** Length of the continuationPending window (default 10s). Sibling
   *  terminal events of one turn end arrive within milliseconds; a real
   *  wake turn takes seconds-to-minutes, so a boundary far beyond the
   *  window is the wake turn's own terminal, not a sibling. */
  contWindowMs?: number;
}

const TASK_STATUSES: readonly GoalTaskStatus[] = ["todo", "doing", "done"];

/**
 * Multi-line usage block — returned by a BARE `/goal` (or an unknown
 * subcommand) as a session message (goalControl synthetic), so it renders as
 * a proper multi-line help listing. The /-menu hint (below) is a separate
 * SHORT one-liner — the host TUI renders the command list one row per
 * command, so newlines there do not display; the full usage lives HERE.
 */
const USAGE = [
  "Goal loop: the model advances the goal autonomously; completion is evidence-gated, budget exhaustion ends the run.",
  "",
  "Usage:",
  "  /goal set <objective> [--turns N] [--tokens N] [--unbounded]   start a goal",
  "  /goal view                                                     show the current goal",
  "  /goal pause | /goal resume                                     pause / resume",
  "  /goal complete <evidence>                                     complete with verifiable evidence",
  "  /goal block <reason>                                          block with a concrete reason",
  "  /goal clear                                                   discard the goal",
  "  /goal task add <title>                                        add a task",
  "  /goal task <n> <todo|doing|done>                              update a task",
  "  /goal history                                                 list past goals",
].join("\n");

/**
 * Command-menu description (host CommandDefinition.description — the hint
 * shown next to /goal in the / command list). The host clamps each menu
 * description to a single row (web UI ellipsis — verified live on 2.0.32
 * desktop, 2026-10-17), so per-subcommand argument help lives on the
 * fine-grained commands below (one row each); the /goal row just points at
 * the bare-`/goal` usage table (USAGE).
 */
const GOAL_COMMAND_DESCRIPTION = "goal loop — full usage: run bare /goal";

/**
 * Fine-grained command registrations (2026-10-17 user ruling): instead of one
 * `/goal` row with prose, each subcommand gets its OWN command (goal-set,
 * goal-view, ...) so the / menu shows one line per subcommand carrying its
 * argument syntax. Each routes into the same handleCommand as /goal (text
 * prefixed "goal <sub>" — dispatchCommand strips the leading "goal").
 *
 * Surface principle — a menu row is earned by "a human actually types this":
 * set/view/pause/resume/complete/block/clear are human control operations
 * (view/pause/resume are HUMAN-ONLY — no LLM tools exist for them, because
 * pause is a human decision and state arrives via wakes). task/history are
 * MODEL-centric (goal_add_task/goal_update_task/goal_history tools exist) —
 * they stay available as /goal subcommands but earn no menu row. wait is
 * model-only (goal_wait tool, no command — an execution mechanism).
 */
const GOAL_SUBCOMMANDS: Array<{ name: string; sub: string; description: string }> = [
  { name: "goal-set", sub: "set", description: "<objective> [--turns|--tokens N] [--unbounded] — start a goal" },
  { name: "goal-view", sub: "view", description: "show the current goal" },
  { name: "goal-pause", sub: "pause", description: "pause the active goal" },
  { name: "goal-resume", sub: "resume", description: "resume the paused goal" },
  { name: "goal-complete", sub: "complete", description: "<evidence> — finish with verifiable evidence" },
  { name: "goal-block", sub: "block", description: "<reason> — stop with a concrete reason" },
  { name: "goal-clear", sub: "clear", description: "discard the goal" },
];

/** All 8 goal_* tools are gated by the goal.control permission (Task 3). */
const GOAL_PERMISSION = GOAL_CONTROL_ACTION;

/** In-memory dedup cap for processed eventIDs (brief: "上限如 1000"). */
const HANDLED_ID_LIMIT = 1000;

/**
 * "Last enqueued inbox item" attribution (spec §6-⑤). Sources:
 * - `session.inbox.enqueued` events (item type read from properties —
 *   schema/dist/session-event.d.ts InboxEnqueued.data = { item, inboxID,
 *   sessionID });
 * - this plugin's own wake injections (InboxRef.id from probe.prompt —
 *   verified lastInbox mode in the reference project);
 * - this plugin's own goalControl synthetics (self-recorded, because the
 *   harness emits no enqueued events for probe.synthetic — controller
 *   ruling fallback; in the real host the enqueued echo lands the same way).
 */
type LastInboxEntry =
  // watchdog?: true marks OUR watchdog wakes (check-in / shell exit / lost —
  // Task 10). The boundary fast path (spec §7.1: a pure-text check-in reply
  // counts per the stall ladder) keeps normal arbitration exactly for these.
  | { id: string; kind: "wake"; goalID: string; watchdog?: true }
  | { id: string; kind: "user" }
  | { id: string; kind: "control" }
  // compaction / move / unmarked synthetic / untracked — pinned in
  // test/arbiter.test.ts as counting toward the stall ladder.
  | { id: string; kind: "other" };

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * stallReport (Task 9): the objective verbatim, the todo snapshot
 * (`N. [status] title` per task — same line shape as the wake message),
 * the last ≤3 no-action texts verbatim, and the judge's reason (or a note
 * on why the judge did not rule).
 */
function buildStallReport(goal: GoalRecord, noActionTexts: string[], judgeReason: string): string {
  const tasks =
    goal.tasks.length === 0
      ? "  (no tasks)"
      : goal.tasks.map((t, i) => `  ${i + 1}. [${t.status}] ${t.title}`).join("\n");
  const tails =
    noActionTexts.length === 0
      ? "  (none)"
      : noActionTexts.map((t) => `  - ${t}`).join("\n");
  return [
    `[STALL REPORT goal ${goal.id}]`,
    `Objective: ${goal.objective}`,
    "Task snapshot:",
    tasks,
    "Last no-action texts:",
    tails,
    `Judge: ${judgeReason}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Task 10: watchdog text builders + shell-event payload normalization
// ---------------------------------------------------------------------------

/**
 * ShellInfo from either shell event family (schema-verified, 2.0.29):
 * - `session.shell.started` / `session.shell.ended` (durable, session-scoped —
 *   the mechanically attributable family): data = { shell: ShellInfo,
 *   sessionID }, and `output: { output, cursor, size, truncated }` on ended
 *   (schema/dist/session-event.d.ts Shell.Started/Ended).
 * - `shell.created`: data = { info: ShellInfo }; `shell.exited`:
 *   data = { id, exit?, status } (schema/dist/shell.d.ts — EPHEMERAL, no
 *   sessionID in 2.0.29 → they never pass the session gate above; handled for
 *   a future host that adds attribution. TODO(task13) live-smoke).
 * ShellInfo.status ∈ "running" | "exited" | "timeout" | "killed" (Shell.Status
 * — there is no "completed" value; "exited" is the plain exit).
 */
function shellInfoFrom(props: Record<string, unknown>): {
  id: string;
  status?: string;
  command?: string;
  cwd?: string;
  exit?: number;
} | undefined {
  const src = (isPlainObject(props.shell) ? props.shell : isPlainObject(props.info) ? props.info : undefined) as
    | Record<string, unknown>
    | undefined;
  if (src !== undefined) {
    const id = typeof src.id === "string" ? src.id : undefined;
    if (id === undefined) return undefined;
    return {
      id,
      status: typeof src.status === "string" ? src.status : undefined,
      command: typeof src.command === "string" ? src.command : undefined,
      cwd: typeof src.cwd === "string" ? src.cwd : undefined,
      exit: typeof src.exit === "number" ? src.exit : undefined,
    };
  }
  // shell.exited shape: data = { id, exit?, status } (schema/dist/shell.d.ts)
  const id = typeof props.id === "string" ? props.id : undefined;
  if (id === undefined) return undefined;
  return {
    id,
    status: typeof props.status === "string" ? props.status : undefined,
    exit: typeof props.exit === "number" ? props.exit : undefined,
  };
}

/** Result wake (fast path): status wording. */
function shellExitText(shellID: string, status: "exited" | "timeout" | "killed", exitCode?: number, tail?: string): string {
  const head =
    status === "timeout"
      ? `The shell you were waiting for, ${shellID}, timed out (timeout, terminated by the host)`
      : status === "killed"
        ? `The shell you were waiting for, ${shellID}, was killed (killed, terminated externally)`
        : `The shell you were waiting for, ${shellID}, exited (exit${exitCode !== undefined ? `, code ${exitCode}` : ""})`;
  // 2026-10-18 autonomy ruling: reframed tail (was "Decide the next step; end
  // this turn with a tool call.") — grant goal-mode autonomy instead of an
  // imperative forced-tool-call; user-message-overrides clause for consistency.
  return `${head} — latest output tail:\n${tail ?? "(none)"}\nGoal mode: take the next safe step per the goal's discipline (act on this result, or make independent progress). A user message always overrides this reminder.`;
}

export class GoalController {
  // deps.judge feeds the stall ladder (Task 9); deps.tickMs drives the
  // watchdog tick (the one-shot background check-in heartbeat).
  constructor(
    private readonly probe: WakeProbe,
    private readonly options: Options,
    private readonly deps: ControllerDeps = {},
  ) {}

  // ------------------------------------------------------------------
  // Task 8: boundary arbiter + wake loop (spec §6 / §11 / §15-9)
  // ------------------------------------------------------------------

  /**
   * Per-session turn bookkeeping (in-memory, per controller instance —
   * controller ruling: goal state-machine facts (stalls / turns /
   * lastHandledEventID) live in storage, these runtime flags do not).
   * `session.execution.started` → active=true, toolCalled=false,
   * continuationPending cleared; `session.tool.called` → toolCalled=true;
   * a consumed terminal boundary → active=false (toolCalled kept for the
   * next attribution, overwritten by the next started).
   */
  private turns = new Map<string, { active: boolean; toolCalled: boolean }>();
  /**
   * In-flight session registry (2026-10-17 ruling): EVERY session of this
   * project currently mid-turn — goal-independent (the in-flight gate counts
   * sessions, not goals). `session.execution.started` → add; terminal
   * boundary → delete. Feeds inFlightCount(); a lost terminal event leaves a
   * stale entry (degrades to a slower gate, never a false wake).
   */
  private activeSessions = new Map<string, number>();
  /**
   * One-shot progress-check deadline per session (2026-10-17 ruling): armed at
   * in-flight boundaries, cancelled by any session activity, fired by the
   * watchdog tick.
   */
  private checkinDue = new Map<string, { due: number; inFlight: number }>();
  /** warn-once set: shell-store query failures (safe direction keeps the gate armed). */
  private shellQueryWarned = new Set<string>();
  /** continuationPending window: value = arm time (ms) at wake injection,
   *  cleared by execution.started; time-bounded in arbitrateBoundary. */
  private contPending = new Map<string, number>();
  /**
   * First boundary skipped INSIDE the current pending window, per session
   * ("" when the skipped boundary had no id). Bounded-fallback bookkeeping:
   * the window may skip at most ONE boundary before a second DISTINCT
   * boundary closes it (controller ruling I1).
   */
  private pendingSkipped = new Map<string, string>();
  /**
   * Consecutive provider-errored boundaries per session (2026-10-17 ruling,
   * 129 quota incident). Reaching `providerFailLimit` arms the provider pause
   * (goal.providerPause); any CLEAN boundary (model ran) resets to zero.
   * In-memory only: a hot reload restarts the streak at 0 — a re-detected
   * failure simply re-arms the pause.
   */
  private providerFailStreak = new Map<string, number>();
  /** "Last enqueued inbox item" per session (spec §6-⑤) — attribution source. */
  private lastInbox = new Map<string, LastInboxEntry>();
  /** Latest wake inbox per session: reclassifies the host's enqueued echo of OUR prompt. */
  private wakeInbox = new Map<string, { inboxID: string; goalID: string; watchdog?: boolean }>();
  /** Blocked-resume dedup: inboxIDs already resumed (bounded). */
  private resumeInbox = new Set<string>();
  /** Processed eventIDs (in-memory dedup, bounded at HANDLED_ID_LIMIT). */
  private handledIDs = new Set<string>();
  private handledOrder: string[] = [];
  /**
   * Judge instruction channel (Task 9): a `continue` verdict's optional
   * `instruction` is parked here per session and rides into the NEXT wake as
   * the judge paragraph of buildWakeMessage. Cleared on every terminal
   * transition (finishGoal / budget_limited) and when a new goal starts
   * (setGoal). In-memory by design: a restart loses it (acceptable).
   */
  private judgeInstruction = new Map<string, string>();
  private loopIter: AsyncIterator<HostEvent> | undefined;
  private loopPromise: Promise<void> | undefined;
  private stopped = false;
  /** This instance's live-slot reference (set at the first line of start()). */
  private liveSlotRef: LiveSlot | undefined;
  /** Memoized stop: stopInstance is idempotent (takeover + host unload share it). */
  private stopping: Promise<void> | undefined;

  // ------------------------------------------------------------------
  // Task 10: watchdog (spec §7.1) — per-goal tick timers + per-shell
  // in-memory watch state (tail / lastTailAt / checkedIn live ONLY here,
  // never in storage; waitingShells itself is the persisted fact anchor).
  // ------------------------------------------------------------------

  /** One tick timer per armed goal (sessionID key — one active goal per session). */
  private wdTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Per-goal in-flight tick guard (a tick never overlaps itself). */
  private wdBusy = new Set<string>();
  /**
   * (command, cwd) → host timeout (ms) captured on create.before (timeout > 0
   * only; timeout 0 = no timeout → not recorded). Correlated onto shell
   * events by command+cwd; correlation failure = no timeout (conservative:
   * earlier check-in — direction safe). Bounded FIFO at 200 entries.
   */
  private shellTimeouts = new Map<string, number>();
  private shellTimeoutOrder: string[] = [];

  /**
   * Registers the /goal command and the 8 goal_* tools on the probe and
   * returns the cleanup function (awaited by the plugin entry on dispose).
   */
  async start(): Promise<() => Promise<void>> {
    // Single-instance guard (v2): claim the process-wide slot on the FIRST
    // line — before ANY await — so two concurrent starts cannot both observe
    // an empty slot (the v1 race: claim at the end of start(), after
    // `await reconcile()`, let raced hot-reload loads both arm). Then stop
    // the displaced predecessor (bounded — a stuck old stop cannot block the
    // takeover), and a start that is itself displaced mid-flight aborts
    // below without arming its event loop.
    const slot: LiveSlot = { stop: () => this.stopInstance() };
    this.liveSlotRef = slot;
    const holder = liveSlotHolder();
    const prev = holder.slot;
    holder.slot = slot;
    if (prev !== undefined) {
      await stopWithTimeout(prev.stop, 10_000, "stopping displaced controller timed out");
    }
    if (this.stopped) return slot.stop; // displaced during the takeover — do not arm

    this.probe.registerCommand("goal", GOAL_COMMAND_DESCRIPTION, (text, sessionID) =>
      this.handleCommand(sessionID, text),
    );

    // Fine-grained commands: one per subcommand so the host's / menu shows a
    // dedicated one-line argument-help row for each (2026-10-17 user ruling —
    // the menu clamps every description to a single row). Each routes into
    // the same handleCommand as /goal; dispatchCommand strips the leading
    // "goal", so "goal set <objective>" reaches the identical set path.
    for (const s of GOAL_SUBCOMMANDS) {
      this.probe.registerCommand(s.name, s.description, (text, sessionID) =>
        this.handleCommand(
          sessionID,
          `goal ${s.sub}${text.trim() ? " " + text.trim() : ""}`,
        ),
      );
    }

    this.probe.registerTool(
      "goal_set",
      {
        description:
          "Use only when the user explicitly asks you to set a goal. Start a new goal " +
          "(objective required; optional turns/tokens cap, unbounded for no cap). " +
          "Gating: goal.control permission; refused while a goal is still non-terminal — the old " +
          "goal is left untouched (complete, block or clear it first, then set again).",
        input: {
          type: "object",
          properties: {
            objective: { type: "string" },
            turns: { type: "number" },
            tokens: { type: "number" },
            unbounded: { type: "boolean" },
          },
          required: ["objective"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_set", () => this.toolSet(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_complete",
      {
        description:
          "Terminal: mark the ACTIVE goal completed with concrete, checkable evidence " +
          "(\u226524 chars, anchored, grounded in the transcript). Gating: goal.control permission; " +
          "refused when no goal is active.",
        input: {
          type: "object",
          properties: { evidence: { type: "string" } },
          required: ["evidence"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_complete", () => this.toolComplete(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_block",
      {
        description:
          "Terminal: mark the ACTIVE goal blocked with a concrete reason. " +
          "Gating: goal.control permission; refused when no goal is active or the reason is missing.",
        input: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_block", () => this.toolBlock(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_clear",
      {
        description:
          "Terminal: clear the ACTIVE goal. The request must quote the user's own words " +
          "(grounded in non-assistant transcript messages; fail-closed). " +
          "Gating: goal.control permission; refused when no goal is active.",
        input: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_clear", () => this.toolClear(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_history",
      {
        description:
          "Read-only: list the archived goals of this session. Gating: goal.control permission; no goal required.",
        input: { type: "object", properties: {} },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_history", () => this.toolHistory(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_add_task",
      {
        description:
          "Add a todo task (title required; the ledger is uncapped). " +
          "Gating: goal.control permission; requires a non-terminal goal.",
        input: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_add_task", () => this.toolAddTask(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_update_task",
      {
        description:
          "Set a task's status (todo|doing|done); ref is the 1-based index or the task id. " +
          "Gating: goal.control permission; requires a non-terminal goal with tasks.",
        input: {
          type: "object",
          properties: {
            ref: { type: ["string", "number"] },
            status: { type: "string" },
          },
          required: ["ref", "status"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_update_task", () => this.toolUpdateTask(sessionID, input)),
    );
    this.probe.registerTool(
      "goal_wait",
      {
        description:
          "Suspend wake-ups for N minutes (integer 1..60) while waiting on something. " +
          "Gating: goal.control permission; requires an ACTIVE goal.",
        input: {
          type: "object",
          properties: { minutes: { type: "number" } },
          required: ["minutes"],
        },
        permission: GOAL_PERMISSION,
      },
      (input, sessionID) => this.guarded("goal_wait", () => this.toolWait(sessionID, input)),
    );

    // Task 10: shell timeout correlation — the host hands { command, cwd,
    // timeout } to create.before BEFORE spawn (timeout 0 = no timeout; payload
    // is mutable — spec §7.1 timeout awareness). Task 14 Fix 3b (timeoutWrap,
    // spec §15 决定 7): when the host gives NO timeout (timeout === 0) and this
    // instance holds an ACTIVE goal, rewrite input.timeout to
    // checkInDelaySec * 1000 in place (the payload is mutable) — an unwrapped
    // spawn gets reaped by the host after the background-wait window, so a
    // stalled shell can never silently outlive the session's patience.
    // Simplified ruling (controller): "this instance has ANY active goal"
    // (activeGoalSessions, synced in loadGoal/saveGoal) — no per-shell session
    // attribution; the multi-session false-positive cost is only an extra
    // timeout granted by the host (direction-safe).
    this.probe.onShellCreateBefore((input) => {
      if (this.options.timeoutWrap && input.timeout === 0 && this.activeGoalSessions.size > 0) {
        input.timeout = this.options.checkInDelaySec * 1000;
      }
      this.rememberShellTimeout(input.command, input.cwd, input.timeout);
    });

    // Task 11: compaction-proof goal state (spec §10).
    // 2026-10-17 ruling: the plugin writes NO system part at all — the
    // "context" session hook (per-turn [GOAL] objective block) was REMOVED:
    // any write to the system part, even a byte-stable one, shifts the
    // request prefix at appearance/disappearance and breaks the LLM prefix
    // cache. Goal grounding rides the tail channels only (wake message +
    // goal-creation message + the compaction block below).
    //
    // compaction hook — take over the compaction summary:
    // SessionCompaction.result is a WHOLE REPLACEMENT that skips the host
    // model request (session.d.ts), so the summary carries the conversation
    // history (probe.generate) + a mandatory trailing [GOAL STATE] block.
    // The callback returns its async work (narrow `=> void` registration
    // signature is assignable; tests await it) and never throws
    // (fault-tolerance discipline).
    this.probe.onSessionHook("compaction", (sessionID, payload) => this.compactionHook(sessionID, payload));

    // Task 12: permission sandbox — the goal.control self-grant + path
    // containment, expressed on the host permission surface (R9 contract).
    this.probe.onPermissionHook((input) => this.permissionHook(input));

    // (2026-10-17: restart reconciliation removed — the watchdog no longer
    // fact-checks shells; a goal with waiting shells survives the restart as
    // a persisted fact, and the host's own restart sweep resumes the session,
    // whose next boundary re-arms the background gate.)

    // Task 8: single event loop (boundary arbiter + wake loop) over
    // probe.eventSubscribe() — spec §6 arbitration, §11 budget,
    // §15-9 blocked resume. One consumer per controller instance.
    this.stopped = false;
    this.loopIter = this.probe.eventSubscribe()[Symbol.asyncIterator]();
    this.loopPromise = this.runLoop(this.loopIter);
    return slot.stop;
  }

  /**
   * Bounded, idempotent instance stop — the live-slot `stop` and the
   * host-unload cleanup both route here. Safe at ANY point in start():
   * pre-arming (no loop to tear down), armed (loop teardown), or repeated
   * (memoized). Deregisters only while this instance still OWNS the slot —
   * a displaced instance's late stop must not remove the successor's claim.
   */
  private stopInstance(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = (async () => {
      this.stopped = true;
      // stop EVERYTHING — all per-goal watchdog timers and pending tick work
      // (test/watchdog.test.ts #10).
      for (const timer of this.wdTimers.values()) clearInterval(timer);
      this.wdTimers.clear();
      this.wdBusy.clear();
      this.checkinDue.clear();
      this.activeSessions.clear();
      const iter = this.loopIter;
      this.loopIter = undefined;
      try {
        await iter?.return?.();
      } catch {
        // stream already closed
      }
      const p = this.loopPromise;
      this.loopPromise = undefined;
      try {
        await p;
      } catch {
        // runLoop swallows per-event failures (fault-tolerance discipline)
      }
      const holder = liveSlotHolder();
      if (holder.slot === this.liveSlotRef) holder.slot = undefined;
    })();
    return this.stopping;
  }

  // ------------------------------------------------------------------
  // Task 8 + 9: event loop + arbitration (mechanical checks only; the judge
  // call is the sole exception, with inline verdict disposition — Task 9)
  // ------------------------------------------------------------------

  private async runLoop(iter: AsyncIterator<HostEvent>): Promise<void> {
    for (;;) {
      let result: IteratorResult<HostEvent>;
      try {
        result = await iter.next();
      } catch (err) {
        console.warn("opencode-goal: event stream errored, stopping wake loop:", err);
        return;
      }
      if (result.done || this.stopped) return;
      try {
        await this.handleEvent(result.value);
      } catch (err) {
        // Fault-tolerance discipline: a single event failure never breaks the loop.
        console.warn(
          `opencode-goal: failed to handle event ${result.value.type} (${result.value.id ?? "no id"}):`,
          err,
        );
      }
    }
  }

  private async handleEvent(event: HostEvent): Promise<void> {
    if (this.stopped) return; // displaced mid-flight: in-flight event no-ops
    const sessionID = event.properties?.sessionID;
    if (typeof sessionID !== "string" || sessionID === "") return; // 无归属：无 sessionID
    if (!(await this.sessionBelongs(sessionID))) return; // 无归属：非本实例 project
    // 2026-10-17 in-flight gate: per-session mid-turn tracking (every project
    // session, goal-independent — the gate counts in-flight sessions).
    if (event.type === "session.execution.started") {
      this.activeSessions.set(sessionID, Date.now());
    } else if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.idle"
    ) {
      this.activeSessions.delete(sessionID);
    }
    switch (event.type) {
      case "session.execution.started":
        await this.onExecutionStarted(sessionID);
        return;
      case "session.tool.called":
        await this.onToolCalled(sessionID);
        return;
      case "session.usage.updated":
        await this.onUsageUpdated(sessionID, event.properties);
        return;
      case "session.inbox.enqueued":
        await this.onInboxEnqueued(sessionID, event.properties);
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.idle":
        // session.idle is a valid terminal boundary (brief ruling): the
        // payload carries sessionID (schema/dist/event-manifest.d.ts:
        // session.idle data = { sessionID }, ephemeral) — not unreliable.
        await this.arbitrateBoundary(sessionID, event);
        return;
      case "session.execution.interrupted":
        await this.onInterrupted(sessionID, event);
        return;
      case "session.shell.started":
        // Task 10 watchdog: arm — the durable, session-scoped family carries
        // sessionID + full ShellInfo (schema/dist/session-event.d.ts).
        await this.onShellStarted(sessionID, event.properties);
        return;
      case "session.shell.ended":
        // Task 10 watchdog fast path: status ∈ running|exited|timeout|killed
        // (+ data.output tail) — a normal wake carrying the exit wording.
        await this.onShellEnded(sessionID, event.properties);
        return;
      case "shell.created":
        // TODO(task13): the ephemeral family (data = { info }, no sessionID in
        // 2.0.29 — schema/dist/shell.d.ts) never passes the session gate above;
        // handled here for a future host that adds session attribution.
        await this.onShellStarted(sessionID, event.properties);
        return;
      case "shell.exited":
        // TODO(task13): same as shell.created — data = { id, exit?, status }.
        await this.onShellEnded(sessionID, event.properties);
        return;
      default:
        // session.compaction.* (Task 11), session.inbox.delivered — not
        // consumed by this task.
        return;
    }
  }

  /** "非本实例 project" check: when the plugin knows its projectID, only
   *  sessions of that project are attributed (best-effort, fail-closed). */
  private async sessionBelongs(sessionID: string): Promise<boolean> {
    const pid = this.probe.projectID;
    if (pid === undefined) return true;
    try {
      const info = await this.probe.sessionGet(sessionID);
      return info?.projectID === pid;
    } catch {
      return false;
    }
  }

  private async onExecutionStarted(sessionID: string): Promise<void> {
    this.checkinDue.delete(sessionID); // a new turn is activity: cancel the progress check
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || goal.status !== "active") return;
    let t = this.turns.get(sessionID);
    if (t === undefined) {
      t = { active: false, toolCalled: false };
      this.turns.set(sessionID, t);
    }
    t.active = true;
    t.toolCalled = false;
    this.contPending.delete(sessionID); // 唤醒已落地 → 关闭 continuationPending 窗口
    this.pendingSkipped.delete(sessionID);
    // The session went active — stop the watchdog's tick for the whole goal
    // (止表). Any pending progress check was already cancelled at the top.
    this.disarmWatchdog(sessionID);
  }

  private async onToolCalled(sessionID: string): Promise<void> {
    // Only cancel while a turn is actually in flight: the host can emit the
    // just-ended turn's tool/usage events AFTER its terminal boundary (late
    // stragglers, 2026-10-17 verify incident — a late session.usage.updated
    // killed the freshly armed one-shot check-in and left the goal silent).
    if (this.turns.get(sessionID)?.active === true) this.checkinDue.delete(sessionID);
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || goal.status !== "active") return;
    const t = this.turns.get(sessionID);
    if (t !== undefined && t.active) t.toolCalled = true;
  }

  /** spec §11: used.tokens = the CUMULATIVE value from the event (direct
   *  assignment, never accumulated). .d.ts (session-event.d.ts UsageUpdated):
   *  data.tokens = { input, output, reasoning, cache: { read, write } } —
   *  the total sums all five fields (token-usage.d.ts `total` semantics). */
  private async onUsageUpdated(sessionID: string, props: Record<string, unknown>): Promise<void> {
    // Only cancel while a turn is actually in flight (late straggler events —
    // usage reported after the turn's terminal boundary — are not activity;
    // see onToolCalled).
    if (this.turns.get(sessionID)?.active === true) this.checkinDue.delete(sessionID);
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || isTerminal(goal.status)) return;
    const tokens = props.tokens;
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return;
    const t = tokens as Record<string, unknown>;
    const cache = (typeof t.cache === "object" && t.cache !== null && !Array.isArray(t.cache)
      ? t.cache
      : {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const total = num(t.input) + num(t.output) + num(t.reasoning) + num(cache.read) + num(cache.write);
    goal.used.tokens = total;
    await this.saveGoal(goal);
  }

  private async onInboxEnqueued(sessionID: string, props: Record<string, unknown>): Promise<void> {
    this.checkinDue.delete(sessionID); // a new inbox item is activity: cancel the progress check
    // .d.ts (session-event.d.ts InboxEnqueued): data = { item: { type,
    // payload, delivery }, inboxID, sessionID }.
    const inboxID = typeof props.inboxID === "string" ? props.inboxID : undefined;
    const item = props.item as Record<string, unknown> | undefined;
    if (inboxID === undefined || typeof item !== "object" || item === null || Array.isArray(item)) return;
    const itemType = typeof item.type === "string" ? item.type : undefined;
    const payload = (typeof item.payload === "object" && item.payload !== null && !Array.isArray(item.payload)
      ? item.payload
      : {}) as Record<string, unknown>;
    const isControl =
      itemType === "synthetic" &&
      typeof payload.metadata === "object" &&
      payload.metadata !== null &&
      !Array.isArray(payload.metadata) &&
      (payload.metadata as Record<string, unknown>).goalControl === true;

    let entry: LastInboxEntry;
    if (isControl) {
      entry = { id: inboxID, kind: "control" };
    } else if (itemType === "user") {
      // The host also emits enqueued for items WE enqueued via prompt();
      // reclassify our own wake by its inbox id (the watchdog flag rides
      // along — the Task 10 fast path needs it).
      const wake = this.wakeInbox.get(sessionID);
      if (wake !== undefined && wake.inboxID === inboxID) {
        const reentry: LastInboxEntry = { id: inboxID, kind: "wake", goalID: wake.goalID };
        if (wake.watchdog === true) reentry.watchdog = true;
        entry = reentry;
      } else {
        entry = { id: inboxID, kind: "user" };
      }
    } else {
      // compaction / move / unmarked synthetic — TODO(task13): pinned in
      // test/arbiter.test.ts (counts toward the stall ladder via "other").
      entry = { id: inboxID, kind: "other" };
    }
    this.lastInbox.set(sessionID, entry);

    // spec §15-9 blocked resume: blocked goal + user inbox item → active.
    if (itemType === "user") {
      const goal = await this.loadGoal(sessionID);
      if (goal !== undefined && goal.status === "blocked" && !this.resumeInbox.has(inboxID)) {
        this.resumeInbox.add(inboxID);
        if (this.resumeInbox.size > 100) {
          const first = this.resumeInbox.values().next().value;
          if (first !== undefined) this.resumeInbox.delete(first);
        }
        goal.status = "active";
        goal.stalls = 0;
        // 2026-10-18 (129 incident): a resumed goal must not keep carrying
        // its stale blocker — the record read as "still blocked" in
        // /goal view and to the model's own context. The reason lives on
        // in the transcript (the block synthetic), not in the live record.
        goal.blocker = undefined;
        // injectWake bumps used.turns / continuations in memory; the save
        // below persists everything (status, stalls, usage) in one write.
        await this.injectWake(goal);
        await this.saveGoal(goal);
      }
    }
  }

  /**
   * Interrupt three-way (brief §3; .d.ts reason literals: user | shutdown |
   * superseded | inactivity):
   * - inactivity → the mechanical form of a silent stall: ordinary boundary (wake);
   * - user (人工喊停) → record the eventID only (save), no wake;
   * - shutdown → record only (lastHandledEventID, no other state change).
   * - "superseded" is a 4th .d.ts value the brief does not cover → treated
   *   record-only like "user". TODO(task13).
   */
  private async onInterrupted(sessionID: string, event: HostEvent): Promise<void> {
    const props = event.properties;
    const reason = typeof props.reason === "string" ? props.reason : undefined;
    if (reason === "inactivity") {
      await this.arbitrateBoundary(sessionID, event);
      return;
    }
    const eventID = typeof event.id === "string" ? event.id : undefined;
    const goal = await this.loadGoal(sessionID);
    await this.recordHandled(sessionID, eventID, goal);
  }

  /**
   * Record a consumed eventID: memory dedup Set + persisted
   * lastHandledEventID (best-effort save; a failed save never re-wakes —
   * the in-memory Set already marks it handled). `sessionID` is part of
   * the call-site contract; the storage key derives from goal.sessionID.
   */
  private async recordHandled(sessionID: string, eventID: string | undefined, goal?: GoalRecord): Promise<void> {
    void sessionID;
    this.rememberHandled(eventID);
    if (goal !== undefined && eventID !== undefined) {
      goal.lastHandledEventID = eventID;
      await this.saveGoal(goal);
    }
  }

  /**
   * Terminal-boundary arbitration (spec §6, mechanical in order):
   * ① dedup (memory Set + persisted lastHandledEventID + continuationPending
   *    window) → ② active goal? → ④ budget (spec §11) → ⑤ attribution →
   *    stall ladder → ⑥ judge (spec §8): once per goal (judgeUsed gate);
   *    the verdict is disposed inline (continue re-wakes with the optional
   *    instruction; complete / needs_human / give_up end the goal).
   */
  /** In-flight signal for the gate (2026-10-17 shell-store ruling, HTTP data
   * plane): the goal session's OWN running shells, queried live from the
   * host shell store (location-scoped, running-only), plus every OTHER
   * in-flight session of this project (subtask sessions: names and parent
   * links are neither known nor needed — count only).
   * Why the store and not the session.shell.* events: the host does not emit
   * those events for MODEL-ORIGINATED background shells (root cause #12138) —
   * the event-driven waitingShells count is blind to exactly the case that
   * motivated the gate. The store is the host's own truth: stateless
   * (self-heals across plugin reloads) and self-pruning (exited shells vanish).
   * Query failure = the host context is dead (2026-10-17 ruling): ownKnown
   * false, NO fake count — the caller logs and skips; reviving a dead
   * session is not the plugin's job. warn-once per session. */
  private async inFlightSignal(sessionID: string): Promise<{ own: number; other: number; ownKnown: boolean }> {
    let own = 0;
    let ownKnown = true;
    try {
      const info = await this.probe.sessionGet(sessionID);
      const directory = info?.location?.directory;
      if (directory !== undefined) {
        own = (await this.probe.shellList(directory)).filter(
          (e) => e.sessionID === sessionID && e.status === "running",
        ).length;
      }
      this.shellQueryWarned.delete(sessionID); // a success re-arms the warn
    } catch (err) {
      ownKnown = false;
      if (!this.shellQueryWarned.has(sessionID)) {
        this.shellQueryWarned.add(sessionID);
        console.warn(
          `opencode-goal: shell store query failed for ${sessionID}; the host context is dead — skipping this boundary:`,
          err,
        );
      }
    }
    let other = 0;
    if (ownKnown) {
      for (const sid of this.activeSessions.keys()) {
        // 2026-10-18 (amended ruling, 129 incident): count ONLY sessions
        // whose host parentID chain leads back to THIS session — its
        // subtasks. A foreign session (a different task — e.g. the user's
        // interactive session) is invisible to the gate.
        if (sid !== sessionID && (await this.isSubtaskOf(sid, sessionID))) other += 1;
      }
    }
    return { own, other, ownKnown };
  }

  /**
   * 2026-10-18 (amended): does `sid` belong to `root`'s subtask tree — i.e.
   * does its host session record's parentID chain (Session.Info.parentID)
   * walk back to `root`? Different sessions are different tasks; only this
   * session's own subtasks count as its in-flight background work.
   * Fail-OPEN: a dead/unreadable session record is NOT a subtask (a
   * stranger must never hold the loop). Bounded walk (subagent depth is
   * small; 8 hops far exceeds any nesting).
   */
  private async isSubtaskOf(sid: string, root: string): Promise<boolean> {
    let cur = sid;
    for (let hop = 0; hop < 8; hop++) {
      let info: { parentID?: string } | undefined;
      try {
        info = (await this.probe.sessionGet(cur)) as { parentID?: string } | undefined;
      } catch {
        return false;
      }
      if (info?.parentID === root) return true;
      if (info?.parentID === undefined) return false;
      cur = info.parentID;
    }
    return false;
  }

  private async arbitrateBoundary(sessionID: string, event: HostEvent): Promise<void> {
    const eventID = typeof event.id === "string" ? event.id : undefined;
    // ① dedup: already handled (memory, bounded) or persisted as handled.
    if (eventID !== undefined && this.handledIDs.has(eventID)) return;
    const goal = await this.loadGoal(sessionID);
    if (goal !== undefined && eventID !== undefined && goal.lastHandledEventID === eventID) return;
    const armedAt = this.contPending.get(sessionID);
    if (armedAt !== undefined) {
      if (Date.now() - armedAt > this.contWindowMs()) {
        // Window expired: the wake turn's execution.started never arrived
        // (lost in the host event stream) — so this boundary is NOT a
        // same-turn-end sibling but the wake turn's real terminal. Close the
        // window and arbitrate normally: a single lost event must not leave
        // the goal dormant for good (2026-10-17 129 incident — while the
        // session is dormant NO second boundary ever arrives, so the
        // bounded skip became unbounded silence until a human woke the
        // session manually).
        this.contPending.delete(sessionID);
        this.pendingSkipped.delete(sessionID);
      } else {
        // continuationPending window (fresh): the wake has not landed (no
        // execution.started yet). Within the window the first boundary is a
        // same-turn-end sibling (execution.succeeded → session.idle, ms
        // apart). Bounded fallback (controller ruling I1): skip at most ONE,
        // a second DISTINCT boundary closes the window. Bounded skip is
        // preferred over permanent silence; the residual double-wake risk is
        // acceptable because wakes are ordinary state-carrying messages.
        const skipped = this.pendingSkipped.get(sessionID);
        if (skipped === undefined) {
          // First boundary inside the window → skip it (recorded in the
          // decision log for visibility — the 129 incident was invisible
          // precisely because skips left no line) and remember it so a
          // second DISTINCT boundary can close the window.
          if (eventID !== undefined) this.pendingSkipped.set(sessionID, eventID);
          else this.pendingSkipped.set(sessionID, "");
          if (goal !== undefined && goal.status === "active") {
            await appendDecision({
              ts: new Date().toISOString(),
              sessionID,
              goalID: goal.id,
              own: 0,
              other: 0,
              ownKnown: false,
              decision: "skip",
              reason: "continuationPending window (sibling boundary)",
            });
          }
          this.markTurnInactive(sessionID);
          await this.recordHandled(sessionID, eventID, goal);
          return;
        }
        if (eventID === skipped) {
          // Replay of the skipped boundary (dedup-equivalent) → keep ignoring.
          await this.recordHandled(sessionID, eventID, goal);
          return;
        }
        // Second distinct boundary → close the window and fall through to
        // normal arbitration below (this boundary proceeds).
        this.contPending.delete(sessionID);
        this.pendingSkipped.delete(sessionID);
      }
    }
    if (goal === undefined || goal.status !== "active") {
      // ② no active goal → ignore (no storage write when there is no goal;
      // a terminal goal is only recorded, never woken).
      this.markTurnInactive(sessionID);
      await this.recordHandled(sessionID, eventID, goal);
      return;
    }
    // ④ budget (spec §11): ANY terminal boundary (incl. inactivity interrupt)
    // checks the caps BEFORE attribution; missing cap dimensions don't compare.
    if (isCapReached(goal)) {
      goal.status = "budget_limited";
      this.judgeInstruction.delete(sessionID); // terminal: drop any pending judge paragraph
      if (eventID !== undefined) goal.lastHandledEventID = eventID;
      await this.saveGoal(goal);
      await this.archiveGoal(goal);
      try {
        await this.probe.synthetic({
          sessionID,
          text: `goal ${goal.id} stopped: budget_limited (used ${goal.used.turns} turns / ` +
            `${goal.used.tokens} tokens; cap: ${this.capText(goal)})`,
          metadata: { goalControl: true },
        });
      } catch (err) {
        console.warn(`opencode-goal: failed to deliver budget_limited notice for goal ${goal.id}:`, err);
      }
      this.markTurnInactive(sessionID);
      this.rememberHandled(eventID);
      return;
    }
    // Provider failure pause (2026-10-17 ruling, 129 "Insufficient account
    // funds" incident): a boundary whose LAST assistant message carries a
    // provider.* error is NOT a model stop — the turn failed before the model
    // ran, and re-waking only burns another doomed request (user cheers kept
    // resetting the stall ladder, so the ladder never self-limited it).
    // Streak >= providerFailLimit → pause: no wake, no stall accounting, no
    // turn counting, ONE synthetic notice, watchdog retries after
    // providerPauseMs. A CLEAN boundary (model ran again) clears the streak
    // and pause and resumes normal arbitration.
    const errored = await this.lastAssistantProviderError(sessionID);
    if (errored) {
      const streak = (this.providerFailStreak.get(sessionID) ?? 0) + 1;
      this.providerFailStreak.set(sessionID, streak);
      const pause = goal.providerPause;
      if (streak >= this.options.providerFailLimit || (pause !== undefined && Date.now() >= pause.until)) {
        const noticeSent = pause?.noticeSent ?? false;
        const minutes = Math.round(this.options.providerPauseMs / 60000);
        goal.providerPause = { until: Date.now() + this.options.providerPauseMs, noticeSent };
        await appendDecision({
          ts: new Date().toISOString(),
          sessionID,
          goalID: goal.id,
          own: 0,
          other: 0,
          ownKnown: true,
          decision: "skip",
          reason: `provider failure streak ${streak} — paused ${minutes}m`,
        });
        if (!noticeSent) {
          try {
            await this.probe.synthetic({
              sessionID,
              text: providerPauseNoticeText(goal.id, minutes),
              metadata: { goalControl: true },
            });
            goal.providerPause!.noticeSent = true; // one per INCIDENT (a re-arm must not re-notify)
          } catch (err) {
            console.warn(`opencode-goal: failed to deliver provider-pause notice for goal ${goal.id}:`, err);
          }
        }
        this.ensureWatchdog(sessionID); // the tick is the retry deadline's heartbeat
        this.markTurnInactive(sessionID);
        await this.recordHandled(sessionID, eventID, goal);
        await this.saveGoal(goal);
        return;
      }
      // Streak below the limit (no active pause): one more wake attempt
      // (transient-hiccup tolerance) — but the doomed turn does not consume
      // the turn budget (countTurn=false at the wake injection below).
    } else {
      this.providerFailStreak.delete(sessionID);
      if (goal.providerPause !== undefined) {
        goal.providerPause = undefined; // the model ran again — resume the loop
        await this.saveGoal(goal);
      }
    }
    // Background in-flight gate (2026-10-17 ruling, 2026-10-18 amendment): a
    // terminal boundary with this session's background work in flight — its
    // OWN running shells (host shell store, shell.list) or its SUBTASK
    // sessions (attributed via the host parentID chain) — does NOT inject
    // the ordinary wake; the session is already "waiting". The boundary's
    // entire action: arm the one-shot progress check (checkInDelaySec of
    // silence, fired by the watchdog tick).
    //
    // 2026-10-18 amended ruling (129 incident): in-flight = this session's
    // OWN running shells + its SUBTASK sessions (attributed via the host's
    // parentID chain, see inFlightSignal/isSubtaskOf). Foreign sessions —
    // different tasks (the user's interactive session, a separate campaign)
    // — NEVER gate this goal's loop, and never appear in the check-in
    // count (no more fake "background items in flight"). Two exceptions keep normal
    // arbitration: (a) the last inbox item is one of OUR watchdog wakes —
    // spec §7.1: a check-in replied with pure text counts per the stall
    // ladder; (b) goal_wait's waitUntil window silences EVERYTHING
    // (record only: no wake, no arm, no stall accounting — "不消耗 stall 预算").
    const { own, other, ownKnown } = await this.inFlightSignal(sessionID);
    // Gate = own running shells + attributed subtask sessions (2026-10-18
    // amended ruling); `other` in the decision log carries the same value.
    const inFlight = own + other;
    if (!ownKnown) {
      // Query failure = the host context is dead (2026-10-17 ruling): log +
      // skip — no wake, no check-in arm, no stall accounting. Reviving a dead
      // session is not the plugin's job; the human reads the log.
      await appendDecision({
        ts: new Date().toISOString(),
        sessionID,
        goalID: goal.id,
        own: 0,
        other: 0,
        ownKnown: false,
        decision: "skip",
        reason: "shell signal unavailable (host context dead)",
      });
      this.markTurnInactive(sessionID);
      await this.recordHandled(sessionID, eventID, goal);
      return;
    }
    if (inFlight > 0) {
      // An ACTIVE provider pause silences the progress check like goal_wait's
      // waitUntil window (a check-in wake during either is a doomed turn).
      const pauseActive = goal.providerPause !== undefined && Date.now() < goal.providerPause.until;
      const quiet = (goal.waitUntil !== undefined && Date.now() < goal.waitUntil) || pauseActive;
      const last = this.lastInbox.get(sessionID);
      const lastWatchdog = last !== undefined && last.kind === "wake" && last.watchdog === true;
      if (quiet || !lastWatchdog) {
        if (!quiet) {
          // Not quiet: arm the one-shot progress check. The clock only runs
          // while the session is quiet — any activity cancels it, and the next
          // in-flight boundary re-arms (fresh countdown).
          this.checkinDue.set(sessionID, {
            due: Date.now() + this.options.checkInDelaySec * 1000,
            inFlight,
          });
          this.ensureWatchdog(sessionID); // the tick is the deadline's heartbeat
        }
        await appendDecision({
          ts: new Date().toISOString(),
          sessionID,
          goalID: goal.id,
          own,
          other,
          ownKnown: true,
          decision: "hold",
          reason: quiet ? "in-flight, quiet window" : "in-flight (check-in armed)",
        });
        this.markTurnInactive(sessionID);
        await this.recordHandled(sessionID, eventID, goal);
        return;
      }
      // (a) reply to OUR watchdog wake: normal arbitration (stall ladder).
    }
    // ⑤ attribution (lastInbox) → stall ladder.
    const toolCalled = this.turns.get(sessionID)?.toolCalled === true;
    const last = this.lastInbox.get(sessionID);
    let wake = true;
    let stalls: number;
    if (toolCalled) {
      stalls = 0; // acted this turn
    } else if (last !== undefined && last.kind === "control") {
      // This plugin's control notification (e.g. a /goal command): record
      // only — no wake (防自触发双唤醒).
      wake = false;
      stalls = goal.stalls;
    } else if (last !== undefined && last.kind === "user") {
      stalls = 0; // person present is not a stall
    } else {
      // wake-originated (ours, goalID match or mismatch) or other/untracked
      // (compaction/move/unmarked synthetic): no action, no user → stall.
      stalls = goal.stalls + 1;
    }
    goal.stalls = stalls;
    // ⑥ stall ladder (Task 9): at the threshold the side-channel judge
    // arbitrates — at most ONCE per goal (persistent gate `judgeUsed`;
    // options.judgeMaxPerGoal is still resolved but the behavior is spec-
    // fixed to one, to prevent a judge/agent mutual-kick loop). Every path
    // here either ends the goal (stallReport + archive + synthetic) or
    // re-wakes with the judge's optional instruction.
    if (wake && goal.stalls >= this.options.stallLimit) {
      this.markTurnInactive(sessionID);
      const texts = await this.noActionTexts(sessionID);
      const judge = this.deps.judge;
      if (this.options.judgeEnabled && goal.judgeUsed !== true && judge !== undefined) {
        let verdict: JudgeVerdict;
        try {
          verdict = await judge.judge(goal, texts);
        } catch (err) {
          // Controller ruling: a REJECTING judge = give_up semantics
          // (stalled), fail-closed; the loop must never break.
          console.warn(`opencode-goal: judge failed for goal ${goal.id}:`, err);
          await this.stallGoal(sessionID, goal, texts, "Judge call failed (fail-closed: treated as give_up)");
          return;
        }
        await this.disposeVerdict(sessionID, goal, texts, verdict);
        return;
      }
      // Judge unavailable at the limit (disabled / already used / not wired)
      // → directly stalled, with the report saying why the judge did not rule.
      await this.stallGoal(
        sessionID,
        goal,
        texts,
        !this.options.judgeEnabled
          ? "Judge not enabled (judgeEnabled=false)"
          : goal.judgeUsed === true
            ? "Judge already used (at most once per goal, no re-review)"
            : "Judge not wired",
      );
      return;
    }
    if (wake) {
      await appendDecision({
        ts: new Date().toISOString(),
        sessionID,
        goalID: goal.id,
        own,
        other,
        ownKnown: true,
        decision: "wake",
        reason: `boundary (in-flight ${own + other})`,
      });
      // A provider-errored boundary wakes without counting the doomed turn.
      await this.injectWake(goal, !errored);
    }
    this.markTurnInactive(sessionID);
    // Regression fix (Task 9 brief, Task 8 M4 extract lost this): the tail
    // ALWAYS persists this boundary's increments (used.turns / continuations
    // from injectWake, stalls) — unconditionally, even for id-less events.
    // lastHandledEventID is still set only when the event carries an id.
    if (eventID !== undefined) goal.lastHandledEventID = eventID;
    await this.saveGoal(goal);
  }

  /** Turn bookkeeping on a consumed terminal boundary: active=false, keep toolCalled. */
  private markTurnInactive(sessionID: string): void {
    const t = this.turns.get(sessionID);
    if (t !== undefined) t.active = false;
  }

  /**
   * Wake injection (spec §6-③): used.turns += 1, continuations += 1,
   * continuationPending = true, lastInbox = this wake (InboxRef.id).
   * Judge instruction channel (Task 9): a pending instruction (if any) rides
   * into THIS wake as the buildWakeMessage judge paragraph, then is dropped.
   * `countTurn = false` (provider-errored boundary): the wake is attempted but
   * the doomed turn does not consume the turn budget.
   */
  private async injectWake(goal: GoalRecord, countTurn = true): Promise<void> {
    const sessionID = goal.sessionID;
    if (countTurn) goal.used.turns += 1;
    goal.continuations += 1;
    let judgeInstruction: string | undefined;
    const pending = this.judgeInstruction.get(sessionID);
    if (pending !== undefined) {
      judgeInstruction = pending;
      this.judgeInstruction.delete(sessionID);
    }
    try {
      const ref = await this.probe.prompt({
        sessionID,
        // Task 14 Fix 3a: options.wakeText rides every buildWakeMessage wake
        // (boundary wake / judge-demoted wake). The background check-in wake
        // (runWatchdogTick, backgroundCheckInText) is an INDEPENDENT text
        // family and does NOT carry wakeText (ruling: wakeText does not
        // apply to check-ins).
        // options.wakeDetail selects the transcript footprint (2026-10-17:
        // default "slim" — objective/budget ride the per-turn system part).
        text: buildWakeMessage(
          goal,
          this.capText(goal),
          judgeInstruction,
          this.options.wakeText,
          this.options.wakeDetail,
        ),
        delivery: "queue",
        metadata: { goalWake: true, goalID: goal.id, goalTurn: goal.used.turns },
      });
      this.lastInbox.set(sessionID, { id: ref.id, kind: "wake", goalID: goal.id });
      this.wakeInbox.set(sessionID, { inboxID: ref.id, goalID: goal.id });
      this.contPending.set(sessionID, Date.now());
      this.pendingSkipped.delete(sessionID); // fresh window → fresh bounded skip
    } catch (err) {
      // Fault tolerance: a failed injection must not break the loop and must
      // not leave the continuationPending window open forever.
      console.warn(`opencode-goal: failed to inject wake for goal ${goal.id}:`, err);
      this.contPending.delete(sessionID);
    }
  }

  /**
   * noActionTexts for the judge (brief ⑥): from probe.context, find the LAST
   * user/synthetic message as the bound; take assistant text parts AFTER it;
   * no bound found → use all. At most the 3 most recent (reference project
   * executionTail rule).
   */
  private async noActionTexts(sessionID: string): Promise<string[]> {
    let messages: SessionMessage[];
    try {
      messages = await this.probe.context(sessionID);
    } catch {
      return [];
    }
    let cut = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const type = messages[i].type;
      if (type === "user" || type === "synthetic") {
        cut = i;
        break;
      }
    }
    const texts: string[] = [];
    for (let i = cut + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.type !== "assistant") continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
          const t = (part as { text: string }).text;
          if (t.length > 0) texts.push(t);
        }
      }
    }
    return texts.slice(-3);
  }

  /**
   * Provider-failure signal (2026-10-17, pinned on LIVE 129): the LAST
   * assistant message carries an error whose type contains "provider"
   * (129: { type: "provider.quota", message: "Upstream request failed:
   * Insufficient account funds" } — host schema Session.StructuredError
   * { type, message, status? }). Non-provider errors (ToolError / Interrupted
   * / ExecutionInterrupted / unknown) are normal operation and NEVER count.
   * A context query failure is NOT evidence of provider failure — fail open
   * (false): the loop degrades to the status-quo wake behavior, never to a
   * false pause.
   */
  private async lastAssistantProviderError(sessionID: string): Promise<boolean> {
    let messages: SessionMessage[];
    try {
      messages = await this.probe.context(sessionID);
    } catch {
      return false;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== "assistant") continue;
      const err = m.error;
      if (err === undefined || err === null) return false;
      const type = typeof err === "object" ? String((err as { type?: unknown }).type ?? "") : "";
      return type.toLowerCase().includes("provider");
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Task 11: compaction-proof goal state — compaction session hook ONLY
  // (the "context" hook was removed 2026-10-17: zero system-part writes —
  // see the registration comment in start())
  // ------------------------------------------------------------------

  /**
   * Compaction hook (spec §10 defense line 3): SessionCompaction.result is a
   * WHOLE REPLACEMENT that skips the host model request — so the summary must
   * carry the conversation, not just the state block. Steps (brief):
   * 1. probe.context first (history BEFORE any generate — the summary must
   *    not lose the conversation);
   * 2. probe.generate with the compaction prompt (history key points + the
   *    full state block);
   * 3. payload.result = { summary: generated text + mandatory trailing
   *    [GOAL STATE] block };
   * 4. generate failure → do NOT set result (the host's default compaction
   *    runs — fail-safe). context fetch failure → same (no history, no
   *    summary). No active goal → no-op. The hook never throws.
   */
  private async compactionHook(sessionID: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const goal = await this.loadGoal(sessionID);
      if (goal === undefined || goal.status !== "active") return;
      let messages: SessionMessage[];
      try {
        messages = await this.probe.context(sessionID);
      } catch (err) {
        // No history available → the host's default compaction (which keeps
        // the conversation) is strictly better than a state-only summary.
        console.warn(`opencode-goal: compaction context fetch failed for ${sessionID}; keeping host default compaction:`, err);
        return;
      }
      let generated: string;
      try {
        const res = await this.probe.generate({
          sessionID,
          prompt: buildCompactionPrompt(goal, this.compactionHistory(messages)),
        });
        generated = res.text;
      } catch (err) {
        console.warn(`opencode-goal: compaction summary generation failed for ${sessionID}; keeping host default compaction:`, err);
        return;
      }
      if (typeof generated !== "string") {
        // Same stance as the judge's fail-closed generator guard: a
        // non-string generation is not a summary — no half-baked result.
        console.warn(`opencode-goal: compaction generate returned non-string text for ${sessionID}; keeping host default compaction`);
        return;
      }
      if (generated.trim() === "") {
        // Empty/whitespace generation is NOT a summary: setting result would
        // produce a state-only summary AND make the host skip its default
        // compaction — the conversation would be LOST. Fail-safe: keep the
        // host default (it keeps the conversation).
        console.warn(`opencode-goal: compaction generate returned empty text for ${sessionID}; keeping host default compaction`);
        return;
      }
      payload.result = { summary: composeCompactionSummary(generated, goal, this.capText(goal)) };
    } catch (err) {
      console.warn(`opencode-goal: compaction hook failed for ${sessionID}; keeping host default compaction:`, err);
    }
  }

  /**
   * SessionMessage[] → { role, text } key points for the compaction prompt:
   * role = the message type tag; text = `text` verbatim when present, else
   * the text parts of `content` joined. Messages without extractable text
   * are dropped (they carry no conversation facts to summarize).
   */
  private compactionHistory(messages: SessionMessage[]): Array<{ role: string; text: string }> {
    const out: Array<{ role: string; text: string }> = [];
    for (const m of messages) {
      const role = typeof m.type === "string" ? m.type : "unknown";
      let text = "";
      if (typeof m.text === "string") {
        text = m.text;
      } else if (Array.isArray(m.content)) {
        const parts: string[] = [];
        for (const part of m.content) {
          if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
            const t = (part as { text: string }).text;
            if (t.length > 0) parts.push(t);
          }
        }
        text = parts.join(" ");
      }
      if (text.length > 0) out.push({ role, text });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Task 12: permission sandbox — goal.control self-grant + path containment
  // ------------------------------------------------------------------

  /**
   * Permission callback (registration surface; hot path — the goal + session
   * facts are LOOKED UP on every call, never cached, to avoid stale state).
   * Wiring order (all mechanical, brief-verbatim):
   * ① incoming === "deny" → no stance (never relax; decidePermission carries
   *    the same rule — belt and braces);
   * ② no sessionID → no stance (unattributable, fail-closed);
   * ③ attribution: probe.projectID set AND the session's projectID is a
   *    DIFFERENT known value → no stance (multi-location safety; an unknown
   *    projectID is attributed — the host may simply not report it);
   * ④ goalActive is OUR fact (storage lookup), never host input (R9);
   * ⑤ decidePermission (Task 3 pure logic, untouched): sessionDirectory
   *    prefers the per-session location.directory, falls back to the
   *    instance default probe.locationDirectory;
   * ⑥ leave → undefined (no stance); allow/deny → the decision (message?
   *    copied only when present).
   * try/catch over the whole body: ANY failure → undefined (no stance) +
   * warn — the permission path must never break the host.
   */
  private async permissionHook(input: PermissionHookInput): Promise<PermissionDecision | undefined> {
    try {
      if (input.incoming === "deny") return undefined;
      const sessionID = input.sessionID;
      if (sessionID === undefined) return undefined;
      const session = await this.probe.sessionGet(sessionID);
      const pid = this.probe.projectID;
      if (pid !== undefined && session?.projectID !== undefined && session.projectID !== pid) {
        return undefined; // another project's session — no stance
      }
      const goal = await this.loadGoal(sessionID);
      const goalActive = goal !== undefined && goal.status === "active";
      const decision = decidePermission({
        action: input.action,
        resources: input.resources,
        sessionDirectory: session?.location?.directory ?? this.probe.locationDirectory,
        goalActive,
        incoming: input.incoming,
      });
      if (decision.effect === "leave") return undefined;
      const out: PermissionDecision = { effect: decision.effect };
      if (decision.message !== undefined) out.message = decision.message;
      return out;
    } catch (err) {
      console.warn("opencode-goal: permission hook failed (no stance):", err);
      return undefined;
    }
  }

  // ------------------------------------------------------------------
  // Task 9: judge verdict disposition (spec §8)
  // ------------------------------------------------------------------

  /**
   * Inline disposition of the judge's verdict (replaces the Task 8
   * `pendingJudge` stash — the stash field is gone). The gate `judgeUsed`
   * closes on EVERY verdict: spec §8 fixes one judge per goal (the
   * options.judgeMaxPerGoal option stays resolved, behavior follows
   * judgeUsed). Terminal paths reuse the Task 7 finishGoal flow
   * (save + archive); every notification is best-effort.
   *
   * - continue    → stalls zeroed; optional instruction parked for the wake
   * - complete    → evidence must pass validateEvidence against the LIVE
   *                 transcript; ungrounded/weak evidence is DEMOTED to
   *                 continue (stalls zeroed, judgeUsed set, never completed)
   * - needs_human → blocked with the judge's reason; the Task 8 user-inbox
   *                 resume path (§15-9) then re-activates it (no new wiring)
   * - give_up     → stalled + stallReport + archive + synthetic
   */
  private async disposeVerdict(
    sessionID: string,
    goal: GoalRecord,
    noActionTexts: string[],
    verdict: JudgeVerdict,
  ): Promise<void> {
    goal.judgeUsed = true;
    switch (verdict.verdict) {
      case "continue":
        goal.stalls = 0;
        if (verdict.instruction !== undefined) {
          this.judgeInstruction.set(sessionID, verdict.instruction);
        }
        await this.saveGoal(goal);
        await this.injectWake(goal); // carries the judge paragraph (if any)
        return;
      case "complete": {
        const transcript = await this.transcript(sessionID);
        const problem =
          verdict.evidence !== undefined
            ? validateEvidence(verdict.evidence, transcript)
            : "Goal NOT completed: the judge's complete verdict carries no evidence";
        if (problem !== undefined) {
          // Demote to continue: an uncheckable evidence claim never completes
          // the goal (fail-closed). This verdict has no instruction → the
          // wake carries no judge paragraph (buildWakeMessage contract).
          goal.stalls = 0;
          await this.saveGoal(goal);
          await this.injectWake(goal);
          return;
        }
        const done = await this.finishGoal(goal, "completed", { evidence: verdict.evidence });
        // Task 14 Fix 1 (async face): a stale write was dropped — continue
        // SILENTLY. No archive (finishGoal already skipped it), no synthetic
        // claiming a terminal state, the loop just goes on (the loop must
        // never break, and no user-visible claim may assert a transition
        // storage never received).
        if (!done) {
          console.warn(`opencode-goal: judge "complete" verdict dropped for goal ${goal.id} (stale write)`);
          return;
        }
        await this.notify(goal, `goal ${goal.id} completed (judge): ${verdict.evidence}`);
        return;
      }
      case "needs_human": {
        const done = await this.finishGoal(goal, "blocked", { blocker: verdict.reason });
        if (!done) {
          console.warn(`opencode-goal: judge "needs_human" verdict dropped for goal ${goal.id} (stale write)`);
          return;
        }
        await this.notify(goal, `goal ${goal.id} blocked (judge: needs human): ${verdict.reason}`);
        return;
      }
      case "give_up":
        await this.stallGoal(sessionID, goal, noActionTexts, verdict.reason);
        return;
    }
  }

  /**
   * Terminal `stalled` (Task 9): the give_up verdict, a rejecting judge, or a
   * judge that cannot run (disabled / already used / not wired). Composes the
   * stallReport, archives, and delivers a goalControl synthetic carrying it.
   * `judgeReason` is the verdict's reason or a note on why the judge did not
   * rule.
   */
  private async stallGoal(
    sessionID: string,
    goal: GoalRecord,
    noActionTexts: string[],
    judgeReason: string,
  ): Promise<void> {
    goal.stallReport = buildStallReport(goal, noActionTexts, judgeReason);
    this.judgeInstruction.delete(sessionID);
    const done = await this.finishGoal(goal, "stalled");
    // Task 14 Fix 1 (async face): stale write dropped → silent continue
    // (no synthetic claiming the terminal state storage never received).
    if (!done) {
      console.warn(`opencode-goal: stall goal ${goal.id} dropped (stale write)`);
      return;
    }
    await this.notify(goal, `goal ${goal.id} stalled\n${goal.stallReport}`);
  }

  /** Best-effort goalControl synthetic (fault-tolerance discipline: never throw). */
  private async notify(goal: GoalRecord, text: string): Promise<void> {
    try {
      await this.probe.synthetic({
        sessionID: goal.sessionID,
        text,
        metadata: { goalControl: true },
      });
    } catch (err) {
      console.warn(`opencode-goal: failed to deliver goal ${goal.id} notice:`, err);
    }
  }

  // ------------------------------------------------------------------
  // Task 10: watchdog (spec §7.1) — per-goal tick, three-way decision per
  // shell, check-in dual signal, cancellation, restart reconciliation
  // ------------------------------------------------------------------

  /** Injectable tick (deps.tickMs = 1ms in tests) else the plugin option. */
  private tickMsValue(): number {
    return this.deps.tickMs ?? this.options.watchdogTickMs;
  }

  /** ContinuationPending window length (deps.contWindowMs in tests); default
   *  10s — sibling terminal events arrive within milliseconds, a wake turn
   *  takes seconds-to-minutes. */
  private contWindowMs(): number {
    return this.deps.contWindowMs ?? 10_000;
  }

  /**
   * (command, cwd) → host timeout from create.before (timeout > 0 only;
   * payload is mutable — we snapshot the value, we never read it back later).
   */
  private rememberShellTimeout(command: string, cwd: string, timeout: number): void {
    if (!(timeout > 0)) return;
    const key = `${command}\u0000${cwd}`;
    if (!this.shellTimeouts.has(key)) this.shellTimeoutOrder.push(key);
    this.shellTimeouts.set(key, timeout);
    while (this.shellTimeoutOrder.length > 200) {
      const old = this.shellTimeoutOrder.shift();
      if (old !== undefined) this.shellTimeouts.delete(old);
    }
  }

  /** Arm the per-goal tick timer (idempotent; refuses after cleanup). */
  private ensureWatchdog(sessionID: string): void {
    if (this.stopped || this.wdTimers.has(sessionID)) return;
    const timer = setInterval(() => this.watchdogTick(sessionID), this.tickMsValue());
    this.wdTimers.set(sessionID, timer);
  }

  /** Stop the goal's tick (the per-shell watch state SURVIVES re-arms). */
  private disarmWatchdog(sessionID: string): void {
    const timer = this.wdTimers.get(sessionID);
    if (timer !== undefined) {
      clearInterval(timer);
      this.wdTimers.delete(sessionID);
    }
  }

  /** One tick per armed goal: at most one in flight (overlap guard). */
  private watchdogTick(sessionID: string): void {
    if (this.wdBusy.has(sessionID)) return;
    this.wdBusy.add(sessionID);
    void this.runWatchdogTick(sessionID)
      .catch((err) => {
        // Fault-tolerance discipline: a failed tick never kills the timer.
        console.warn(`opencode-goal: watchdog tick failed for ${sessionID}:`, err);
      })
      .finally(() => this.wdBusy.delete(sessionID));
  }

  /**
   * Tick body (2026-10-17 ruling — zero active checks: the tick carries only
   * the one-shot progress check; shell liveness is EVENT-DRIVEN via
   * session.shell.started/ended, no probe):
   * 1. ghost rule: terminal/paused goal → clear the pending deadline + disarm;
   * 2. checkinDue deadline reached + session idle + not quiet → ONE progress
   *    reminder (consumed on fire; a missed deadline — active session or
   *    quiet window — stays pending and fires on the next qualifying tick);
   * 3. an EXPIRED provider pause → ONE retry wake (the retry's boundary
   *    resolves the pause: errored re-arms it, clean clears it);
   * 4. nothing pending (no waiting shells, no deadline, no unexpired pause)
   *    → disarm.
   */
  private async runWatchdogTick(sessionID: string): Promise<void> {
    if (this.stopped) return;
    const goal = await this.loadGoal(sessionID);
    // Ghost rule: terminal (or paused) goal → disarmed before anything else.
    if (goal === undefined || goal.status !== "active") {
      this.checkinDue.delete(sessionID);
      this.disarmWatchdog(sessionID);
      return;
    }
    const now = Date.now();
    const idle = this.turns.get(sessionID)?.active !== true; // Task 8 per-session active flag
    // An ACTIVE provider pause silences the progress check like the waitUntil
    // window (a check-in wake while the provider is down is a doomed turn).
    const pauseActive = goal.providerPause !== undefined && now < goal.providerPause.until;
    const quiet = (goal.waitUntil !== undefined && now < goal.waitUntil) || pauseActive;
    const due = this.checkinDue.get(sessionID);
    if (due !== undefined && now >= due.due && idle && !quiet) {
      this.checkinDue.delete(sessionID); // one-shot: consumed on fire
      await this.deliverWatchdogWake(
        goal,
        backgroundCheckInText(due.inFlight, this.options.checkInDelaySec),
      );
    }
    // Provider pause deadline reached → fire ONE retry wake. The pause record
    // is NOT cleared here: the retry's boundary is what resolves it (errored
    // → re-arm, clean → clear), which is also what re-arms this watchdog.
    if (goal.providerPause !== undefined && now >= goal.providerPause.until) {
      await this.deliverWatchdogWake(goal, providerPauseRetryText(goal.id));
    }
    // Disarm only when nothing is pending: no shells, no deadline, and no
    // UNEXPIRED provider pause (while armed, this tick IS the retry heartbeat).
    if (
      (goal.waitingShells?.length ?? 0) === 0 &&
      this.checkinDue.get(sessionID) === undefined &&
      (goal.providerPause === undefined || now >= goal.providerPause.until)
    ) {
      this.disarmWatchdog(sessionID);
    }
  }

  /**
   * Watchdog wake (check-in / shell exit / lost — spec §7.1: every synthetic
   * wake carries { goalControl: true }). Mirrors injectWake's bookkeeping
   * (used/continuations, lastInbox + wakeInbox, continuationPending window —
   * "唤醒注入仍置 pending") with the watchdog flag so the boundary fast path
   * can keep normal arbitration for a reply to OUR wake.
   */
  private async deliverWatchdogWake(goal: GoalRecord, text: string): Promise<void> {
    // Task 14 Fix 3a note: this wake path (check-in / shell exit / lost) uses
    // its own watchdog text family — options.wakeText intentionally does NOT
    // apply here (ruling: check-in wakes are independent copy).
    const sessionID = goal.sessionID;
    goal.used.turns += 1;
    goal.continuations += 1;
    try {
      const ref = await this.probe.prompt({
        sessionID,
        text,
        delivery: "queue",
        metadata: { goalControl: true },
      });
      this.lastInbox.set(sessionID, { id: ref.id, kind: "wake", goalID: goal.id, watchdog: true });
      this.wakeInbox.set(sessionID, { inboxID: ref.id, goalID: goal.id, watchdog: true });
      this.contPending.set(sessionID, Date.now());
      this.pendingSkipped.delete(sessionID);
      await this.saveGoal(goal);
    } catch (err) {
      // Fault tolerance: a failed injection must not break the loop and must
      // not leave the continuationPending window open forever.
      console.warn(`opencode-goal: failed to deliver watchdog wake for goal ${goal.id}:`, err);
      this.contPending.delete(sessionID);
    }
  }

  /**
   * Arm on shell creation (spec §7.1): write the waitingShells entry
   * (timeoutMs correlated via command+cwd; since = segment start). Active
   * goal only (a terminal/paused goal is never armed — the ghost rule).
   * Pure event-driven: no tick — the exit arrives as a shell.ended event.
   */
  private async onShellStarted(sessionID: string, props: Record<string, unknown>): Promise<void> {
    this.checkinDue.delete(sessionID); // a background shell event is activity: cancel the progress check
    const shell = shellInfoFrom(props);
    if (shell === undefined) return;
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || goal.status !== "active") return;
    if ((goal.waitingShells ?? []).some((w) => w.id === shell.id)) return; // already armed (dedup)
    const timeoutMs =
      shell.command !== undefined && shell.cwd !== undefined
        ? this.shellTimeouts.get(`${shell.command}\u0000${shell.cwd}`)
        : undefined;
    const entry: NonNullable<GoalRecord["waitingShells"]>[number] = { id: shell.id, since: Date.now() };
    if (timeoutMs !== undefined) entry.timeoutMs = timeoutMs;
    goal.waitingShells = [...(goal.waitingShells ?? []), entry];
    await this.saveGoal(goal);
  }

  /**
   * Fast path exit (spec §7.1): the shell ended (event) →
   * 止表 + result wake carrying the status wording (timeout = "超时",
   * killed = "被杀", else "退出 (exit)") and the output tail. No-op when the
   * goal is not active (ghost) or the shell was never armed / already
   * processed (the waitingShells membership IS the once-only guard).
   */
  private async onShellEnded(sessionID: string, props: Record<string, unknown>): Promise<void> {
    this.checkinDue.delete(sessionID); // a background shell event is activity: cancel the progress check
    const shell = shellInfoFrom(props);
    if (shell === undefined) return;
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || goal.status !== "active") return; // ghost: no wake after terminal/paused
    const waiting = goal.waitingShells ?? [];
    if (!waiting.some((w) => w.id === shell.id)) return;
    goal.waitingShells = waiting.filter((w) => w.id !== shell.id);
    const out = isPlainObject(props.output) ? props.output : undefined;
    const tail = out !== undefined && typeof out.output === "string" ? out.output : undefined;
    const status: "exited" | "timeout" | "killed" =
      shell.status === "timeout" ? "timeout" : shell.status === "killed" ? "killed" : "exited";
    await this.saveGoal(goal);
    if (goal.waitingShells.length === 0) this.disarmWatchdog(sessionID);
    await this.deliverWatchdogWake(goal, shellExitText(shell.id, status, shell.exit, tail));
  }

  /** Bounded in-memory eventID dedup (FIFO at HANDLED_ID_LIMIT). */
  private rememberHandled(eventID: string | undefined): void {
    if (eventID === undefined) return;
    if (this.handledIDs.has(eventID)) return;
    this.handledIDs.add(eventID);
    this.handledOrder.push(eventID);
    while (this.handledOrder.length > HANDLED_ID_LIMIT) {
      const old = this.handledOrder.shift();
      if (old !== undefined) this.handledIDs.delete(old);
    }
  }

  /** Deep-copied read of the session's goal record (undefined when none). */
  async snapshot(sessionID: string): Promise<GoalRecord | undefined> {
    const raw = await this.probe.storageGet(goalStorageKey(sessionID));
    if (raw === undefined) return undefined;
    return structuredClone(raw as GoalRecord);
  }

  // ------------------------------------------------------------------
  // command surface
  // ------------------------------------------------------------------

  /**
   * One /goal command handler for all subcommands. Every failure becomes
   * synthetic feedback (with the goalControl marker) — never a throw.
   */
  private async handleCommand(sessionID: string, text: string): Promise<void> {
    let out: string;
    try {
      out = await this.dispatchCommand(sessionID, text);
    } catch (err) {
      out = `goal command failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      await this.probe.synthetic({
        sessionID,
        text: out,
        metadata: { goalControl: true },
      });
      // LastInbox attribution (spec §6-⑤): every goal command reply is a
      // goalControl synthetic. In the real host the session.inbox.enqueued
      // echo records it; the harness emits no echo for probe.synthetic, so
      // this plugin records its own delivery (controller ruling fallback).
      this.lastInbox.set(sessionID, { id: "control", kind: "control" });
    } catch (err) {
      // Best-effort delivery (fault-tolerance discipline).
      console.warn("opencode-goal: failed to deliver goal feedback:", err);
    }
  }

  private async dispatchCommand(sessionID: string, text: string): Promise<string> {
    let tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
    // Accept both the full "/goal set ..." form and the host-routed remainder
    // "set ..." (the host strips the command name before calling us).
    if (tokens[0] === "/goal" || tokens[0] === "goal") tokens = tokens.slice(1);
    if (tokens.length === 0) return USAGE;
    const [sub, ...rest] = tokens;
    switch (sub) {
      case "set":
        return this.cmdSet(sessionID, rest);
      case "view":
        return this.viewGoal(sessionID);
      case "pause":
        return this.pauseGoal(sessionID);
      case "resume":
        return this.resumeGoal(sessionID);
      case "complete":
        if (rest.length === 0) return "missing evidence: /goal complete <evidence>";
        return this.completeGoal(sessionID, rest.join(" "));
      case "block":
        if (rest.length === 0) return "missing reason: /goal block <reason>";
        return this.blockGoal(sessionID, rest.join(" "));
      case "clear":
        return this.clearGoalFromCommand(sessionID);
      case "history":
        return this.historyGoal(sessionID);
      case "task":
        return this.cmdTask(sessionID, rest);
      default:
        return `unknown goal subcommand: "${sub}" — ${USAGE}`;
    }
  }

  private async cmdSet(sessionID: string, tokens: string[]): Promise<string> {
    const objectiveParts: string[] = [];
    let turns: number | undefined;
    let tokenCap: number | undefined;
    let unbounded = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--turns") {
        const v = tokens[++i];
        if (v === undefined) return `--turns expects a positive integer value`;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return `--turns expects a positive integer (got "${v}")`;
        turns = n;
      } else if (t === "--tokens") {
        const v = tokens[++i];
        if (v === undefined) return `--tokens expects a positive integer value`;
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return `--tokens expects a positive integer (got "${v}")`;
        tokenCap = n;
      } else if (t === "--unbounded") {
        unbounded = true;
      } else if (t.startsWith("--")) {
        return `unknown flag "${t}" — expected --turns, --tokens or --unbounded`;
      } else {
        objectiveParts.push(t);
      }
    }
    const objective = objectiveParts.join(" ");
    if (objective === "") return "missing objective: /goal set <objective> [--turns N] [--tokens N] [--unbounded]";
    const cap: GoalRecord["cap"] = unbounded
      ? {}
      : {
          turns: turns ?? this.options.defaultCapTurns,
          tokens: tokenCap ?? this.options.defaultCapTokens,
        };
    return this.setGoal(sessionID, objective, cap);
  }

  private async cmdTask(sessionID: string, tokens: string[]): Promise<string> {
    if (tokens.length === 0) return "usage: /goal task add <title> | /goal task <n> <todo|doing|done>";
    const [first, ...rest] = tokens;
    if (first === "add") {
      const title = rest.join(" ");
      if (title === "") return "missing task title: /goal task add <title>";
      return this.taskAdd(sessionID, title);
    }
    if (rest.length !== 1 || !TASK_STATUSES.includes(rest[0] as GoalTaskStatus)) {
      return "usage: /goal task <n> <todo|doing|done>";
    }
    return this.taskUpdate(sessionID, first, rest[0] as GoalTaskStatus);
  }

  // ------------------------------------------------------------------
  // tool surface
  // ------------------------------------------------------------------

  /** Tool handler guard: any thrown error becomes a text reply, never a throw. */
  private async guarded(name: string, core: () => Promise<string>): Promise<string> {
    try {
      return await core();
    } catch (err) {
      return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async toolSet(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    if (typeof rec.objective !== "string" || rec.objective.trim() === "") {
      return 'goal_set: "objective" is required and must be a non-empty string';
    }
    let turns: number | undefined;
    if (rec.turns !== undefined) {
      if (typeof rec.turns !== "number" || !Number.isInteger(rec.turns) || rec.turns <= 0) {
        return `goal_set: "turns" must be a positive integer (got ${String(rec.turns)})`;
      }
      turns = rec.turns;
    }
    let tokenCap: number | undefined;
    if (rec.tokens !== undefined) {
      if (typeof rec.tokens !== "number" || !Number.isInteger(rec.tokens) || rec.tokens <= 0) {
        return `goal_set: "tokens" must be a positive integer (got ${String(rec.tokens)})`;
      }
      tokenCap = rec.tokens;
    }
    let unbounded = false;
    if (rec.unbounded !== undefined) {
      if (rec.unbounded !== true) {
        return `goal_set: "unbounded" must be true when present (got ${String(rec.unbounded)})`;
      }
      unbounded = true;
    }
    const cap: GoalRecord["cap"] = unbounded
      ? {}
      : {
          turns: turns ?? this.options.defaultCapTurns,
          tokens: tokenCap ?? this.options.defaultCapTokens,
        };
    return this.setGoal(sessionID, rec.objective, cap);
  }

  private async toolComplete(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    if (typeof rec.evidence !== "string" || rec.evidence.trim() === "") {
      return 'goal_complete: "evidence" is required and must be a non-empty string';
    }
    return this.completeGoal(sessionID, rec.evidence);
  }

  private async toolBlock(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    if (typeof rec.reason !== "string" || rec.reason.trim() === "") {
      return 'goal_block: "reason" is required and must be a non-empty string';
    }
    return this.blockGoal(sessionID, rec.reason);
  }

  private async toolClear(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    if (typeof rec.request !== "string" || rec.request.trim() === "") {
      return 'goal_clear: "request" is required and must be a non-empty string';
    }
    return this.clearGoalFromTool(sessionID, rec.request);
  }

  private async toolHistory(sessionID: string, _input: unknown): Promise<string> {
    // Takes no fields: any input (including garbage) is tolerated.
    return this.historyGoal(sessionID);
  }

  private async toolAddTask(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    if (typeof rec.title !== "string" || rec.title.trim() === "") {
      return 'goal_add_task: "title" is required and must be a non-empty string';
    }
    return this.taskAdd(sessionID, rec.title);
  }

  private async toolUpdateTask(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    const ref = rec.ref;
    if (typeof ref !== "string" && typeof ref !== "number") {
      return 'goal_update_task: "ref" is required (1-based index or task id)';
    }
    if (typeof rec.status !== "string" || !TASK_STATUSES.includes(rec.status as GoalTaskStatus)) {
      return `goal_update_task: invalid status "${String(rec.status)}" (expected todo|doing|done)`;
    }
    return this.taskUpdate(sessionID, String(ref), rec.status as GoalTaskStatus);
  }

  private async toolWait(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    const minutes = rec.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      return `goal_wait: "minutes" must be an integer between 1 and 60 (got ${String(minutes)})`;
    }
    return this.waitGoal(sessionID, minutes);
  }

  // ------------------------------------------------------------------
  // core actions (shared by commands and tools)
  // ------------------------------------------------------------------

  /**
   * Sessions holding an ACTIVE goal in THIS instance (Task 14 Fix 3b,
   * timeoutWrap): kept in sync at the two choke points — every read goes
   * through loadGoal (active hit → add) and every write through saveGoal
   * (status non-active → delete, active → add), so no path is missed.
   * Simplified ruling (controller): the timeoutWrap check is "this instance
   * has ANY active goal" — no per-shell session attribution (single active
   * goal is the main desktop scenario; a multi-session false positive only
   * gives the host an extra timeout — direction-safe).
   */
  private activeGoalSessions = new Set<string>();

  private async loadGoal(sessionID: string): Promise<GoalRecord | undefined> {
    const raw = await this.probe.storageGet(goalStorageKey(sessionID));
    if (raw === undefined) return undefined;
    const goal = raw as GoalRecord;
    if (goal.status === "active") this.activeGoalSessions.add(sessionID);
    return goal;
  }

  /**
   * Every save bumps updatedAt (Task 1 ruling). Storage write = best-effort.
   *
   * Task 14 Fix 1 (compare-and-set staleness guard): the judge await can span
   * a whole load→mutate→save sequence — if a newer record (e.g. a user
   * `/goal clear`/pause/supersede) landed in storage meanwhile, writing this
   * stale record back would RESURRECT an already-terminal goal. So the save
   * probes storage first: when the stored updatedAt is strictly NEWER than
   * this record's pre-bump load baseline, the write is dropped (no bump, no
   * storageSet) and false is returned. A storage read failure is treated as
   * "no current record" (ruling: storage faults don't block the write —
   * best-effort discipline).
   *
   * @returns true = written, false = dropped as stale.
   */
  private async saveGoal(goal: GoalRecord): Promise<boolean> {
    const base = goal.updatedAt; // load baseline (pre-bump; every bump happens here)
    let current: GoalRecord | undefined;
    try {
      const raw = await this.probe.storageGet(goalStorageKey(goal.sessionID));
      if (raw !== undefined) current = raw as GoalRecord;
    } catch (err) {
      // storage read fault: proceed with current=undefined (best-effort)
      current = undefined;
    }
    if (current !== undefined && current.updatedAt > base) {
      console.warn(
        `opencode-goal: stale write dropped for goal ${goal.id} ` +
          `(load baseline ${base}, storage now ${String(current.updatedAt)} — a newer record landed meanwhile)`,
      );
      return false;
    }
    goal.updatedAt = Date.now();
    try {
      await this.probe.storageSet(goalStorageKey(goal.sessionID), goal);
    } catch (err) {
      console.warn(`opencode-goal: failed to save goal ${goal.id}:`, err);
    }
    // timeoutWrap sync (Task 14 Fix 3b): reflect the record's status
    if (goal.status === "active") this.activeGoalSessions.add(goal.sessionID);
    else this.activeGoalSessions.delete(goal.sessionID);
    return true;
  }

  /** Terminal transition: archive copy under archivedGoalKey (same id rewrites). */
  private async archiveGoal(goal: GoalRecord): Promise<void> {
    try {
      await this.probe.storageSet(archivedGoalKey(goal.sessionID, goal.id), goal);
    } catch (err) {
      console.warn(`opencode-goal: failed to archive goal ${goal.id}:`, err);
    }
  }

  /**
   * Terminal transition: save + archive copy under archivedGoalKey.
   * Task 14 Fix 1: when the save is dropped as stale (compare-and-set guard),
   * the archive is SKIPPED — an archive copy would claim a terminal state
   * that storage never received.
   * @returns false when the write was dropped (goal changed underneath).
   */
  private async finishGoal(
    goal: GoalRecord,
    status: GoalStatus,
    patch?: Partial<Pick<GoalRecord, "evidence" | "blocker">>,
  ): Promise<boolean> {
    if (patch?.evidence !== undefined) goal.evidence = patch.evidence;
    if (patch?.blocker !== undefined) goal.blocker = patch.blocker;
    goal.status = status;
    this.judgeInstruction.delete(goal.sessionID); // terminal: drop any pending judge paragraph
    const saved = await this.saveGoal(goal);
    if (!saved) return false;
    await this.archiveGoal(goal);
    return true;
  }

  private capText(goal: GoalRecord): string {
    const cap = goal.cap;
    const turns = cap.turns !== undefined ? `${cap.turns} turns` : "unbounded turns";
    const tokens = cap.tokens !== undefined ? `${cap.tokens} tokens` : "unbounded tokens";
    return `${turns} / ${tokens}`;
  }

  private async setGoal(sessionID: string, objective: string, cap: GoalRecord["cap"]): Promise<string> {
    const existing = await this.loadGoal(sessionID);
    if (existing !== undefined && !isTerminal(existing.status)) {
      // Ruling R7 (spec §9): a refused set must NOT touch the old goal — no
      // status change, no updatedAt bump, no archive write. The old goal is
      // terminated first (complete/block/clear), then a new set succeeds.
      return `goal ${existing.id} is still in progress (status: ${existing.status}): ` +
        `complete, block or clear it before starting a new goal (${objective}).`;
    }
    const goal = createGoal({ sessionID, objective, cap });
    this.judgeInstruction.delete(sessionID); // new goal: stale instruction must not leak over
    await this.saveGoal(goal);
    return `goal ${goal.id} created: ${objective} (cap: ${this.capText(goal)})`;
  }

  private async viewGoal(sessionID: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    return (
      `[GOAL ${goal.id}] status: ${goal.status} | objective: ${goal.objective} | ` +
      `cap: ${this.capText(goal)} | used: ${goal.used.turns} turns, ${goal.used.tokens} tokens`
    );
  }

  /**
   * Task 14 Fix 1: the "changed underneath" refusal for command/tool surfaces
   * — a dropped stale write must NEVER be reported as a successful terminal
   * transition (ruling: the user-facing wording carries "changed").
   */
  private changedUnderneath(goal: GoalRecord): string {
    return `goal ${goal.id} changed underneath: a newer write landed meanwhile — reload and retry`;
  }

  private async completeGoal(sessionID: string, evidence: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    const transcript = await this.transcript(sessionID);
    const problem = validateEvidence(evidence, transcript);
    if (problem !== undefined) return problem;
    const done = await this.finishGoal(goal, "completed", { evidence });
    if (!done) return this.changedUnderneath(goal);
    return `goal ${goal.id} completed: ${evidence}`;
  }

  private async blockGoal(sessionID: string, reason: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    if (reason.trim() === "") return `a non-empty reason is required to block goal ${goal.id}`;
    const done = await this.finishGoal(goal, "blocked", { blocker: reason });
    if (!done) return this.changedUnderneath(goal);
    return `goal ${goal.id} blocked: ${reason}`;
  }

  /** /goal clear: the request is derived from the transcript itself. */
  private async clearGoalFromCommand(sessionID: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    const transcript = await this.transcript(sessionID);
    const request = this.findClearRequest(transcript);
    if (request === undefined) {
      return "no user clear request found in the transcript (fail-closed): the user must state the clear intent";
    }
    const problem = validateClearRequest(request, transcript);
    if (problem !== undefined) return problem;
    const done = await this.finishGoal(goal, "cleared");
    if (!done) return this.changedUnderneath(goal);
    return `goal ${goal.id} cleared`;
  }

  /** goal_clear tool: an explicit request string, grounded in the transcript. */
  private async clearGoalFromTool(sessionID: string, request: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    const transcript = await this.transcript(sessionID);
    const problem = validateClearRequest(request, transcript);
    if (problem !== undefined) return problem;
    const done = await this.finishGoal(goal, "cleared");
    if (!done) return this.changedUnderneath(goal);
    return `goal ${goal.id} cleared: ${request}`;
  }

  /** Latest user message that looks like a clear intent (candidate filter only). */
  private findClearRequest(transcript: TranscriptMessage[]): string | undefined {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i];
      if (m.type !== "user") continue;
      const text = m.text ?? "";
      if (text.length >= MIN_CLEAR_REQUEST_LENGTH && CLEAR_KEYWORD_RE.test(text.toLowerCase())) return text;
    }
    return undefined;
  }

  private async pauseGoal(sessionID: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status === "paused") return `goal ${goal.id} is already paused`;
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    goal.status = "paused";
    await this.saveGoal(goal);
    return `goal ${goal.id} paused`;
  }

  private async resumeGoal(sessionID: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status === "active") return `goal ${goal.id} is already active`;
    if (goal.status !== "paused") return `goal ${goal.id} is not active (status: ${goal.status})`;
    goal.status = "active";
    await this.saveGoal(goal);
    // Task 14 Fix 4: a paused goal was disarmed by the tick's ghost rule
    // (status !== active → disarmWatchdog) — resume must RE-ARM the watchdog
    // for the still-waiting shells, or they would be checked by nobody.
    if ((goal.waitingShells ?? []).length > 0) {
      this.ensureWatchdog(sessionID);
    }
    return `goal ${goal.id} resumed (active)`;
  }

  private async taskAdd(sessionID: string, title: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || isTerminal(goal.status)) return "no active goal for this session";
    if (title.trim() === "") return "a non-empty task title is required";
    addTask(goal, title);
    await this.saveGoal(goal);
    return `task ${goal.tasks.length} added: ${title}`;
  }

  private async taskUpdate(sessionID: string, ref: string, status: GoalTaskStatus): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined || isTerminal(goal.status)) return "no active goal for this session";
    if (goal.tasks.length === 0) return `goal ${goal.id} has no tasks`;
    const index = resolveTaskRef(goal.tasks, ref);
    if (index === -1) return `task ref "${ref}" not found (goal has ${goal.tasks.length} tasks)`;
    const task = goal.tasks[index - 1];
    task.status = status;
    task.updatedAt = Date.now();
    await this.saveGoal(goal);
    return `task ${index} -> ${status}`;
  }

  private async historyGoal(sessionID: string): Promise<string> {
    const prefix = `${goalStorageKey(sessionID)}/archived/`;
    let entries: Array<{ key: string; value: unknown }>;
    try {
      entries = await this.probe.storageScan(prefix);
    } catch (err) {
      console.warn(`opencode-goal: failed to scan archived goals for ${sessionID}:`, err);
      return `no archived goals for this session`;
    }
    if (entries.length === 0) return `no archived goals for this session`;
    const lines = entries.map((e) => {
      const g = e.value as GoalRecord;
      return `- ${g.id} (${g.status}) ${g.objective}`;
    });
    return `archived goals:\n${lines.join("\n")}`;
  }

  private async waitGoal(sessionID: string, minutes: number): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    const waitUntil = Date.now() + minutes * 60_000;
    goal.waitUntil = waitUntil;
    await this.saveGoal(goal);
    return `goal ${goal.id} will not be woken for ${minutes} minutes (until ${new Date(waitUntil).toISOString()})`;
  }

  // ------------------------------------------------------------------
  // transcript access
  // ------------------------------------------------------------------

  /** Host transcript -> evidence.ts TranscriptMessage[] (best-effort). */
  private async transcript(sessionID: string): Promise<TranscriptMessage[]> {
    let messages: SessionMessage[];
    try {
      messages = await this.probe.context(sessionID);
    } catch {
      return [];
    }
    return messages.map((m) => {
      const out: TranscriptMessage = { type: typeof m.type === "string" ? m.type : undefined };
      if (typeof m.text === "string") out.text = m.text;
      if (Array.isArray(m.content)) {
        out.content = (m.content as unknown[]).map((c) => {
          if (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string") {
            return { text: (c as { text: string }).text };
          }
          return { text: undefined };
        });
      }
      return out;
    });
  }
}
