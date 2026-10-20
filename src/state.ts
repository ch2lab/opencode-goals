// GoalRecord state model + pure helpers. No host or runtime imports.

export type GoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  | "budget_limited"
  | "stalled"
  | "cleared";

export type GoalTaskStatus = "todo" | "doing" | "done";

export interface GoalTask {
  id: string;
  title: string;
  status: GoalTaskStatus;
  createdAt: number;
  updatedAt: number;
}

/**
 * The model's recorded next step (2026-10-20 ruling — goal_next_step): the
 * model's own synthesis of "what is done -> the ONE next concrete step -> how
 * it will judge it". Written while the model is awake (the woken turn's first
 * act, commanded by the wake itself — the dispatch-brief structure: the
 * content rides a GUARANTEED moment, not the model's spontaneous discipline)
 * and replayed by the next boundary wake. Persists with the record (kv) —
 * survives compaction and host restart. Optional: records persisted before
 * the field lacked it; terminal goals keep their last value (the tool
 * refuses on terminal goals, so the value only moves while the goal is live).
 */
export interface GoalNextStep {
  text: string;
  turn: number;
  ts: number;
}

/**
 * Per-goal decision telemetry (2026-10-18 audit ruling): the counts of
 * boundary decisions the controller made for this goal. Persisted with the
 * record so a TERMINAL ARCHIVE answers "how did the loop behave during this
 * goal's life" without the volatile /tmp decision log (which a host restart
 * wipes). One bucket per logged decision; `paused` is the provider-pause
 * incident (logged as a skip with its own reason) — together the four
 * buckets partition every decision-log line of the goal.
 */
export interface GoalDecisions {
  wake: number;
  hold: number;
  skip: number;
  paused: number;
}

export type DecisionKind = keyof GoalDecisions;

/**
 * Increment one decision bucket, lazily initializing the field so records
 * persisted before 2026-10-18 (no `decisions` key) keep working.
 */
export function bumpGoalDecision(goal: GoalRecord, kind: DecisionKind): void {
  goal.decisions ??= { wake: 0, hold: 0, skip: 0, paused: 0 };
  goal.decisions[kind] += 1;
}

export interface GoalRecord {
  version: 1;
  id: string;
  sessionID: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  cap: { turns?: number; tokens?: number };
  used: { turns: number; tokens: number };
  stalls: number;
  continuations: number;
  tasks: GoalTask[];
  /** The model's recorded next-step plan (2026-10-20 ruling, goal_next_step);
   *  optional — replayed by the next boundary wake (see GoalNextStep). */
  nextStep?: GoalNextStep;
  /** Decision telemetry for this goal's life (2026-10-18); optional — records
   *  persisted before the field existed lack it until first decision. */
  decisions?: GoalDecisions;
  waitUntil?: number;
  /** Provider failure pause (2026-10-17 ruling, 129 quota incident): set when
   *  consecutive boundaries whose last assistant message carries a provider.*
   *  error reach `providerFailLimit`. Until `until` the loop is silent (no
   *  wakes, no stall accounting, no check-ins); the watchdog fires ONE retry
   *  wake at the deadline (its boundary re-arms or clears this).
   *  `noticeSent` = the one-per-incident synthetic notice was delivered.
   *  `retrySent` = this window's one-shot retry wake already fired (the tick
   *  must not re-fire it on every tick while the watchdog stays alive — e.g.
   *  a surviving pending check-in — and the window is still unresolved). */
  providerPause?: { until: number; noticeSent: boolean; retrySent?: boolean };
  lastHandledEventID?: string;
  judgeUsed?: boolean;
  evidence?: string;
  blocker?: string;
  stallReport?: string;
  /** Reactivation (2026-10-20 ruling — goal_next_step on an ended goal): the
   *  evidence of each reactivated phase, in completion order. The live
   *  `evidence` belongs to the CURRENT phase; on reactivation it is archived
   *  here so a later completion does not erase the earlier phase's proof. */
  evidenceHistory?: Array<{ evidence: string; at: number }>;
  /** Set when this goal was reactivated via goal_next_step: the prior status
   *  and the moment of reactivation. The next boundary wake carries a
   *  reactivation context line from this (buildWakeMessage). */
  reactivation?: { from: GoalStatus; at: number };
  /** One-shot budget grace (2026-10-20 ruling, spec §49): set when a goal is
   *  resumed from budget_limited. The resume command's own result line kicks a
   *  real turn (host auto-wake, §48-B); without the grace, that kick turn's
   *  boundary would immediately re-limit the just-resumed goal (the caps are
   *  still exhausted), making /goal resume a no-op. The next boundary budget
   *  re-check consumes it (decision "hold") instead of re-limiting. */
  budgetGrace?: boolean;
}

export const GOAL_STORAGE_PREFIX = "goal/";

export function goalStorageKey(sessionID: string): string {
  return `${GOAL_STORAGE_PREFIX}${sessionID}`;
}

export function archivedGoalKey(sessionID: string, goalID: string): string {
  return `${GOAL_STORAGE_PREFIX}${sessionID}/archived/${goalID}`;
}

const TERMINAL: ReadonlySet<GoalStatus> = new Set([
  "completed",
  "blocked",
  "budget_limited",
  "stalled",
  "cleared",
]);

export function isTerminal(status: GoalStatus): boolean {
  return TERMINAL.has(status);
}

export function isCapReached(goal: GoalRecord): boolean {
  const { cap, used } = goal;
  return (
    (cap.turns !== undefined && used.turns >= cap.turns) ||
    (cap.tokens !== undefined && used.tokens >= cap.tokens)
  );
}

let idCounter = 0;

/** Module-level counter, wrapped at 1_000_000 (precedent: g_<base36>_<counter36>). */
function nextID(prefix: string, now: number): string {
  const counter = idCounter++ % 1_000_000;
  return `${prefix}${now.toString(36)}_${counter.toString(36)}`;
}

export function nextGoalID(now?: number): string {
  return nextID("g_", now ?? Date.now());
}

export function createGoal(
  input: { sessionID: string; objective: string; cap?: GoalRecord["cap"] },
  now?: number,
): GoalRecord {
  const t = now ?? Date.now();
  return {
    version: 1,
    id: nextGoalID(t),
    sessionID: input.sessionID,
    objective: input.objective,
    status: "active",
    createdAt: t,
    updatedAt: t,
    cap: input.cap ?? {},
    used: { turns: 0, tokens: 0 },
    stalls: 0,
    continuations: 0,
    tasks: [],
    decisions: { wake: 0, hold: 0, skip: 0, paused: 0 },
  };
}

/**
 * Appends a todo task to the goal's task list (mutates `goal.tasks`).
 * No cap (2026-10-18 user ruling: the old 50-task limit is gone — the ledger
 * is the goal's live index and long campaigns legitimately outgrow 50 lines;
 * settled history belongs in project docs, enforced by the model, not by a
 * hard error).
 */
export function addTask(
  goal: GoalRecord,
  title: string,
  now?: number,
): GoalTask {
  const t = now ?? Date.now();
  const task: GoalTask = {
    id: nextID("t_", t),
    title,
    status: "todo",
    createdAt: t,
    updatedAt: t,
  };
  goal.tasks.push(task);
  return task;
}

/**
 * Resolves a user-supplied task reference: either a 1-based decimal index
 * ("3") or a task id. Returns the 1-based index, or -1 when not found.
 */
export function resolveTaskRef(
  tasks: readonly GoalTask[],
  ref: string,
): number {
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= tasks.length) return n;
  const i = tasks.findIndex((t) => t.id === ref);
  return i === -1 ? -1 : i + 1;
}
