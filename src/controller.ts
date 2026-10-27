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
  bumpGoalDecision,
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
import {
  backgroundCheckInText,
  buildWakeMessage,
  foregroundBackgroundNoticeText,
  goalWaitExpiryText,
  providerPauseNoticeText,
  providerPauseRetryText,
} from "./wake";
import { buildCompactionPrompt, composeCompactionSummary } from "./compact";
import { decidePermission, GOAL_CONTROL_ACTION } from "./permission";
import { appendDecision } from "./decisionlog";
import type { HostEvent, PermissionDecision, PermissionHookInput, SessionMessage, ShellEntry, WakeProbe } from "./types";

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
  /** §50 liveness: no events received for this long while a started turn has
   *  no terminal → re-subscribe + re-arbitrate (default 5 min; tests inject). */
  livenessMs?: number;
  /** §50 liveness scan period (default 30s; tests inject). */
  livenessCheckMs?: number;
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
  "Goal loop: the model advances the goal autonomously; completion is evidence-gated. Goals are unbounded by default — an explicit cap, when set, ends the run on budget exhaustion.",
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

/** All goal_* tools are gated by the goal.control permission (Task 3). */
const GOAL_PERMISSION = GOAL_CONTROL_ACTION;

/**
 * 2026-10-20 ruling: the twelve goal_* tools register as ONE group — the
 * `goal` namespace (MCP-server style, declared once via registerNamespace)
 * with prefix-free registration names; the host flattens to `goal_<name>`
 * (effectiveName, host tool/runtime.ts), so the model-visible names
 * (goal_set, goal_next_step, ...) are UNCHANGED — session records, wake text
 * and live data need no migration. One shared options object: single gate +
 * native tools-array exposure (codemode:false, host subagent precedent).
 * Older hosts ignore unknown option fields (in-process editor, no codec
 * boundary): the tools degrade to Code Mode-only, never lost.
 */
