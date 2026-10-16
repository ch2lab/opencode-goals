// Side-channel judge (stall arbitration): prompt builder, strict JSON
// contract parsing, fail-closed judge. Zero runtime imports — consumes
// GoalRecord type only. Any unparseable judge output is fail-closed:
// treated as give_up, never extended as autonomy.
import type { GoalRecord } from "./state";

export type JudgeVerdict = {
  verdict: "continue" | "complete" | "needs_human" | "give_up";
  reason: string;
  evidence?: string;
  instruction?: string;
};

export interface Judge {
  judge(goal: GoalRecord, noActionTexts: readonly string[]): Promise<JudgeVerdict>;
}

export type JudgeGenerator = (input: {
  sessionID: string;
  prompt: string;
}) => Promise<{ text: string }>;

/** One indented line per task: `N. [status] title`; marker when no tasks. */
function taskLines(goal: GoalRecord): string {
  if (goal.tasks.length === 0) return "  （无待办）";
  return goal.tasks
    .map((t, i) => `  ${i + 1}. [${t.status}] ${t.title}`)
    .join("\n");
}

/**
 * Builds the judge prompt: the goal (objective verbatim, per-task status
 * lines, budget), every no-action text verbatim in order, and the strict
 * output contract — JSON only, 4-value verdict enum, field rules.
 */
export function buildJudgePrompt(
  goal: GoalRecord,
  noActionTexts: readonly string[],
  budgetText: string,
): string {
  const stallLines =
    noActionTexts.length > 0
      ? noActionTexts.map((t) => `  - ${t}`).join("\n")
      : "  （无）";
  return [
    `目标 ${goal.id} 连续多轮无进展，请你作为旁路裁判审查并裁决。`,
    `目标: ${goal.objective}`,
    `预算: ${budgetText}`,
    "进度:",
    taskLines(goal),
    "无行动记录（逐条原文）:",
    stallLines,
    "裁决要求: 只输出 JSON，不要输出任何其他字符、解释或围栏，格式:",
    '{"verdict": "...", "reason": "..."}',
    "verdict 取值（四选一）: continue(继续推进) / complete(目标已完成) / needs_human(需要人工介入) / give_up(放弃);",
    "reason 必有，给出具体依据;",
    "evidence 仅当 verdict=complete 时必填，给可核对的证据（测试输出/文件/锚点）;",
    "instruction：verdict=continue 时可选，给出下一步的具体指令。",
  ].join("\n");
}

const VERDICTS: ReadonlySet<JudgeVerdict["verdict"]> = new Set([
  "continue",
  "complete",
  "needs_human",
  "give_up",
]);

function isVerdict(v: unknown): v is JudgeVerdict["verdict"] {
  return typeof v === "string" && VERDICTS.has(v as JudgeVerdict["verdict"]);
}

/**
 * Strict, fail-closed parse: the ENTIRE trimmed input must be a single
 * JSON object (no prose, no fences, no truncation). reason must be a
 * string; verdict must be in the 4-value enum; complete requires a string
 * evidence. Everything else → undefined. Unknown extra fields are ignored.
 */
export function parseJudgeOutput(raw: string): JudgeVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const { verdict, reason } = obj;
  if (typeof reason !== "string") return undefined;
  if (!isVerdict(verdict)) return undefined;
  const out: JudgeVerdict = { verdict, reason };
  if (verdict === "complete") {
    if (typeof obj.evidence !== "string") return undefined;
    out.evidence = obj.evidence;
  } else if (verdict === "continue" && typeof obj.instruction === "string") {
    out.instruction = obj.instruction;
  }
  return out;
}

const JUDGE_UNPARSEABLE: JudgeVerdict = {
  verdict: "give_up",
  reason: "judge output unparseable",
};

/** Budget usage text: `used/cap` per dimension; `unbounded` when open. */
function budgetText(goal: GoalRecord): string {
  const { used, cap } = goal;
  const turns =
    cap.turns !== undefined ? `${used.turns}/${cap.turns}` : `${used.turns}/unbounded`;
  const tokens =
    cap.tokens !== undefined ? `${used.tokens}/${cap.tokens}` : `${used.tokens}/unbounded`;
  return `${turns} turns, ${tokens} tokens`;
}

/**
 * Judge implementation backed by an injected session generator
 * (constructor injection — no dependency on WakeProbe; Task 6's
 * WakeProbe.generate must match JudgeGenerator). Fails closed: generator
 * errors, non-string resolutions, and unparseable output all yield give_up.
 */
export class SessionGenerateJudge implements Judge {
  constructor(private readonly generate: JudgeGenerator) {}

  async judge(
    goal: GoalRecord,
    noActionTexts: readonly string[],
  ): Promise<JudgeVerdict> {
    const prompt = buildJudgePrompt(goal, noActionTexts, budgetText(goal));
    let raw: string;
    try {
      const { text } = await this.generate({ sessionID: goal.sessionID, prompt });
      if (typeof text !== "string") return { ...JUDGE_UNPARSEABLE };
      raw = text;
    } catch {
      return { ...JUDGE_UNPARSEABLE };
    }
    return parseJudgeOutput(raw) ?? { ...JUDGE_UNPARSEABLE };
  }
}
