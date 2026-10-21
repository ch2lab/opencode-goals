// Plugin options resolution. Pure function, no imports.

export interface Options {
  stallLimit: number;
  /** 2026-10-20 ruling: goals are UNBOUNDED by default (no default cap).
   *  Explicit opt-in: when set (positive integer), goal_set / `/goal set`
   *  without an explicit turns value caps at this. */
  defaultCapTurns?: number;
  /** 2026-10-16 ruling: tokens are statistics by default — no token cap unless
   *  explicitly set (this option or `--tokens`). */
  defaultCapTokens?: number;
  judgeEnabled: boolean;
  judgeMaxPerGoal: number;
  watchdogTickMs: number;
  /** 2026-10-17 ruling: background in-flight gate — a boundary with background
   * work (shells / subtask sessions) in flight does NOT wake immediately; it
   * arms a one-shot progress check after this many SECONDS of silence
   * (default 300 = 5 minutes). Any session activity cancels it. */
  checkInDelaySec: number;
  timeoutWrap: boolean;
  /** §52 (2026-10-21 ruling): a FOREGROUND (blocking) shell in an active-goal
   * session that runs longer than this is moved to background observation via
   * the host's session.background endpoint (the Ctrl+B server action — the work
   * keeps running; the host injects its own synthetic so the blocked turn is
   * released). 0 = disabled. Default 30 min. The only numeric option that
   * accepts 0. */
  foregroundShellBackgroundMs: number;
  /** 2026-10-17 ruling (129 "Insufficient account funds" incident): consecutive
   *  boundaries whose last assistant message carries a provider.* error that
   *  arm the provider pause (default 2 — a single transient failure still gets
   *  one wake attempt). */
  providerFailLimit: number;
  /** Provider-pause duration in MILLISECONDS before the watchdog retry wake
   *  (default 30 min — long enough for funds/model to be fixed, short enough
   *  that a self-healing provider re-joins the loop without human action). */
  providerPauseMs: number;
  wakeText?: string;
  model?: ModelRef;
}

const DEFAULT_OPTIONS: Options = {
  stallLimit: 3,
  // 2026-10-20 ruling: no default cap — goals are unbounded unless the user
  // opts in via defaultCapTurns / defaultCapTokens or an explicit flag.
  // 2026-10-17 ruling: default OFF. The side-channel judge's only exclusive
  // value is rescuing a stalled goal (continue + instruction); its failure
  // mode degrades to exactly the no-judge behavior (fail-closed → stalled),
  // and field data (129) never exercised it (stalls=0). A stalled goal
  // surfacing to the human is the intended control point. Opt back in with
  // judgeEnabled: true.
  judgeEnabled: false,
  judgeMaxPerGoal: 1,
  watchdogTickMs: 30000,
  checkInDelaySec: 300,
  timeoutWrap: false,
  // §52: 30 min — long enough for legitimate blocking shells, short enough
  // that a hung one cannot freeze the goal loop for the rest of the night.
  foregroundShellBackgroundMs: 30 * 60 * 1000,
  providerFailLimit: 2,
  providerPauseMs: 30 * 60 * 1000,
};

export function resolveOptions(pluginOptions: Record<string, unknown>): Options {
  const o = pluginOptions ?? {};
  // Numeric fields accept only integers >= 1; anything else falls back.
  const num = (key: string, fallback: number): number => {
    const v = o[key];
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
  };
  // Optional numeric field: positive integer or undefined (no fallback).
  const numOpt = (key: string): number | undefined => {
    const v = o[key];
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  };
  // Boolean fields accept only boolean literals; anything else falls back.
  const bool = (key: string, fallback: boolean): boolean =>
    typeof o[key] === "boolean" ? (o[key] as boolean) : fallback;
  const wakeText =
    typeof o.wakeText === "string" && o.wakeText.length > 0 ? o.wakeText : undefined;
  const model = parseModelRef(o.model);
  // §52: the only numeric option where 0 is a VALID value (0 = disabled).
  const fbgRaw = o["foregroundShellBackgroundMs"];
  const foregroundShellBackgroundMs =
    typeof fbgRaw === "number" && Number.isInteger(fbgRaw) && fbgRaw >= 0
      ? (fbgRaw as number)
      : DEFAULT_OPTIONS.foregroundShellBackgroundMs;

  return {
    stallLimit: num("stallLimit", DEFAULT_OPTIONS.stallLimit),
    defaultCapTurns: numOpt("defaultCapTurns"),
    defaultCapTokens: numOpt("defaultCapTokens"),
    judgeEnabled: bool("judgeEnabled", DEFAULT_OPTIONS.judgeEnabled),
    judgeMaxPerGoal: num("judgeMaxPerGoal", DEFAULT_OPTIONS.judgeMaxPerGoal),
    watchdogTickMs: num("watchdogTickMs", DEFAULT_OPTIONS.watchdogTickMs),
    checkInDelaySec: num("checkInDelaySec", DEFAULT_OPTIONS.checkInDelaySec),
    timeoutWrap: bool("timeoutWrap", DEFAULT_OPTIONS.timeoutWrap),
    foregroundShellBackgroundMs,
    providerFailLimit: num("providerFailLimit", DEFAULT_OPTIONS.providerFailLimit),
    providerPauseMs: num("providerPauseMs", DEFAULT_OPTIONS.providerPauseMs),
    wakeText,
    model,
  };
}

/**
 * Model reference for side-channel generation (judge / compaction summary).
 * Matches the host GenerateTextInput.model shape ({ id, providerID }).
 */
export interface ModelRef {
  providerID: string;
  id: string;
  /** Present when the ref came from a session model (faithful passthrough). */
  variant?: string;
}

/**
 * Parses the "providerID/modelID" option format. STRICT: exactly two
 * non-empty segments, no whitespace, no further slashes. Anything else
 * yields undefined (the caller falls back to the session's own model, then
 * the host default).
 */
export function parseModelRef(ref: unknown): ModelRef | undefined {
  if (typeof ref !== "string") return undefined;
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return undefined;
  const providerID = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (
    providerID.length === 0 ||
    id.length === 0 ||
    id.includes("/") ||
    /\s/.test(providerID) ||
    /\s/.test(id)
  ) {
    return undefined;
  }
  return { providerID, id };
}

/**
 * Side-channel model selection (2026-10-16): the explicit plugin option wins;
 * otherwise the SESSION'S OWN model (per-session — includes a model switched
 * within the session, NOT the global default); otherwise undefined = let the
 * host use its own default.
 */
export function selectJudgeModel(
  explicit: ModelRef | undefined,
  sessionModel: ModelRef | undefined,
): ModelRef | undefined {
  return explicit ?? sessionModel;
}
