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
  waitingShells?: Array<{ id: string; timeoutMs?: number; since: number }>;
  waitUntil?: number;
  /** Provider failure pause (2026-10-17 ruling, 129 quota incident): set when
   *  consecutive boundaries whose last assistant message carries a provider.*
   *  error reach `providerFailLimit`. Until `until` the loop is silent (no
   *  wakes, no stall accounting, no check-ins); the watchdog fires ONE retry
   *  wake at the deadline (its boundary re-arms or clears this).
   *  `noticeSent` = the one-per-incident synthetic notice was delivered. */
  providerPause?: { until: number; noticeSent: boolean };
  lastHandledEventID?: string;
  judgeUsed?: boolean;
  evidence?: string;
  blocker?: string;
  stallReport?: string;
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
