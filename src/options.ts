// Plugin options resolution. Pure function, no imports.

export interface Options {
  stallLimit: number;
  defaultCapTurns: number;
  /** 2026-10-16 ruling: tokens are statistics by default — no token cap unless
   *  explicitly set (this option or `--tokens`). */
  defaultCapTokens?: number;
  judgeEnabled: boolean;
  judgeMaxPerGoal: number;
  watchdogTickMs: number;
  shellStallMs: number;
  waitCheckInMs: number;
  timeoutWrap: boolean;
  /** Wake transcript footprint: "full" (budget + objective + task progress
   *  re-grounded in the wake message) or "slim" (one-line trigger only —
   *  the context-hook system part already carries objective/budget before
   *  every model call). Default "slim" (2026-10-17 transcript-noise ruling). */
  wakeDetail: "full" | "slim";
  wakeText?: string;
  model?: ModelRef;
}

const DEFAULT_OPTIONS: Options = {
  stallLimit: 3,
  defaultCapTurns: 10,
  judgeEnabled: true,
  judgeMaxPerGoal: 1,
  watchdogTickMs: 30000,
  shellStallMs: 300000,
  waitCheckInMs: 300000,
  timeoutWrap: false,
  wakeDetail: "slim",
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
  // wakeDetail: strict "full"|"slim" strings; anything else falls back to
  // the default (same fault-tolerance style as the numeric/boolean fields).
  const wakeDetail =
    o.wakeDetail === "full" || o.wakeDetail === "slim"
      ? (o.wakeDetail as "full" | "slim")
      : DEFAULT_OPTIONS.wakeDetail;

  return {
    stallLimit: num("stallLimit", DEFAULT_OPTIONS.stallLimit),
    defaultCapTurns: num("defaultCapTurns", DEFAULT_OPTIONS.defaultCapTurns),
    defaultCapTokens: numOpt("defaultCapTokens"),
    judgeEnabled: bool("judgeEnabled", DEFAULT_OPTIONS.judgeEnabled),
    judgeMaxPerGoal: num("judgeMaxPerGoal", DEFAULT_OPTIONS.judgeMaxPerGoal),
    watchdogTickMs: num("watchdogTickMs", DEFAULT_OPTIONS.watchdogTickMs),
    shellStallMs: num("shellStallMs", DEFAULT_OPTIONS.shellStallMs),
    waitCheckInMs: num("waitCheckInMs", DEFAULT_OPTIONS.waitCheckInMs),
    timeoutWrap: bool("timeoutWrap", DEFAULT_OPTIONS.timeoutWrap),
    wakeDetail,
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