const GOAL_NAMESPACE = "goal";
const GOAL_TOOL_OPTIONS = {
  permission: GOAL_PERMISSION,
  codemode: false,
  namespace: GOAL_NAMESPACE,
} as const;

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
  | { id: string; kind: "wake"; goalID?: string; watchdog?: true }
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
   * One-shot progress-check deadline per session (2026-10-17 ruling): armed at
   * in-flight boundaries, cancelled by any session activity, fired by the
   * watchdog tick.
   */
  private checkinDue = new Map<string, { due: number; inFlight: number }>();
  /** §60: in-flight BLOCKING goal_wait — the tool handler's await state. The
   * host-side `sleep` shell is the clock; the persisted waitUntil is the
   * reload fallback; resolve() comes from an event handler (user input /
   * shell exit) or the JS fallback timer. One per session (a turn holds at
   * most one tool call). */
  private pendingWaits = new Map<
    string,
    {
      shellID: string; // "" = timer-only (shell fire failed)
      due: number;
      timer: ReturnType<typeof setTimeout>;
      shells: Set<string>; // session shells created during the wait (shell.created)
      resolve: (r: { reason: "deadline" | "user" | "shell" | "cancelled"; shellID?: string; exit?: number }) => void;
    }
  >();
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
  /** §50: wall clock of the last event actually RECEIVED (freshness of the
   *  subscription, independent of any goal state). */
  private lastEventAt = 0;
  /** §50: timestamp of the last re-subscribe (≥1s apart: a stream that dies
   *  instantly must not hot-loop the subscription). */
  private lastResubAt = 0;
  /** §50: per-session liveness recheck cooldown (one recheck per livenessMs). */
  private recheckAt = new Map<string, number>();
  /** §50 global liveness timer (independent of the per-goal watchdog). */
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  /** §50 probe (verification only, OPENCODE_GOAL_KILL_STREAM=1): kill our own
   * subscription once, at the first handled turn start — simulates the 129
   * host-side stream death so scripts/verify-heal.ts can exercise the
   * re-subscribe recovery on a real host. No-op unless the env is set. */
  private killStreamProbePending = true;
  /** §52: shells already sent to background observation (dedupe the POST —
   * the endpoint is session-level, one call moves all foreground work). */
  private backgroundedShells = new Set<string>();
  /** §52: first-observed wall clock for shells without a host start time
   * (elapsed then counts from observation, not from spawn). */
  private shellFirstSeen = new Map<string, number>();
  private loopPromise: Promise<void> | undefined;
  private stopped = false;
  /** This instance's live-slot reference (set at the first line of start()). */
  private liveSlotRef: LiveSlot | undefined;
  /** Memoized stop: stopInstance is idempotent (takeover + host unload share it). */
  private stopping: Promise<void> | undefined;

  // ------------------------------------------------------------------
  // Task 10: watchdog (spec §7.1) — per-goal tick timers + per-shell
  // in-memory watch state (tail / lastTailAt / checkedIn live ONLY here,
  // never in storage).
  // ------------------------------------------------------------------

  /** One tick timer per armed goal (sessionID key — one active goal per session). */
  private wdTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Per-goal in-flight tick guard (a tick never overlaps itself). */
  private wdBusy = new Set<string>();

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

    // One namespace declaration (MCP-server style): the catalog groups the
    // twelve tools under `goal`; each tool carries the same name in options.
    this.probe.registerNamespace(
      GOAL_NAMESPACE,
      "Goal loop management: set/complete/block/clear the active goal, manage its task list, record the next step, wait/pause/resume, and view state. All tools gate on goal.control. Most require an active goal — goal_view/goal_history are read-only and work without one; goal_next_step records at any time and reactivates an ended goal.",
    );

    // 2026-10-20 ruling: the twelve tools register as ONE group — a single
    // host transform (MCP-server style): one Registration, atomic teardown,
    // one catalog commit; a malformed entry only lands in the host's
    // registration errors, siblings unaffected.
    this.probe.registerToolGroup([
      {
        name: "set",
        description:
          "Use only when the user explicitly asks you to set a goal. Start a new goal " +
          "(objective required; goals are unbounded by default — an optional turns/tokens cap when the user wants one). " +
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
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_set", () => this.toolSet(sessionID, input)),
      },
      {
        name: "complete",
        description:
          "Terminal: mark the ACTIVE goal completed with concrete, checkable evidence " +
          "(\u226524 chars, anchored, grounded in the transcript). Gating: goal.control permission; " +
          "refused when no goal is active.",
        input: {
          type: "object",
          properties: { evidence: { type: "string" } },
          required: ["evidence"],
        },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_complete", () => this.toolComplete(sessionID, input)),
      },
      {
        name: "block",
        description:
          "Terminal: mark the ACTIVE goal blocked with a concrete reason. " +
          "Gating: goal.control permission; refused when no goal is active or the reason is missing.",
        input: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_block", () => this.toolBlock(sessionID, input)),
      },
      {
        name: "clear",
        description:
          "Terminal: clear the ACTIVE goal. The request must quote the user's own words " +
          "(grounded in non-assistant transcript messages; fail-closed). " +
          "Gating: goal.control permission; refused when no goal is active.",
        input: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
        },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_clear", () => this.toolClear(sessionID, input)),
      },
      {
        name: "history",
        description:
          "Read-only: list the archived goals of this session. Gating: goal.control permission; no goal required.",
        input: { type: "object", properties: {} },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_history", () => this.toolHistory(sessionID, input)),
      },
      {
        name: "add_task",
        description:
          "Add a todo task (title required; the ledger is uncapped). " +
          "Gating: goal.control permission; requires a non-terminal goal.",
        input: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_add_task", () => this.toolAddTask(sessionID, input)),
      },
      {
        name: "update_task",
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
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_update_task", () => this.toolUpdateTask(sessionID, input)),
      },
      {
        name: "next_step",
        description:
          "Record your next-step plan (what is done -> the ONE next concrete step -> how you will judge it) " +
          "so the goal loop can resume you on the next wake. The note persists through compaction and " +
          "restarts and is replayed in your next wake. If the session's goal has ended (completed/paused/" +
          "blocked/stalled), this call re-activates it as a fresh phase (counters reset, same cap). " +
          "cleared and budget_limited stay terminal — use goal_set for a new objective or a larger budget. " +
          "Gating: goal.control permission.",
        input: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        // goal_next_step = the model's mid-work recorder (the only tool the
        // model is expected to call spontaneously during work); the other
        // eleven are lifecycle/management — all twelve share
        // GOAL_TOOL_OPTIONS (gate + goal namespace). §60: goal_wait is the
        // one exception to native-only exposure (codemode:true, its
        // registration below).
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_next_step", () => this.toolNextStep(sessionID, input)),
      },
      {
        name: "wait",
        description:
          "Wait up to N minutes (integer 1..60) — a BLOCKING call by default: it does not return until the " +
          "deadline OR an event returns it early: a user message arrives, another shell of this session ends, " +
          "or the wait is cancelled (its wait shell is killed). The result says which happened. " +
          "No polling: set minutes to your real expected duration and let the call hang. " +
          "background=true keeps the classic non-blocking window (returns immediately; the loop re-wakes you " +
          "at the deadline with a 'Goal wait period ended' notice). " +
          "Gating: goal.control permission; requires an ACTIVE goal.",
        input: {
          type: "object",
          properties: {
            minutes: { type: "number" },
            background: { type: "boolean" },
          },
          required: ["minutes"],
        },
        // §60: the ONLY goal tool catalogued for Code Mode (codemode:true) —
        // the model composes `await tools.goal.wait(...)` / Promise.race in
        // execute() (host Code Mode has no default timeout). The other eleven
        // lifecycle tools stay GOAL_TOOL_OPTIONS (codemode:false, native).
        ...GOAL_TOOL_OPTIONS,
        codemode: true,
        run: (input, sessionID) => this.guarded("goal_wait", () => this.toolWait(sessionID, input)),
      },
      {
        name: "pause",
        description:
          "Suspend the goal loop (no wake-ups, no stall counting) until the goal is resumed. " +
          "Gating: goal.control permission; requires an ACTIVE goal. " +
          "Use when the user asks you to pause or hold the goal in conversation.",
        input: { type: "object", properties: {} },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_pause", () => this.pauseGoal(sessionID)),
      },
      {
        name: "resume",
        description:
          "Resume a goal in a resumable state: paused (silent restart), blocked (stale blocker " +
          "cleared) or budget_limited (cap still enforced — the resumed goal gets ONE boundary " +
          "of budget grace (§49), then re-terminates at the following boundary unless the cap " +
          "is raised). " +
          "Gating: goal.control permission; refused for completed/stalled/cleared (hard terminal) " +
          "or when no goal exists. " +
          "Use when the user asks you to continue or resume the goal in conversation.",
        input: { type: "object", properties: {} },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) =>
          this.guarded("goal_resume", async () => (await this.resumeGoal(sessionID)).text),
      },
      {
        name: "view",
        description:
          "Read-only: show the goal's id, status, objective, cap and usage (no wake, no state change). " +
          "Gating: goal.control permission; a session without a goal record gets a notice. " +
          "Use when the user asks about the goal's state, objective or progress in conversation.",
        input: { type: "object", properties: {} },
        ...GOAL_TOOL_OPTIONS,
        run: (input, sessionID) => this.guarded("goal_view", () => this.viewGoal(sessionID)),
      },
    ]);

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

    // §57 (2026-10-24 — the host reload incident, local desktop 2.1.4): a host
    // LOCATION RE-INIT re-instantiates this plugin (observed ~hourly:
    // "location services booted" + watcher reboots + provider/model/agent
    // updated events). Every RUNNING tick timer dies with the old instance,
    // and armed check-in deadlines (in-memory) die with it. Persisted goal
    // deadlines survive (kv) — a pending goal_wait window or a providerPause
    // retry must still fire. Re-arm the watchdog at start for every such goal:
    // this is the restart reconciliation that was removed in 2026-10-17,
    // re-added in its reload form (its old premise — "the host restart sweep
    // resumes the session, whose next boundary re-arms" — failed on 2026-10-24:
    // the session stayed idle and no boundary ever came).
    void this.initRearm();

    // Task 8: single event loop (boundary arbiter + wake loop) over
    // probe.eventSubscribe() — spec §6 arbitration, §11 budget,
    // §15-9 blocked resume. One consumer per controller instance.
    this.stopped = false;
    this.loopPromise = this.runLoop();
    // §50: the liveness scan runs on its own clock for the whole lifetime of
    // the instance (the per-goal watchdog is disarmed while a turn is in
    // flight — exactly when a lost terminal would otherwise go unnoticed).
    this.livenessTimer = setInterval(() => {
      void this.livenessScan().catch((err) => {
        console.warn("opencode-goal: liveness scan failed:", err);
      });
      void this.foregroundShellScan().catch((err) => {
        console.warn("opencode-goal: foreground-shell scan failed:", err);
      });
    }, this.livenessCheckMs());
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
      if (this.livenessTimer !== undefined) clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
      // stop EVERYTHING — all per-goal watchdog timers and pending tick work
      // (test/watchdog.test.ts #10).
      for (const timer of this.wdTimers.values()) clearInterval(timer);
      this.wdTimers.clear();
      this.wdBusy.clear();
      this.checkinDue.clear();
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

  /**
   * §50 stream self-healing (2026-10-21 129 incident: the host's event stream
   * ended cleanly mid-session; the old loop returned — the DONE path silently,
   * with zero logs — and the goal froze for ~4.5h while the host kept
   * emitting). A dropped subscription is now a transient condition:
   * - iterator `done` or `throw` → fresh subscription (≥1s apart), loudly logged;
   * - the loop's iterator variable is REPLACED on reopen — the old code kept
   *   polling the dead iterator (resubscribed consumers went unused).
   */
  private async runLoop(): Promise<void> {
    let iter = this.openSubscription();
    for (;;) {
      let result: IteratorResult<HostEvent>;
      try {
        result = await iter.next();
      } catch (err) {
        console.warn("opencode-goal: event stream errored — re-subscribing:", err);
        const next = await this.reopenSubscription(iter);
        if (next === undefined) return;
        iter = next;
        continue;
      }
      if (result.done) {
        console.warn("opencode-goal: event stream ended — re-subscribing");
        const next = await this.reopenSubscription(iter);
        if (next === undefined) return;
        iter = next;
        continue;
      }
      if (this.stopped) {
        await iter.return?.();
        return;
      }
      this.lastEventAt = Date.now();
      try {
        await this.handleEvent(result.value);
        // §50 probe (verification only): kill our own subscription once, at
        // the first handled turn start — the loop's done path must
        // re-subscribe and keep processing (scripts/verify-heal.ts).
        if (this.killStreamProbePending && process.env.OPENCODE_GOAL_KILL_STREAM === "1") {
          if (result.value.type === "session.execution.started") {
            this.killStreamProbePending = false;
            console.warn("opencode-goal: [probe] force-killing event stream (OPENCODE_GOAL_KILL_STREAM)");
            this.forceResubscribe();
          }
        }
      } catch (err) {
        // Fault-tolerance discipline: a single event failure never breaks the loop.
        console.warn(
          `opencode-goal: failed to handle event ${result.value.type} (${result.value.id ?? "no id"}):`,
          err,
        );
      }
    }
  }

  /** Open a fresh subscription and register it as the loop's iterator. */
  private openSubscription(): AsyncIterator<HostEvent> {
    const iter = this.probe.eventSubscribe()[Symbol.asyncIterator]();
    this.loopIter = iter;
    return iter;
  }

  /** Close `old`, back off (≥1s between re-subscribes: a stream that dies
   * instantly must not hot-loop the subscription), and open a fresh one.
   * Resolves undefined iff the instance was stopped (caller ends the loop). */
  private async reopenSubscription(
    old: AsyncIterator<HostEvent>,
  ): Promise<AsyncIterator<HostEvent> | undefined> {
    try {
      await old.return?.();
    } catch {
      // already closed
    }
    this.loopIter = undefined;
    const wait = this.lastResubAt + 1_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (this.stopped) return undefined;
    this.lastResubAt = Date.now();
    return this.openSubscription();
  }

  /** §50 liveness: force the loop onto a fresh subscription by closing the
   * current one — the loop's done path does the backoff/reopen. (The liveness
   * scan must NOT open its own subscription: the loop owns the iterator.) */
  private forceResubscribe(): void {
    const iter = this.loopIter;
    if (iter === undefined) return;
    this.loopIter = undefined;
    void iter.return?.();
  }

  /** §50 liveness window (default 5 min — a missed boundary must cost at most
   * this much silence; tests inject deps.livenessMs; §54: option `livenessMs`). */
  private livenessMs(): number {
    return this.deps.livenessMs ?? this.options.livenessMs;
  }

  /** §50 liveness scan period (default 30s; tests inject deps.livenessCheckMs;
   * §54: option `livenessCheckMs`).
   * A GLOBAL timer — deliberately NOT the per-goal watchdog: the watchdog is
   * disarmed when a turn starts, and the fatal case (129 incident) is exactly
   * "turn started (seen), terminal lost (never seen) → nothing re-arms the
   * watchdog". */
  private livenessCheckMs(): number {
    return this.deps.livenessCheckMs ?? this.options.livenessCheckMs;
  }

  /** §52 (2026-10-21 ruling): a FOREGROUND (blocking) shell in an active-goal
   * session that outlives `foregroundShellBackgroundMs` is moved to background
   * observation via the host's session.background endpoint (the Ctrl+B server
   * action — the work KEEPS RUNNING; the host injects its own synthetic so the
   * blocked turn is released). Without this, a hung foreground shell freezes
   * the loop forever: the turn is blocked on the tool call, so no boundary, no
   * check-in (armed checks wait for idle), and the §50 liveness recheck is
   * held by the in-flight gate (the shell is still in flight). Runs on the
   * global 30s timer (NOT gated by the liveness silence condition); one POST
   * per shell (dedupe); a failed POST retries on the next scan. */
  private async foregroundShellScan(): Promise<void> {
    if (this.stopped) return;
    const cap = this.options.foregroundShellBackgroundMs;
    if (cap <= 0) return; // disabled
    const now = Date.now();
    for (const sessionID of this.turns.keys()) {
      const goal = await this.loadGoal(sessionID);
      if (goal === undefined || goal.status !== "active") continue;
      let directory: string | undefined;
      try {
        const info = await this.probe.sessionGet(sessionID);
        directory = info?.location?.directory;
      } catch {
        continue; // host context dead — retry next scan
      }
      if (directory === undefined) continue;
      let shells;
      try {
        shells = await this.probe.shellList(directory);
      } catch {
        continue; // shell store query failed — retry next scan
      }
      // §56: a shell only BLOCKS a turn while the session's own turn is alive
      // (host active map "running") — an idle session with a running shell is
      // background work: nothing to rescue, and POSTing session.background
      // for it would be a no-op with a misleading notice.
      let active;
      try {
        active = await this.probe.activeSessions(directory);
      } catch {
        continue; // retry next scan
      }
      if (active[sessionID] !== "running") continue;
      for (const sh of shells) {
        if (sh.sessionID !== sessionID || sh.status !== "running" || sh.background === true) continue;
        if (this.backgroundedShells.has(sh.id)) continue; // already moved
        const firstSeen = this.shellFirstSeen.get(sh.id) ?? now;
        const started = sh.time?.started ?? firstSeen;
        const elapsed = now - started;
        if (elapsed < cap) {
          this.shellFirstSeen.set(sh.id, firstSeen);
          continue; // still young
        }
        try {
          await this.probe.sessionBackground(sessionID);
          this.backgroundedShells.add(sh.id); // dedupe (the POST moves ALL the session's foreground work)
          if (this.backgroundedShells.size > 100) this.backgroundedShells.clear(); // bound
          console.warn(
            `opencode-goal: §52 foreground shell ${sh.id} in ${sessionID} ran ${Math.round(elapsed / 60000)}m — ` +
              `moved to background observation (session.background; work keeps running)`,
          );
          // §54 (2026-10-22 ruling): the host's own synthetic releases the
          // blocked turn, but the USER ruled for an IMMEDIATE plugin notice
          // too — one per shell, via the watchdog wake path. 2026-10-27
          // (129 incident, spec §62): delivery "steer", not "queue" — the
          // notice lands at the step boundary when session.background just
          // released the turn, while the session is STILL BUSY (the model
          // proceeds into goal_wait / keeps working). A "queue" delivery
          // waits for an idle a busy goal session never offers, so the notice
          // parked forever (the 129 500K-IMA incident). Verified live on 2.2.0:
          // scripts/probe-steer2.ts (steer delivered mid-turn at a busy
          // session; the model replied it only "received" the steer).
          await this.deliverWatchdogWake(
            goal,
            foregroundBackgroundNoticeText(
              sh.id,
              sh.command,
              this.options.foregroundNoticeCommandChars,
              this.durationLabel(elapsed),
              this.durationLabel(cap),
            ),
            `foreground shell auto-backgrounded (cap ${this.durationLabel(cap)})`,
            "steer",
          );
        } catch (err) {
          // NOT added to the dedupe set: a failed POST retries on the next scan.
          console.warn(`opencode-goal: §52 backgrounding ${sh.id} failed (retry next scan):`, err);
        }
      }
    }
  }

  /** §54: "41m" for >= 1 min, "90s" below that (never "0m"/"0s" — a shell
   * that ran at all got at least one second/minute of foreground time). */
  private durationLabel(ms: number): string {
    const m = Math.floor(ms / 60_000);
    return m >= 1 ? `${m}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
  }

  /** §54/§56 (2026-10-24 host-contract forensics): this session's running
   * shells that are ACTUALLY BLOCKING a turn — a shell is blocking only while
   * the host's ACTIVE MAP says the session's turn is "running" (the UI's own
   * signal; a turn blocked on a foreground shell IS running) AND the entry is
   * not an explicit `background: true` (server-fired). Idle session + running
   * shell = background work, NOT blocking (the §54 "absent flag" misread is
   * dead — model-shell entries never carry the flag at all). While any of
   * these is in flight the stream silence is EXPECTED (the turn is stuck on
   * the tool call), not a dead stream. Query failure returns [] (callers
   * fail open: the §50 recheck / the delivery proceed). */
  private async blockingShellIds(sessionID: string): Promise<string[]> {
    try {
      const info = await this.probe.sessionGet(sessionID);
      const directory = info?.location?.directory;
      if (directory === undefined) return [];
      const [shells, active] = await Promise.all([
        this.probe.shellList(directory),
        this.probe.activeSessions(directory),
      ]);
      if (active[sessionID] !== "running") return []; // no live turn → nothing is blocking
      return shells
        .filter((e) => e.sessionID === sessionID && e.status === "running" && e.background !== true)
        .map((e) => e.id);
    } catch {
      return [];
    }
  }

  /** §50 one scan: if the stream has been silent for livenessMs while a turn we
   * STARTED is still tracked active (its terminal was never received — a dead
   * subscription), re-subscribe and re-arbitrate the boundary as if the
   * terminal had just arrived. The arbitration's own in-flight gate (host
   * active-map / shell store) keeps a genuinely running turn from being
   * woken — a false positive costs one held boundary, never a spurious wake. */
  private async livenessScan(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    // §58: the orphan sweep runs on EVERY scan — independent of the event-flow
    // gate below — because its target is exactly the "no events at all" case:
    // a parked goal whose armed deadline died in a reload or a machine sleep.
    try {
      await this.orphanSweep(now);
    } catch (err) {
      console.warn("opencode-goal: §58 orphan sweep failed:", err);
    }
    if (now - this.lastEventAt <= this.livenessMs()) return;
    for (const [sessionID, t] of this.turns) {
      if (!t.active) continue;
      if (now - (this.recheckAt.get(sessionID) ?? 0) <= this.livenessMs()) continue;
      // §54: a turn blocked on its own foreground shell emits NO stream events
      // by design — that silence is expected (rechecking would fabricate a
      // boundary, arm a check-in that cannot be delivered, and clear the
      // active flag — the 129 2026-10-22 screenshot chain). A failed query
      // above returned [] → the recheck proceeds (a truly dead host must
      // still be able to self-heal).
      if ((await this.blockingShellIds(sessionID)).length > 0) continue;
      this.recheckAt.set(sessionID, now);
      console.warn(
        `opencode-goal: liveness recheck for ${sessionID} — no events for ` +
          `${Math.round((now - this.lastEventAt) / 1000)}s while a started turn has no terminal ` +
          `(stream died?); re-subscribing + re-arbitrating the boundary`,
      );
      this.forceResubscribe();
      try {
        await this.arbitrateBoundary(sessionID, {
          type: "session.idle",
          id: undefined,
          properties: { sessionID },
        });
      } catch (err) {
        console.warn(`opencode-goal: liveness recheck failed for ${sessionID}:`, err);
      }
    }
  }

  /**
   * §58 (2026-10-25 — overnight incident): a parked ACTIVE goal with
   * IN-FLIGHT work but NO live watchdog is an orphan — a host reload
   * (location evict/reboot) or a machine sleep vaporized its armed check-in,
   * and nothing else wakes the loop (shell lifecycle events are NOT
   * boundaries). Re-arm an IMMEDIATE check-in: the model goes and finds out
   * what happened to the work it was waiting on. Quiet windows suppress it
   * (window semantics — the waitUntil deadline wake owns that moment); a
   * dead host context retries on the next sweep. Runs every livenessCheckMs
   * (30s), independent of event flow.
   */
  private async orphanSweep(now: number): Promise<void> {
    for (const sessionID of [...this.activeGoalSessions]) {
      if (this.stopped) return;
      if (this.turns.get(sessionID)?.active === true) continue; // a live turn owns its own boundaries
      if (this.wdTimers.has(sessionID)) continue; // a live tick owns its deadlines
      if (this.checkinDue.get(sessionID) !== undefined) continue; // a pending deadline (and its tick)
      const goal = await this.loadGoal(sessionID);
      if (goal === undefined || goal.status !== "active") continue;
      const quiet =
        (goal.waitUntil !== undefined && now < goal.waitUntil) ||
        (goal.providerPause !== undefined && now < goal.providerPause.until);
      if (quiet) continue; // the window suppresses check-ins until it ends
      // A turn that is ALIVE but blocked on its own foreground shell is not
      // parked — the §52/§54 machinery owns it (auto-background at the cap,
      // whose end boundary re-arms a fresh check). Arming here would churn:
      // the tick discards the deadline (blocked turn), the next sweep re-arms —
      // the 2026-10-25 test flake. The §56 active map is the same signal the
      // blocking gate uses: "running" = turn alive; idle + running work (the
      // overnight shape) still arms. A failed query fails open (arms — the
      // tick's §54 discard is the second line).
      let active: Record<string, string> = {};
      try {
        const info = await this.probe.sessionGet(sessionID);
        const directory = info?.location?.directory;
        if (directory !== undefined) active = await this.probe.activeSessions(directory);
      } catch {
        // dead host context — fail toward waking (the tick re-checks on fire)
      }
      if (active[sessionID] === "running") continue;
      const sig = await this.inFlightSignal(sessionID);
      if (!sig.ownKnown) continue; // host context dead — retry next sweep
      const inFlight = sig.own + sig.other;
      if (inFlight === 0) continue;
      this.checkinDue.set(sessionID, { due: now, inFlight }); // immediate
      goal.checkinDue = { due: now, inFlight };
      await this.saveGoal(goal);
      this.ensureWatchdog(sessionID);
      console.warn(
        `opencode-goal: §58 orphan sweep — ${sessionID} parked with ${inFlight} in-flight item(s), no live watchdog: armed an immediate check-in`,
      );
    }
  }

  private async handleEvent(event: HostEvent): Promise<void> {
    if (this.stopped) return; // displaced mid-flight: in-flight event no-ops
    // §60: shell.* events serve the BLOCKING wait clock and carry no top-level
    // sessionID (shell.exited / shell.deleted data = { id, ... }; shell.created
    // = { info } with the session on info.metadata.sessionID) — they must be
    // handled BEFORE the attribution guard below.
    if (event.type === "shell.created" || event.type === "shell.exited" || event.type === "shell.deleted") {
      await this.onShellEvent(event);
      return;
    }
    const sessionID = event.properties?.sessionID;
    if (typeof sessionID !== "string" || sessionID === "") return; // 无归属：无 sessionID
    if (!(await this.sessionBelongs(sessionID))) return; // 无归属：非本实例 project
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
      // session.shell.* (session-scoped model shells) are no longer consumed
      // (2026-10-19): in-flight shells are discovered by the gate's shell-store
      // query, not by events; completion is the one-shot progress check or a
      // goal resume. shell.* (service-level store events) are consumed BEFORE
      // the switch (see onShellEvent) for the §60 blocking wait only. They
      // fall through to default here.
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
    // The session went active — stop the watchdog's tick (止表). Any pending
    // progress check was already cancelled at the top. EXCEPT when a deadline
    // is pending (goal_wait window / unexpired provider pause): the tick owns
    // those wakes, and the tick's own disarm rule keeps it alive until the
    // deadline fires (§57). Disarming here would kill the heartbeat the same
    // way the 2026-10-24 incident's reload did (parked, no wake source) — and
    // it re-armed on every boundary, which is what powered the 129 2026-10-25
    // goal_wait storm.
    const deadlinePending =
      goal.waitUntil !== undefined && goal.waitWakeSent !== true ||
      (goal.providerPause !== undefined && Date.now() < goal.providerPause.until);
    if (!deadlinePending) this.disarmWatchdog(sessionID);
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
    // §50 real-host finding (2026-10-21): the goalControl marker in the payload
    // is the AUTHORITATIVE signal — the host's delivered item TYPE is not:
    // 2.1.1 delivers our KICK result-line synthetic as a user-typed inbox item
    // (records arrive as type:"synthetic"); classifying on itemType==="synthetic"
    // re-attributed the kick line as "user" and the kick turn's boundary woke
    // spuriously (verify-wake 2026-10-21 run: the set-kick turn consumed the
    // goal's only budget turn).
    const isControl =
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
      } else if (
        typeof payload.metadata === "object" &&
        payload.metadata !== null &&
        !Array.isArray(payload.metadata) &&
        (payload.metadata as Record<string, unknown>).goalWake === true
      ) {
        // §60 (2026-10-26 verify incident): the PAYLOAD marker is authoritative
        // (same discipline as the goalControl signal above) — the wakeInbox
        // slot is single-per-session and a wake STORM (each countdown boundary
        // injects a wake every ~1s) overwrites it: a stale own-wake's enqueued
        // event no longer matched the slot and was classified "user", which
        // resolved an in-flight BLOCKING goal_wait early. goalWake items are
        // OUR loop traffic, never user input (slot match kept as fallback).
        const wakeMeta = payload.metadata as Record<string, unknown>;
        entry = { id: inboxID, kind: "wake", goalID: typeof wakeMeta.goalID === "string" ? wakeMeta.goalID : undefined };
      } else {
        entry = { id: inboxID, kind: "user" };
      }
    } else {
      // compaction / move / unmarked synthetic — counts toward the stall
      // ladder via "other" (pinned in test/arbiter.test.ts; task13 closed
      // 2026-10-20).
      entry = { id: inboxID, kind: "other" };
    }
    this.lastInbox.set(sessionID, entry);

    // §60: a REAL user message resolves an in-flight BLOCKING wait early.
    // kind "user" excludes our own injected wakes and goalControl traffic —
    // only a human-typed message interrupts the wait. The resolving item's
    // identity rides the decision line (2026-10-26: three verify runs died
    // on an unidentified "user" resolution — the fingerprint must name it).
    if (entry.kind === "user") {
      const textPreview =
        typeof payload.text === "string" && payload.text !== ""
          ? payload.text.slice(0, 80)
          : JSON.stringify(item).slice(0, 120);
      void this.resolveWait(
        sessionID,
        { reason: "user" },
        `item type=${itemType ?? "?"} goalControl=${isControl} text="${textPreview}"`,
      );
    }

    // spec §15-9 blocked resume: blocked goal + user inbox item → active.
    // §55 (2026-10-24 ruling, 129 incident: one blocked goal was re-resumed
    // AND re-woken on every user message — 5 times in an hour):
    //  (1) ONLY an unfinished goal waiting on the user (status "blocked") is
    //      auto-resumed — terminal goals (completed / cleared / budget_limited
    //      / stalled) are NEVER touched by a user message;
    //  (2) NO immediate injected wake: the user message's own turn is the
    //      stimulus — the loop resumes at the next boundary under ordinary
    //      arbitration (which injects a wake if and only if the goal still
    //      needs one). The resume is logged as a state-change line
    //      (decision "resume"), not a "wake" line (the log invariant "line =
    //      a message actually in the queue" no longer applies — none is).
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
        await appendDecision({
          ts: new Date().toISOString(),
          sessionID,
          goalID: goal.id,
          own: 0,
          other: 0,
          ownKnown: true,
          decision: "resume",
          reason: "user message resumed blocked goal (§15-9/§55, no immediate wake)",
        });
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
   *   record-only like "user" (pinned in test/arbiter.test.ts; task13 closed
   *   2026-10-20).
   */
  private async onInterrupted(sessionID: string, event: HostEvent): Promise<void> {
    const props = event.properties;
    const reason = typeof props.reason === "string" ? props.reason : undefined;
    // §60: a turn interrupted while a BLOCKING wait hangs. Inactivity (explicit
    // evict) keeps the persisted waitUntil + the host-side clock shell ALIVE
    // — the reloaded instance's init re-arm / tick backfills the same wake;
    // any other interrupt (user Esc) ABANDONS the wait outright (kill the
    // clock shell, close the window).
    const wait = this.pendingWaits.get(sessionID);
    if (wait !== undefined) {
      if (reason === "inactivity") {
        this.pendingWaits.delete(sessionID);
        clearTimeout(wait.timer);
      } else {
        await this.resolveWait(sessionID, { reason: "cancelled" });
      }
    }
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
  /** In-flight signal for the gate (2026-10-17 shell-store ruling, 2026-10-19
   * query-based discovery, 2026-10-20 reference-UI criterion): the goal
   * session's OWN running shells, queried live from the host shell store
   * (location-scoped, running-only), plus its in-flight SUBTASK sessions —
   * attributed by query from the host session list (GET /api/session —
   * parentID chain; a subtask's execution events never reach this host, so
   * the event cache was blind to cross-host subtasks) and live while the
   * host's ACTIVE MAP (GET /api/session/active — the same sessionID→status
   * signal the host UI reads) says "running". The 1.1.3 time-field guess
   * (time.idle absent / idle < updated) is gone: dead sessions' time fields
   * go stale and counted them in-flight forever (the 129 zombie lock — 16
   * subtasks held the gate, every boundary held, no wakes). Query failure =
   * host context dead (2026-10-17 ruling): ownKnown false, NO fake count —
   * the caller logs and skips; reviving a dead session is not the plugin's
   * job. warn-once per session. */
  private async inFlightSignal(
    sessionID: string,
  ): Promise<{ own: number; other: number; queued: number; fg: number; ownKnown: boolean }> {
    let own = 0;
    let fg = 0; // §56: running shells that are ACTUALLY BLOCKING a turn (see below)
    let queued = 0;
    let ownKnown = true;
    let directory: string | undefined;
    try {
      const info = await this.probe.sessionGet(sessionID);
      directory = info?.location?.directory;
      if (directory !== undefined) {
        const running = (await this.probe.shellList(directory)).filter(
          (e) => e.sessionID === sessionID && e.status === "running",
        );
        own = running.length;
        // §56 (2026-10-24 host-contract forensics, oc-src + 129): the shell
        // store's `metadata.background` is UNRELIABLE — the model tool path
        // never writes it (fg AND bg model shells alike), server-fire writes
        // `true`, Ctrl+B / session.background never touch the store entry.
        // A shell BLOCKS the loop only while the session's turn is alive —
        // the host's own active map (the UI's running badge): blocking =
        // active map "running" ∧ a non-`background:true` shell of this
        // session is in the store. Idle session + running shell = background
        // item (normal 5-minute check-in semantics).
        // A failed active-map query degrades to "nothing blocking" (fail-open,
        // like the subtask query) — the shell query above still succeeded, so
        // this boundary proceeds instead of skipping.
        let active: Record<string, string> = {};
        try {
          active = await this.probe.activeSessions(directory);
        } catch {
          // host alive but the active-map query failed — assume not running
        }
        const sessionRunning = active[sessionID] === "running";
        fg = running.filter((e) => e.background !== true && sessionRunning).length;
      }
      // 2026-10-20 queued-input ruling: undelivered inbox items (queued user
      // messages, synthetic results, compaction/move control items — all
      // kinds, per the host contract "not yet delivered") gate the wake the
      // same way in-flight work does. A wake injected now would land IN THE
      // QUEUE behind the pending input (the 129 incident: a [GOAL] wake
      // observed queued behind the user's own message — violating the
      // invariant that a wake never appears in the queue). Every pending item
      // is delivered as the next execution, so the next boundary is
      // guaranteed: holding here can never silence the loop. The query lives
      // in the same try as the shell store: a failure means the host context
      // is dead → ownKnown=false → skip (fail-closed: an invisible queue must
      // not open the wake path).
      queued = (await this.probe.inboxList(sessionID)).length;
      this.shellQueryWarned.delete(sessionID); // a success re-arms the warn
    } catch (err) {
      ownKnown = false;
      if (!this.shellQueryWarned.has(sessionID)) {
        this.shellQueryWarned.add(sessionID);
        console.warn(
          `opencode-goal: in-flight signal query failed for ${sessionID} (session / shell store / inbox); the host context is dead — skipping this boundary:`,
          err,
        );
      }
    }
    // Subtask discovery (2026-10-19: query-based, not the event cache): a
    // subtask is a session in this project whose parentID chain walks back to
    // THIS session (the query is location-scoped, like the shell store); a
    // foreign session (a different task — e.g. the user's interactive session)
    // has no such link and is invisible to the gate.
    // 2026-10-20 reference-UI ruling: a subtask is in-flight while the host's
    // active map says "running" (the UI's own liveness signal — a zombie
    // session has no active entry); the time.idle/updated guess no longer
    // counts.
    let other = 0;
    if (ownKnown && directory !== undefined) {
      try {
        other = await this.countSubtasksInFlight(sessionID, directory);
      } catch {
        // host is alive (the shell query above succeeded) but the list/active
        // query failed: fail open (0 subtasks) — at worst this re-arms the check.
      }
    }
    return { own, other, queued, fg, ownKnown };
  }

  /** Count this session's in-flight subtasks (2026-10-20 reference-UI ruling):
   * a subtask is a session in this project whose `parentID` chain walks back
   * to `root`; it is in-flight while the host's ACTIVE MAP (GET
   * /api/session/active — the same sessionID→status signal the host UI reads
   * for its running badge) says "running" (a turn is executing right now —
   * including a turn waiting on a long shell/tool). An absent entry is
   * "idle" = NOT in flight: dead sessions have no active entry, so the 1.1.3
   * zombie lock (stale time fields counted them forever) is gone. Both
   * queries are location-scoped (like the shell store). Bounded 8-hop walk —
   * subagent depth is small. */
  private async countSubtasksInFlight(root: string, directory: string): Promise<number> {
    return (await this.listSubtasksInFlight(root, directory)).length;
  }

  /** §51: same query as countSubtasksInFlight, returning the in-flight subtask
   * session IDs (the check-in roster shows them by id). */
  private async listSubtasksInFlight(root: string, directory: string): Promise<string[]> {
    const [all, active] = await Promise.all([
      this.probe.sessionList(directory),
      this.probe.activeSessions(directory),
    ]);
    const parentOf = new Map<string, string | undefined>();
    for (const s of all) parentOf.set(s.id, s.parentID);
    const isSubtask = (id: string): boolean => {
      let cur = parentOf.get(id);
      for (let hop = 0; cur !== undefined && hop < 8; hop++) {
        if (cur === root) return true;
        cur = parentOf.get(cur);
      }
      return false;
    };
    const out: string[] = [];
    for (const s of all) {
      if (s.id === root) continue;
      if (!isSubtask(s.id)) continue;
      if (active[s.id] === "running") out.push(s.id);
    }
    return out;
  }

  /** §51 (2026-10-21 ruling): the check-in roster — ids + elapsed, UNCAPPED,
   * NO command text (the model must not re-query to learn what is in flight).
   * Fresh query at fire time: this session's running shells (host shell
   * store: id + time.started → elapsed) + in-flight subtask sessions (active
   * map). ANY query failure → undefined (count-only fallback — the check-in
   * itself must never be lost over its attachment). */
  private async inFlightRoster(sessionID: string): Promise<string[] | undefined> {
    try {
      const info = await this.probe.sessionGet(sessionID);
      const directory = info?.location?.directory;
      if (directory === undefined) return undefined;
      const now = Date.now();
      const elapsed = (started: number): string => {
        const s = Math.max(0, Math.floor((now - started) / 1000));
        const m = Math.floor(s / 60);
        return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
      };
      const items: string[] = [];
      const [shellsRaw, active] = await Promise.all([
        this.probe.shellList(directory),
        this.probe.activeSessions(directory),
      ]);
      const shells = shellsRaw.filter((e) => e.sessionID === sessionID && e.status === "running");
      for (const sh of shells) {
        // §56: kind = effective blocking state — a `background: true` entry
        // (server-fired) is always bg; anything else blocks only while the
        // session's own turn is alive (active map). At fire time the session
        // is idle (the guard discards a blocked turn), so this is normally bg.
        const kind = sh.background === true || active[sessionID] !== "running" ? "bg" : "fg";
        items.push(
          sh.time?.started !== undefined
            ? `${sh.id} (${kind}, ${elapsed(sh.time.started)})`
            : `${sh.id} (${kind})`,
        );
      }
      for (const id of await this.listSubtasksInFlight(sessionID, directory)) {
        items.push(`${id} (subtask)`);
      }
      return items;
    } catch {
      return undefined; // host context dead → count-only text
    }
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
        // execution.started yet). Within the window the first boundary is
        // expected to be a same-turn-end sibling (field-observed as
        // execution.succeeded → session.idle, ms apart — but the 2026-10-20
        // probe on an isolated 2.0.32 host captured a normal turn end with
        // ONLY execution.succeeded: no session.idle within 30s, so the
        // session.idle path is defensive). Bounded fallback (controller
        // ruling I1): skip at most ONE,
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
            bumpGoalDecision(goal, "skip");
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
      if (goal.budgetGrace) {
        // §49: post-resume budget grace — a goal resumed from budget_limited
        // consumes ONE boundary budget re-check. The resume command's own
        // result line kicks a real turn (host auto-wake, §48-B); without the
        // grace, that kick turn's boundary would immediately re-limit the
        // just-resumed goal (caps still exhausted), making /goal resume a
        // no-op. The grace is consumed here (one-shot) and the boundary falls
        // through to normal arbitration — the kicked turn proceeds.
        goal.budgetGrace = false;
        bumpGoalDecision(goal, "hold");
        await appendDecision({
          ts: new Date().toISOString(),
          sessionID,
          goalID: goal.id,
          own: 0,
          other: 0,
          ownKnown: true,
          decision: "hold",
          reason: `post-resume budget grace consumed (resumed from budget_limited; cap: ${this.capText(goal)})`,
        });
      } else {
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
            resume: false, // §48: terminal notice = record, not a host auto-wake
          });
        } catch (err) {
          console.warn(`opencode-goal: failed to deliver budget_limited notice for goal ${goal.id}:`, err);
        }
        this.markTurnInactive(sessionID);
        this.rememberHandled(eventID);
        return;
      }
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
        bumpGoalDecision(goal, "paused");
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
              resume: false, // §48: pause notice = record, not a host auto-wake
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
    // parentID chain, see inFlightSignal/countSubtasksInFlight).
    // 2026-10-20 reference-UI ruling: a subtask is in-flight while the host's
    // active map (the UI's own signal) says "running" — dead sessions have no
    // active entry, so zombies can no longer hold the gate.
    // Foreign sessions — different tasks (the user's interactive session, a
    // separate campaign) — NEVER gate this goal's loop, and never appear in
    // the check-in count (no more fake "background items in flight"). Two
    // exceptions keep normal
    // arbitration: (a) the last inbox item is one of OUR watchdog wakes AND
    // nothing is queued — spec §7.1: a check-in replied with pure text counts
    // per the stall ladder; a QUEUED user message always wins over (a) (the
    // wake would land in the queue behind it — 2026-10-20 re-review, C1);
    // (b) goal_wait's waitUntil window silences the boundary (no wake, no
    // check-in arm, no stall accounting — "不消耗 stall 预算"). §57 (2026-10-24):
    // the window's DEADLINE is itself a wake source — the watchdog tick fires
    // the one-shot "Goal wait period ended" wake at waitUntil (runWatchdogTick);
    // the window only silences the moments BEFORE it.
    const { own, other, queued, fg, ownKnown } = await this.inFlightSignal(sessionID);
    // Gate = own running shells + attributed subtask sessions (2026-10-18
    // amended ruling) + queued undelivered inbox input (2026-10-20 ruling: a
    // wake would land IN THE QUEUE behind the pending input). The decision
    // log carries `other` (subtasks) and `queued` as separate fields; the
    // check-in count/text stays background-only (`inFlight`).
    const inFlight = own + other;
    const gate = inFlight + queued;
    if (!ownKnown) {
      // Query failure = the host context is dead (2026-10-17 ruling): log +
      // skip — no wake, no check-in arm, no stall accounting. Reviving a dead
      // session is not the plugin's job; the human reads the log.
      bumpGoalDecision(goal, "skip");
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
    if (gate > 0) {
      // §54 (2026-10-22 ruling): the session is BLOCKED ON ITS OWN FOREGROUND
      // SHELL — its turn is stuck on the tool call, so a progress check-in
      // could not be delivered anyway (it would only queue behind the turn,
      // mislabeled as "background items"). Silence: no check-in arm, and NOT
      // the (a) exception below (a fabricated boundary must not straight-wake
      // either). What moves the loop: the shell completing, or the §52 scan
      // converting it to background at the cap (which delivers its own
      // immediate notice).
      if (fg > 0) {
        bumpGoalDecision(goal, "hold");
        await appendDecision({
          ts: new Date().toISOString(),
          sessionID,
          goalID: goal.id,
          own,
          other,
          queued,
          fg,
          ownKnown: true,
          decision: "hold",
          reason: "foreground shell blocked (no check-in arm)",
        });
        this.markTurnInactive(sessionID);
        await this.recordHandled(sessionID, eventID, goal);
        return;
      }
      // An ACTIVE provider pause silences the progress check like goal_wait's
      // waitUntil window (a check-in wake during either is a doomed turn).
      const pauseActive = goal.providerPause !== undefined && Date.now() < goal.providerPause.until;
      const quiet = (goal.waitUntil !== undefined && Date.now() < goal.waitUntil) || pauseActive;
      const last = this.lastInbox.get(sessionID);
      const lastWatchdog = last !== undefined && last.kind === "wake" && last.watchdog === true;
      // 2026-10-20 re-review (finding C1): the (a) exception also yields to a
      // QUEUED input — with undelivered inbox items the reply must HOLD (the
      // wake would land in the queue behind the user's own message — the 129
      // invariant). The check-in re-arms below: it stays the §42 escape valve
      // for parked input.
      if (quiet || !lastWatchdog || queued > 0) {
        if (!quiet) {
          // Not quiet: arm the one-shot progress check. The clock only runs
          // while the session is quiet — any activity cancels it, and the next
          // in-flight boundary re-arms (fresh countdown).
          this.checkinDue.set(sessionID, {
            due: Date.now() + this.options.checkInDelaySec * 1000,
            inFlight,
          });
          this.ensureWatchdog(sessionID); // the tick is the deadline's heartbeat
          // §58: mirror the deadline into the goal record and SAVE IT NOW —
          // an explicit save: the hold path's recordHandled save is conditional
          // on the event carrying an ID (session.idle is ID-less / ephemeral on
          // 2.1.4), so a piggybacked mirror would silently die with the
          // instance — which is exactly the overnight loss this field exists
          // to prevent.
          goal.checkinDue = this.checkinDue.get(sessionID);
          await this.saveGoal(goal);
        }
        bumpGoalDecision(goal, "hold");
        await appendDecision({
          ts: new Date().toISOString(),
          sessionID,
          goalID: goal.id,
          own,
          other,
          queued,
          ownKnown: true,
          decision: "hold",
          reason: quiet
            ? "in-flight, quiet window"
            : queued > 0 && inFlight === 0
              ? "queued input (check-in armed)"
              : "in-flight (check-in armed)",
        });
        this.markTurnInactive(sessionID);
        await this.recordHandled(sessionID, eventID, goal);
        return;
      }
      // (a) reply to OUR watchdog wake with NOTHING queued: normal arbitration
      // (stall ladder). With queued > 0 the hold above already returned.
    }
    // §59 (2026-10-25, 129 ruling): the goal_wait window silences the boundary
    // on EVERY gate shape — gate>0 holds in the branch above, gate=0 is the
    // STORM shape (the model just called goal_wait and its turn ends with
    // nothing in flight): it previously fell straight through to the wake,
    // and every idle boundary re-woke the model, which re-called goal_wait —
    // 25 continuations in ~2 minutes on 129 (g_mvnd5hk9_2). The window's
    // DEADLINE owns that moment: the §57 tick fires the one-shot "Goal wait
    // period ended" wake at waitUntil. Hold: no wake, no stall accounting
    // (不消耗 stall 预算), no check-in arm.
    if (gate === 0 && goal.waitUntil !== undefined && Date.now() < goal.waitUntil) {
      bumpGoalDecision(goal, "hold");
      await appendDecision({
        ts: new Date().toISOString(),
        sessionID,
        goalID: goal.id,
        own,
        other,
        queued,
        ownKnown: true,
        decision: "hold",
        reason: `quiet window (goal_wait until ${new Date(goal.waitUntil).toISOString()})`,
      });
      this.markTurnInactive(sessionID);
      await this.recordHandled(sessionID, eventID, goal);
      return;
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
      bumpGoalDecision(goal, "wake");
      await appendDecision({
        ts: new Date().toISOString(),
        sessionID,
        goalID: goal.id,
        own,
        other,
        queued,
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
        // 2026-10-20: the wake has ONE format (the objective/progress
        // re-statement is gone — it is the model's own tool-generated data).
        text: buildWakeMessage(goal, judgeInstruction, this.options.wakeText),
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
   * ④ goalStatus is OUR fact (storage lookup), never host input (R9);
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
      const decision = decidePermission({
        action: input.action,
        resources: input.resources,
        sessionDirectory: session?.location?.directory ?? this.probe.locationDirectory,
        // Control plane keys off goal existence (any status); the data plane
        // (path containment) engages only for "active" (2026-10-18 ruling).
        goalStatus: goal?.status,
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
        // §48 (2026-10-20): terminal/pause notices are RECORDS. The host
        // auto-wakes every synthetic (default steer + execution.wake), which
        // would kick a spurious model turn after every terminal transition —
        // resume:false suppresses it (the record still lands in the transcript).
        resume: false,
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

  /**
   * §57/§58: the reload-tolerant start-time re-arm. Scan the persisted goals
   * and ensure a running tick for every ACTIVE goal with a pending deadline
   * wake: a goal_wait window (unfired — including an EXPIRED one that lost
   * its delivery across the reload), an unexpired providerPause (the tick is
   * the retry's heartbeat), and — §58 — a PERSISTED check-in deadline
   * (restored into memory; a past-due one fires on the first tick: the exact
   * overnight incident — the deadline armed before the 01:03 location
   * reboot must still land). Fire-and-forget at start(): a failed scan is
   * non-fatal — the next boundary re-arms the ordinary way, and the §58
   * orphan sweep (liveness clock) backfills anything this misses.
   */
  private async initRearm(): Promise<void> {
    try {
      const entries = await this.probe.storageScan("goal/");
      const now = Date.now();
      let scanned = 0;
      let rearmed = 0;
      for (const e of entries) {
        scanned++;
        const goal = e.value as GoalRecord | undefined;
        if (goal === undefined || goal.status !== "active") continue;
        let rearm = false;
        if (goal.checkinDue !== undefined) {
          // §58 restore-OR-deliver: the deadline's premise is "the session
          // has been quiet while this work was in flight". After a reload the
          // work may have DIED in the downtime (the overnight incident — a
          // background process cannot survive a machine sleep + restart) —
          // with in-flight work GONE the deadline is stale by definition, and
          // restoring it would be fatal: the loop's ordinary gate-0 boundary
          // WAKES (the work is no longer gating), and the wake's
          // execution.started CANCELS the pending deadline — it could never
          // fire. So: work still visible → restore (the tick owns the
          // deadline); work gone (or unknown — fail toward waking) → deliver
          // the check-in NOW (late, but the model must find out what happened
          // to what it was waiting on).
          const cd = goal.checkinDue;
          if (cd.inFlight === 0) {
            goal.checkinDue = undefined; // a queued-input arm — nothing to report
            await this.saveGoal(goal);
          } else {
            const sig = await this.inFlightSignal(goal.sessionID);
            if (sig.ownKnown && sig.own + sig.other > 0) {
              this.checkinDue.set(goal.sessionID, cd); // work survived — the deadline is meaningful
              rearm = true;
            } else {
              goal.checkinDue = undefined;
              await this.saveGoal(goal); // consumed (clear-then-deliver)
              await this.deliverWatchdogWake(
                goal,
                backgroundCheckInText(cd.inFlight, this.options.checkInDelaySec, await this.inFlightRoster(goal.sessionID)),
                `watchdog check-in (in-flight ${cd.inFlight}, late — delivered on reload, work gone or unqueryable)`,
              );
            }
          }
        }
        const waitPending = goal.waitUntil !== undefined && goal.waitWakeSent !== true;
        const pausePending = goal.providerPause !== undefined && now < goal.providerPause.until;
        if (waitPending || pausePending) rearm = true;
        if (rearm) {
          this.ensureWatchdog(goal.sessionID);
          rearmed++;
          console.warn(
            `opencode-goal: init re-arm for ${goal.sessionID} — persisted deadline(s) survived the reload (checkinDue: ${goal.checkinDue ? String(goal.checkinDue.due) : "-"}, waitUntil: ${goal.waitUntil ?? "-"}, providerPause: ${goal.providerPause?.until ?? "-"})`,
          );
        }
      }
      // Always summarize (even 0): silence meant "scan saw nothing" — the
      // 2026-10-25 P6 failure needed exactly that distinction.
      console.warn(`opencode-goal: init re-arm scan — ${scanned} persisted goal record(s), ${rearmed} re-armed`);
    } catch (err) {
      console.warn(`opencode-goal: init re-arm scan failed:`, err);
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
      // §54 defense in depth: if the deadline was armed before a foreground
      // shell started (an edge the event path makes rare), it STILL cannot be
      // delivered to a blocked turn — discard it; the shell's end boundary
      // re-arms a fresh check.
      if ((await this.blockingShellIds(sessionID)).length > 0) {
        this.checkinDue.delete(sessionID);
        goal.checkinDue = undefined; // §58: persist the discard (no delivery follows)
        await this.saveGoal(goal);
        console.warn(
          `opencode-goal: §54 check-in deadline discarded for ${sessionID} — its turn is blocked on a foreground shell`,
        );
      } else {
        this.checkinDue.delete(sessionID); // one-shot: consumed on fire
        // §58: clear-then-deliver (providerPause-retry pattern): the record is
        // cleared before delivery, so a reload cannot re-fire the consumed
        // deadline; a delivery LOST mid-reload is backfilled by the §58
        // orphan sweep (in-flight work is still visible), never double-fired.
        goal.checkinDue = undefined;
        await this.deliverWatchdogWake(
          goal,
          backgroundCheckInText(due.inFlight, this.options.checkInDelaySec, await this.inFlightRoster(sessionID)),
          `watchdog check-in (in-flight ${due.inFlight})`,
        );
      }
    }
    // §60: BLOCKING wait in flight — sense its completion from the host shell
    // store (the event path covers server-fired shells immediately; MODEL-
    // originated shells emit no events at all, §56, so the store scan is
    // THEIR completion sensor). Tracked shell gone → early "shell" return;
    // clock shell gone off-schedule → killed. (JS timer + persisted
    // waitUntil remain the fallbacks; a store-query failure skips the scan.)
    const pendingWait = this.pendingWaits.get(sessionID);
    if (pendingWait !== undefined) {
      let current: Set<string> | undefined;
      try {
        const session = await this.probe.sessionGet(sessionID);
        const directory = session?.location?.directory ?? this.probe.locationDirectory;
        if (directory !== undefined) {
          current = new Set((await this.probe.shellList(directory)).map((s) => s.id));
        }
      } catch {
        current = undefined;
      }
      if (current !== undefined) {
        if (pendingWait.shellID !== "" && !current.has(pendingWait.shellID)) {
          void this.resolveWait(sessionID, {
            reason: now >= pendingWait.due - 2000 ? "deadline" : "cancelled",
            shellID: pendingWait.shellID,
          });
        } else {
          for (const id of pendingWait.shells) {
            if (!current.has(id)) {
              void this.resolveWait(sessionID, { reason: "shell", shellID: id });
              break;
            }
          }
        }
      }
    }
    // §57 (2026-10-24 ruling): the goal_wait DEADLINE is a wake source. The
    // one-shot "wait period ended" wake fires UNCONDITIONALLY — no idle gate,
    // no quiet gate: a fully-idle session is exactly the parked case it must
    // rescue (the 2026-10-24 local incident: quiet hold + a reload killed the
    // only running timer, and nothing owned the waitUntil deadline). The
    // marker is PERSISTED before delivery (providerPause-retry pattern): a
    // reload cannot double-fire it, and a new goal_wait resets it. §60: while
    // a BLOCKING wait is in flight the tick SKIPS this delivery — the tool
    // return itself is the wake (its resolution persists waitWakeSent=true,
    // or clears the window on early exit). After a reload pendingWaits is
    // empty and this line is exactly the backfill.
    if (
      goal.waitUntil !== undefined &&
      now >= goal.waitUntil &&
      goal.waitWakeSent !== true &&
      this.pendingWaits.get(sessionID) === undefined
    ) {
      goal.waitWakeSent = true;
      await this.saveGoal(goal);
      await this.deliverWatchdogWake(goal, goalWaitExpiryText(goal.id, goal.waitMinutes), "watchdog goal_wait expiry");
    }
    // Provider pause deadline reached → fire ONE retry wake (retrySent: the
    // watchdog may stay alive across the deadline — a surviving pending
    // check-in blocks the disarm — and every tick must not re-fire). The
    // pause record is NOT cleared here: the retry's boundary is what resolves
    // it (errored → re-arm with a FRESH record, which resets retrySent for
    // the new window; clean → clear).
    if (
      goal.providerPause !== undefined &&
      now >= goal.providerPause.until &&
      goal.providerPause.retrySent !== true
    ) {
      goal.providerPause.retrySent = true;
      await this.saveGoal(goal);
      await this.deliverWatchdogWake(goal, providerPauseRetryText(goal.id), "watchdog provider-pause retry");
    }
    // Disarm only when nothing is pending: no deadline, no UNEXPIRED provider
    // pause (while armed, this tick IS the retry heartbeat), and no goal_wait
    // window whose deadline wake has not fired yet (§57 — while armed, this
    // tick is THAT heartbeat: a future window must still fire, an expired
    // unfired one must still deliver).
    if (
      this.checkinDue.get(sessionID) === undefined &&
      (goal.providerPause === undefined || now >= goal.providerPause.until) &&
      (goal.waitUntil === undefined || goal.waitWakeSent === true)
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
  private async deliverWatchdogWake(
    goal: GoalRecord,
    text: string,
    reason: string,
    delivery: "steer" | "queue" = "queue",
  ): Promise<void> {
    // Task 14 Fix 3a note: this wake path (check-in / shell exit / lost) uses
    // its own watchdog text family — options.wakeText intentionally does NOT
    // apply here (ruling: check-in wakes are independent copy).
    // 2026-10-27 ruling (129 incident): delivery is now a parameter. Most
    // watchdog wakes target an IDLE (stopped) session → "queue" is correct
    // (default). The §54 auto-background notice is the exception: it is
    // injected at the step boundary when session.background releases the
    // blocked turn, while the session is still BUSY (the model proceeds into
    // goal_wait / keeps working) — "queue" would park it forever, so it uses
    // "steer" (verified live on 2.2.0: probe-steer2.ts).
    const sessionID = goal.sessionID;
    goal.used.turns += 1;
    goal.continuations += 1;
    try {
      const ref = await this.probe.prompt({
        sessionID,
        text,
        delivery,
        metadata: { goalControl: true },
      });
      this.lastInbox.set(sessionID, { id: ref.id, kind: "wake", goalID: goal.id, watchdog: true });
      this.wakeInbox.set(sessionID, { inboxID: ref.id, goalID: goal.id, watchdog: true });
      this.contPending.set(sessionID, Date.now());
      this.pendingSkipped.delete(sessionID);
      await this.saveGoal(goal);
      // 2026-10-20 (129 forensics): the watchdog path was the ONE message
      // injection that left no decision log line — a queued wake the user
      // removed was unexplainable from the server side. The line = "a message
      // actually in the queue" (the prompt succeeded). Logged AFTER the save,
      // never between the tick's load and save: an fs write in that window
      // widens the CAS race and can cost a boundary its increments.
      await appendDecision({
        ts: new Date().toISOString(),
        sessionID,
        goalID: goal.id,
        ownKnown: true,
        decision: "watchdog",
        reason,
      });
    } catch (err) {
      // Fault tolerance: a failed injection must not break the loop and must
      // not leave the continuationPending window open forever.
      console.warn(`opencode-goal: failed to deliver watchdog wake for goal ${goal.id}:`, err);
      this.contPending.delete(sessionID);
    }
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
    // §49-rev (2026-10-21): every USER command result line kicks — 2.1.1 hosts
    // do not render resume:false record lines in the UI (verified: they stay
    // in session_inbox, never promoted to session_message), so a pure record
    // is invisible to the person who typed the command. The model's one-line
    // reply IS the visible output. Machine-originated notices (terminal/
    // pause, §48) keep resume:false — no human is waiting for those.
    let kick = true;
    try {
      const res = await this.dispatchCommand(sessionID, text);
      out = res.text;
      kick = res.kick;
    } catch (err) {
      out = `goal command failed: ${err instanceof Error ? err.message : String(err)}`;
      kick = true; // an escaped error is user-facing feedback too
    }
    try {
      // LastInbox attribution (spec §6-⑤): every goal command reply is a
      // goalControl synthetic. Set it BEFORE the synthetic so the host's
      // auto-wake turn (the set/resume result line kicks a turn, §48-B)
      // arbitrates against a control lastInbox (no stall, no re-wake) — the
      // admitted control message IS that turn's last inbox item in the real
      // host. (The harness emits no inbox.enqueued echo for probe.synthetic,
      // so the plugin records its own delivery.)
      this.lastInbox.set(sessionID, { id: "control", kind: "control" });
      await this.probe.synthetic({
        sessionID,
        text: out,
        metadata: { goalControl: true },
        // §48-#2: set/resume kick (their result line is the trigger, §47); every
        // other subcommand's result line is a pure record — resume:false stops
        // the host's synthetic auto-wake from kicking a spurious model turn.
        resume: kick ? undefined : false,
      });
    } catch (err) {
      // Best-effort delivery (fault-tolerance discipline).
      console.warn("opencode-goal: failed to deliver goal feedback:", err);
    }
  }

  private async dispatchCommand(
    sessionID: string,
    text: string,
  ): Promise<{ text: string; kick: boolean }> {
    let tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);
    // Accept both the full "/goal set ..." form and the host-routed remainder
    // "set ..." (the host strips the command name before calling us).
    if (tokens[0] === "/goal" || tokens[0] === "goal") tokens = tokens.slice(1);
    if (tokens.length === 0) return { text: USAGE, kick: true };
    const [sub, ...rest] = tokens;
    // §48-#2 / §49-rev (2026-10-21): EVERY user command result line kicks —
    // the model's reply is the only user-visible output on hosts that do not
    // render resume:false record lines (2.1.1, verified 2026-10-21). Success,
    // refusal, and error lines alike; machine notifications keep resume:false
    // (§48, unchanged — they are emitted by the loop, not by a command).
    switch (sub) {
      case "set":
        const set = await this.cmdSet(sessionID, rest);
        return { text: set.text, kick: true };
      case "resume":
        const resumed = await this.resumeGoal(sessionID);
        return { text: resumed.text, kick: true };
      case "view":
        return { text: await this.viewGoal(sessionID), kick: true };
      case "pause":
        return { text: await this.pauseGoal(sessionID), kick: true };
      case "complete":
        if (rest.length === 0) return { text: "missing evidence: /goal complete <evidence>", kick: true };
        return { text: await this.completeGoal(sessionID, rest.join(" ")), kick: true };
      case "block":
        if (rest.length === 0) return { text: "missing reason: /goal block <reason>", kick: true };
        return { text: await this.blockGoal(sessionID, rest.join(" ")), kick: true };
      case "clear":
        return { text: await this.clearGoalFromCommand(sessionID), kick: true };
      case "history":
        return { text: await this.historyGoal(sessionID), kick: true };
      case "task":
        return { text: await this.cmdTask(sessionID, rest), kick: true };
      default:
        return { text: `unknown goal subcommand: "${sub}" — ${USAGE}`, kick: true };
    }
  }

  private async cmdSet(sessionID: string, tokens: string[]): Promise<{ text: string; ok: boolean }> {
    const objectiveParts: string[] = [];
    let turns: number | undefined;
    let tokenCap: number | undefined;
    let unbounded = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "--turns") {
        const v = tokens[++i];
        if (v === undefined) return { text: `--turns expects a positive integer value`, ok: false };
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return { text: `--turns expects a positive integer (got "${v}")`, ok: false };
        turns = n;
      } else if (t === "--tokens") {
        const v = tokens[++i];
        if (v === undefined) return { text: `--tokens expects a positive integer value`, ok: false };
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return { text: `--tokens expects a positive integer (got "${v}")`, ok: false };
        tokenCap = n;
      } else if (t === "--unbounded") {
        unbounded = true;
      } else if (t.startsWith("--")) {
        return { text: `unknown flag "${t}" — expected --turns, --tokens or --unbounded`, ok: false };
      } else {
        objectiveParts.push(t);
      }
    }
    const objective = objectiveParts.join(" ");
    if (objective === "") return { text: "missing objective: /goal set <objective> [--turns N] [--tokens N] [--unbounded]", ok: false };
    // 2026-10-27 ruling: goal creation defaults to NO budget — a cap only
    // ever comes from explicit input (--turns/--tokens; unbounded = {}).
    // (defaultCapTurns/defaultCapTokens options removed: 129's configured
    // default silently ended a long goal at turn 10.)
    const cap: GoalRecord["cap"] = unbounded
      ? {}
      : {
          turns,
          tokens: tokenCap,
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
    // 2026-10-27 ruling: goal creation defaults to NO budget — a cap only
    // ever comes from explicit input (--turns/--tokens; unbounded = {}).
    // (defaultCapTurns/defaultCapTokens options removed: 129's configured
    // default silently ended a long goal at turn 10.)
    const cap: GoalRecord["cap"] = unbounded
      ? {}
      : {
          turns,
          tokens: tokenCap,
        };
    return (await this.setGoal(sessionID, rec.objective, cap)).text;
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

  private async toolNextStep(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    if (typeof rec.text !== "string" || rec.text.trim() === "") {
      return 'goal_next_step: "text" is required and must be a non-empty string';
    }
    return this.nextStepUpdate(sessionID, rec.text);
  }

  private async toolWait(sessionID: string, input: unknown): Promise<string> {
    const rec = isPlainObject(input) ? input : {};
    const minutes = rec.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      return `goal_wait: "minutes" must be an integer between 1 and 60 (got ${String(minutes)})`;
    }
    // §60: default = BLOCKING (the call hangs this turn until the deadline or
    // an early-return event); background = the §57/§59 loop-held window
    // (returns immediately; the loop re-wakes at the deadline).
    return rec.background === true ? this.waitGoal(sessionID, minutes) : this.waitGoalBlocking(sessionID, minutes);
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
   * Every save bumps updatedAt (Task 1 ruling). Storage write = best-effort for the
    * loop itself, but a FAILED set is reported (returns false), never silent.
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
   * @returns true = written, false = dropped as stale OR the storage set
    *   failed (2026-10-20 fail-closed: a failed set is not a write — callers
    *   on command/tool surfaces refuse with "changed underneath").
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
      // fail-closed (2026-10-20, 129 incident): a write that never reached
      // storage must never be reported as written — the command/tool
      // surfaces (finishGoal, nextStepUpdate) turn this false into their
      // "changed underneath" refusal instead of a false success.
      return false;
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

  private async setGoal(
    sessionID: string,
    objective: string,
    cap: GoalRecord["cap"],
  ): Promise<{ text: string; ok: boolean }> {
    const existing = await this.loadGoal(sessionID);
    if (existing !== undefined && !isTerminal(existing.status)) {
      // Ruling R7 (spec §9): a refused set must NOT touch the old goal — no
      // status change, no updatedAt bump, no archive write. The old goal is
      // terminated first (complete/block/clear), then a new set succeeds.
      return {
        text:
          `goal ${existing.id} is still in progress (status: ${existing.status}): ` +
          `complete, block or clear it before starting a new goal (${objective}).`,
        ok: false,
      };
    }
    const goal = createGoal({ sessionID, objective, cap });
    this.judgeInstruction.delete(sessionID); // new goal: stale instruction must not leak over
    await this.saveGoal(goal);
    return { text: `goal ${goal.id} created: ${objective} (cap: ${this.capText(goal)})`, ok: true };
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

  private async resumeGoal(sessionID: string): Promise<{ text: string; ok: boolean }> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return { text: "no active goal for this session", ok: false };
    if (goal.status === "active") return { text: `goal ${goal.id} is already active`, ok: false };
    // Resumable: paused (existing), blocked (spec §15-9 — the command entry
    // beside the user-message resume) and budget_limited (spec §11: 可 resume
    // 续跑 — the cap is still enforced at the next boundary, so resuming
    // without raising it re-terminates on the next boundary). completed /
    // stalled / cleared stay hard-terminal.
    if (goal.status !== "paused" && goal.status !== "blocked" && goal.status !== "budget_limited") {
      return { text: `goal ${goal.id} is not resumable (status: ${goal.status})`, ok: false };
    }
    const wasBlocked = goal.status === "blocked";
    const wasBudgetLimited = goal.status === "budget_limited";
    goal.status = "active";
    if (wasBlocked || wasBudgetLimited) {
      goal.stalls = 0;
      if (wasBlocked) {
        // 2026-10-18 (129 incident, same ruling as the user-message path): a
        // resumed goal must not keep carrying its stale blocker.
        goal.blocker = undefined;
      }
      if (wasBudgetLimited) {
        // §49: the resume command's own result line kicks a real turn (host
        // auto-wake); grant the one-shot budget grace so that kick turn does
        // not immediately re-limit the just-resumed goal.
        goal.budgetGrace = true;
      }
    }
    // 2026-10-20 ruling (129 "double message" incident): NO explicit re-wake.
    // The command face's result line (a goalControl synthetic) is admitted by
    // the host as steer + execution.wake, so it already kicks the turn; the
    // tool face runs mid-turn (the model is already executing). An injected
    // re-wake was a redundant SECOND execution-capable message (a queued turn
    // the user had to delete). The normal boundary re-wakes at the next turn
    // end when the goal is active.
    await this.saveGoal(goal);
    return { text: `goal ${goal.id} resumed (active)`, ok: true };
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

  /**
   * Records the model's next-step plan (2026-10-20 ruling — goal_next_step):
   * the woken turn's first act (commanded by the wake text) writes it; the
   * next boundary wake replays it (see buildWakeMessage). `turn` = the goal's
   * used-turn count at write time (coarse recency label for the replay line).
   */
  private async nextStepUpdate(sessionID: string, text: string): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) {
      return "no active goal for this session — call goal_set first (only when the user explicitly asks for a goal)";
    }
    if (goal.status === "active") {
      goal.nextStep = { text, turn: goal.used.turns, ts: Date.now() };
      if (!(await this.saveGoal(goal))) return this.changedUnderneath(goal);
      return `next step recorded for goal ${goal.id} (turn ${goal.used.turns})`;
    }
    if (goal.status === "cleared") {
      // The user's explicit discard is never overridden by a model call.
      return `goal ${goal.id} was explicitly cleared — it stays terminal; if the user wants goal-managed work, ` +
        `call goal_set with a new objective`;
    }
    if (goal.status === "budget_limited") {
      // An explicit cap was hit — raising the budget is a user decision.
      return `goal ${goal.id} is budget_limited (used ${goal.used.turns} turns / ${goal.used.tokens} tokens; ` +
        `cap: ${this.capText(goal)}) — it stays terminal; if the user wants to continue, call goal_set with a larger budget`;
    }
    // completed / paused / blocked / stalled → REACTIVATION (2026-10-20 ruling):
    // a fresh phase of the SAME goal. Terminal goals are never woken, so this
    // branch is only reachable on a user-driven turn — each reactivation is
    // gated by an external event, and the fresh phase runs under the same cap.
    const from = goal.status;
    if (goal.evidence !== undefined) {
      goal.evidenceHistory = [...(goal.evidenceHistory ?? []), { evidence: goal.evidence, at: goal.updatedAt }];
      goal.evidence = undefined;
    }
    goal.status = "active";
    goal.used = { turns: 0, tokens: 0 }; // fresh phase: full budget again (cap unchanged)
    goal.stalls = 0;
    goal.waitUntil = undefined; // a stale goal_wait window belonged to the old phase — the new
    // phase must not inherit its silence (or the "loop resumes" lie lasts up to 60 min)
    goal.blocker = undefined; // a stale blocker must not ride the new phase (same discipline as resume)
    goal.reactivation = { from, at: Date.now() };
    goal.nextStep = { text, turn: 0, ts: Date.now() };
    if (!(await this.saveGoal(goal))) return this.changedUnderneath(goal);
    return `goal ${goal.id} reactivated (was ${from}); next step recorded (turn 0) — the loop resumes`;
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
    // §57: a new window is a NEW one-shot — reset the fired marker so this
    // window's deadline gets its wake even if a previous one already did.
    goal.waitWakeSent = false;
    goal.waitMinutes = minutes;
    await this.saveGoal(goal);
    // §57: the deadline wake is owned by the TICK — arm it at call time. The
    // old "record-only" semantics (nothing re-armed a tick for waitUntil) let
    // a fully-idle session sleep past its own deadline forever (the 2026-10-24
    // local incident); a quiet boundary arms nothing, and a plugin reload
    // kills any running timer, so the call itself must own its heartbeat.
    this.ensureWatchdog(sessionID);
    return (
      `goal ${goal.id} will not be woken for ${minutes} minutes (until ${new Date(waitUntil).toISOString()}); ` +
      `at the deadline the loop re-wakes you with a "Goal wait period ended" notice`
    );
  }

  // ------------------------------------------------------------------
  // §60 (2026-10-26 ruling): goal_wait is an ASYNC wait primitive. The
  // default (background=false) BLOCKS the calling turn: the handler hangs
  // on a promise that resolves from an EVENT (user message / shell exit /
  // kill) or the JS fallback timer, while a host-side `sleep` shell ticks
  // away in the shell store (survives plugin reload + machine sleep,
  // visible and killable — the kill IS the cancellation). The persisted
  // waitUntil (§57) is the reload fallback for the same deadline.
  // ------------------------------------------------------------------

  /** §60: one-shot resolution of a pending BLOCKING wait. Safe to call from
   * event handlers, the tick store scan, the fallback timer, and interrupts:
   * whoever deletes the entry first wins, later calls are no-ops. */
  private async resolveWait(
    sessionID: string,
    r: { reason: "deadline" | "user" | "shell" | "cancelled"; shellID?: string; exit?: number },
    detail?: string,
  ): Promise<void> {
    const wait = this.pendingWaits.get(sessionID);
    if (wait === undefined) return; // another resolution won the race
    this.pendingWaits.delete(sessionID);
    clearTimeout(wait.timer);
    // Persistence settlement: the BLOCKING wait's clock is the HOST shell; the
    // persisted waitUntil is only the RELOAD fallback. Early exit → the window
    // is over (clear waitUntil: releases the quiet gate, no ghost deadline).
    // Deadline → the one-shot marker CONSUMES the tick's deadline delivery
    // (the tool return itself is the wake — a tick delivery would double-stimulus).
    try {
      const goal = await this.loadGoal(sessionID);
      if (goal !== undefined && goal.waitUntil !== undefined) {
        if (r.reason === "deadline") {
          goal.waitWakeSent = true;
        } else {
          goal.waitUntil = undefined;
          goal.waitWakeSent = undefined;
        }
        await this.saveGoal(goal);
      }
    } catch (err) {
      console.warn(`opencode-goal: §60 wait settlement save failed for ${sessionID}:`, err);
    }
    // End the clock shell when we leave the wait EARLY (at the deadline the
    // sleep already ran out; killing it would 404). Best-effort.
    if (wait.shellID !== "" && r.reason !== "deadline") {
      try {
        await this.probe.shellKill(wait.shellID);
      } catch (err) {
        console.warn(`opencode-goal: §60 clock shell kill failed (${wait.shellID}):`, err);
      }
    }
    void appendDecision({
      ts: new Date().toISOString(),
      sessionID,
      ownKnown: true,
      decision: "wait",
      reason: `resolved (${r.reason}${r.shellID !== undefined ? `; shell ${r.shellID}` : ""}${r.exit !== undefined ? `; exit ${r.exit}` : ""}${detail ? `; ${detail}` : ""})`,
    });
    wait.resolve(r);
  }

  /** §60: shell store events — the wait clock's sensors. Server-fired shells
   * (our clock, other server-fired) emit these; MODEL-originated shells emit
   * NONE (§56 forensics) — their completion is sensed by the tick store scan
   * in runWatchdogTick. */
  private async onShellEvent(event: HostEvent): Promise<void> {
    const props = (event.properties ?? {}) as Record<string, unknown>;
    if (event.type === "shell.created") {
      const info = (typeof props.info === "object" && props.info !== null ? props.info : {}) as Record<string, unknown>;
      const meta = (typeof info.metadata === "object" && info.metadata !== null ? info.metadata : {}) as Record<string, unknown>;
      const sessionID = typeof meta.sessionID === "string" ? meta.sessionID : undefined;
      const shellID = typeof info.id === "string" ? info.id : undefined;
      if (sessionID === undefined || shellID === undefined) return;
      const wait = this.pendingWaits.get(sessionID);
      if (wait === undefined || wait.shellID === shellID) return; // own clock: tracked at arm
      if (!(await this.sessionBelongs(sessionID))) return;
      wait.shells.add(shellID);
      return;
    }
    const shellID = typeof props.id === "string" ? props.id : undefined;
    if (shellID === undefined) return;
    const status = typeof props.status === "string" ? props.status : undefined;
    const exit = typeof props.exit === "number" ? props.exit : undefined;
    for (const [sessionID, wait] of this.pendingWaits) {
      if (wait.shellID === shellID) {
        // The clock shell left the store. shell.exited carries the exit
        // status: killed = CANCELLED (the user's escape hatch); a natural
        // exit/timeout = the sleep ran out = DEADLINE. shell.deleted carries
        // no status (store cleanup may also delete a just-finished clock
        // shell) → due heuristic.
        const reason: "deadline" | "cancelled" =
          event.type === "shell.deleted"
            ? Date.now() >= wait.due - 2000
              ? "deadline"
              : "cancelled"
            : status === "killed"
              ? "cancelled"
              : "deadline";
        void this.resolveWait(sessionID, { reason, shellID, exit });
        return;
      }
      if (wait.shells.has(shellID)) {
        void this.resolveWait(sessionID, { reason: "shell", shellID, exit });
        return;
      }
    }
  }

  /** §60: the BLOCKING goal_wait — hang the calling turn on the wait promise
   * until the deadline or an early-return event. Returns the model-facing text. */
  private async waitGoalBlocking(sessionID: string, minutes: number): Promise<string> {
    const goal = await this.loadGoal(sessionID);
    if (goal === undefined) return "no active goal for this session";
    if (goal.status !== "active") return `goal ${goal.id} is not active (status: ${goal.status})`;
    const due = Date.now() + minutes * 60_000;
    // Persist FIRST: the §57 reload fallback — if this instance dies while
    // the wait hangs (host restart, explicit evict), the fresh instance's
    // init re-arm / tick delivers the SAME "wait period ended" wake at `due`.
    goal.waitUntil = due;
    goal.waitWakeSent = false;
    goal.waitMinutes = minutes;
    await this.saveGoal(goal);
    // The call owns its heartbeat (the §57 lesson): the tick is the store
    // scan sensor + the deadline backfill owner.
    this.ensureWatchdog(sessionID);

    // The clock is a HOST process: `sleep` in this session's shell store —
    // survives plugin reload and machine sleep, visible and killable (the
    // kill IS the cancellation). Fire/claim failure degrades to timer-only.
    let shellID = "";
    let shells = new Set<string>();
    try {
      const session = await this.probe.sessionGet(sessionID);
      const directory = session?.location?.directory ?? this.probe.locationDirectory;
      if (directory !== undefined) {
        const before = new Set((await this.probe.shellList(directory)).map((s) => s.id));
        await this.probe.shellFire(sessionID, `sleep ${minutes * 60}`);
        // The POST is fire-and-forget (the 204 only arrives at shell
        // completion) — poll the claim: the store entry appears within
        // ~0.5s on 2.1.4, allow up to ~5s for a slow host.
        let fired: ShellEntry | undefined;
        for (let attempt = 0; attempt < 10 && fired === undefined; attempt++) {
          const after = await this.probe.shellList(directory);
          fired = after.find((s) => !before.has(s.id) && s.sessionID === sessionID);
          if (fired === undefined) await new Promise((r) => setTimeout(r, 500));
        }
        shellID = fired?.id ?? "";
        // Tracked = every OTHER session shell at arm: the tick scan turns
        // their disappearance into the early "shell" return.
        const afterFinal = await this.probe.shellList(directory);
        shells = new Set(afterFinal.filter((s) => s.sessionID === sessionID && s.id !== shellID).map((s) => s.id));
        if (shellID === "") {
          console.warn(`opencode-goal: §60 wait clock shell not found in the store (timer-only fallback)`);
        }
      }
    } catch (err) {
      shellID = "";
      shells = new Set();
      console.warn(`opencode-goal: §60 wait clock shell fire failed (timer-only fallback):`, err);
    }

    let resolve!: (r: { reason: "deadline" | "user" | "shell" | "cancelled"; shellID?: string; exit?: number }) => void;
    const result = new Promise<{ reason: "deadline" | "user" | "shell" | "cancelled"; shellID?: string; exit?: number }>(
      (res) => {
        resolve = res;
      },
    );
    // Fallback timer: due + 5s slack — covers a LOST clock-shell event; the
    // persisted waitUntil (tick) covers a dead process.
    const timer = setTimeout(() => {
      void this.resolveWait(sessionID, { reason: "deadline" });
    }, minutes * 60_000 + 5_000);
    this.pendingWaits.set(sessionID, { shellID, due, timer, shells, resolve });
    void appendDecision({
      ts: new Date().toISOString(),
      sessionID,
      goalID: goal.id,
      ownKnown: true,
      decision: "wait",
      reason: `armed blocking (${minutes} min, clock ${shellID === "" ? "timer-only" : shellID}, until ${new Date(due).toISOString()})`,
    });

    const r = await result;
    switch (r.reason) {
      case "deadline":
        return `wait complete: ${minutes} min elapsed (goal ${goal.id}).`;
      case "user":
        return `wait interrupted: a user message arrived — respond to it now (the wait window is closed).`;
      case "shell":
        return `wait interrupted: shell ${r.shellID ?? "?"} in this session ended (exit ${r.exit ?? "n/a"}) before the ${minutes}-min deadline — check its result.`;
      case "cancelled":
        return `wait cancelled (the wait shell was killed). The wait window is closed — re-arm with goal_wait if you still need to wait.`;
    }
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
