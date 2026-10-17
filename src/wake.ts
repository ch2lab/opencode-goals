// Wake message builder (spec §7). Pure string builders, zero runtime imports
// — consumes the GoalRecord type only.
//
// I18N ruling (2026-10-17): every string the plugin generates (prompts, tool
// descriptions, injected messages) is English. User-provided content
// (objective, task titles, wakeText, quoted transcript text) stays verbatim
// in whatever language the user wrote it.
import type { GoalRecord } from "./state";

/**
 * One-shot progress-check reminder (2026-10-17 ruling): fired by the watchdog
 * tick when a session has been silent for `waitSec` seconds with background
 * work (`inFlight` items — shells / subtask sessions) still in flight. Pure
 * reminder: the plugin does NO liveness checking of the background work
 * itself — the session (model) goes and checks.
 */
export function backgroundCheckInText(inFlight: number, waitSec: number): string {
  return `Background check-in: ${inFlight} background item(s) in flight, no session activity for ${waitSec}s. Check progress: what finished, what is next — advance the goal.`;
}

/** Turns usage text: `used/cap`, or `used/(unbounded)` when cap is open. */
function turnsUsage(goal: GoalRecord): string {
  const { used, cap } = goal;
  return cap.turns !== undefined
    ? `${used.turns}/${cap.turns}`
    : `${used.turns}/(unbounded)`;
}

/** One indented line per task: `N. [status] title`; marker when no tasks. */
function taskLines(goal: GoalRecord): string {
  if (goal.tasks.length === 0) return "  (no tasks)";
  return goal.tasks
    .map((t, i) => `  ${i + 1}. [${t.status}] ${t.title}`)
    .join("\n");
}

/**
 * Builds the stall-wake message: re-grounds the goal and forces a terminal
 * tool call (goal_complete / goal_block / advance). `caps` is the
 * caller-provided budget description (e.g. "10 turns / 100k tokens",
 * "unbounded"), embedded verbatim. `wakeText` (Task 14 Fix 3a): when
 * non-empty, appends ONE final line `Extra instruction: <wakeText>` —
 * after the judge section when one is present, directly after the main body
 * otherwise. Absent/empty = byte-identical to the template without it.
 *
 * `detail` (2026-10-17, amended same day): the context-hook system part was
 * REMOVED (ruling: the plugin writes NO system part at all — any write, even a
 * byte-stable one, shifts the request prefix at appearance/disappearance and
 * breaks the LLM prefix cache), so the wake message is the per-turn grounding
 * channel (tail-appended — appends never break the prefix). "slim" (2026-10-17
 * minimal ruling) = header + ONE forced terminal tool call line ONLY — no
 * budget/objective/discipline/task lines: the goal tools are already exposed
 * in the model's system prompt (no per-turn re-teaching), and the objective
 * rides the conversation context. "full" adds the per-task progress block.
 * Default "full" (this builder's pre-existing contract; the OPTION default
 * is "slim" — see options.ts).
 */
export function buildWakeMessage(
  goal: GoalRecord,
  caps: string,
  judgeInstruction?: string,
  wakeText?: string,
  detail: "full" | "slim" = "full",
): string {
  const lines =
    detail === "slim"
      ? [
          `[GOAL ${goal.id} | turn ${turnsUsage(goal)}]`,
          "End this turn with a tool call: goal_complete(evidence, a concrete verifiable anchor ≥24 chars) / goal_block(concrete reason) / advance the goal.",
        ]
      : [
          `[GOAL ${goal.id} | turn ${turnsUsage(goal)}]`,
          `Budget: ${caps}`,
          `Objective: ${goal.objective}`,
          "Progress:",
          taskLines(goal),
          "Review the progress above, then end this turn with a tool call:",
          "- completion criteria met → goal_complete(evidence) (evidence must be a concrete verifiable anchor: file/test/output, ≥24 chars);",
          "- genuinely cannot advance → goal_block(reason), with a concrete reason;",
          "- otherwise → advance with the next concrete tool: if there are no tasks yet, plan first with goal_add_task(title); sync with goal_update_task(ref, status) as you go.",
        ];
  if (judgeInstruction !== undefined) {
    lines.push("", `Judge note: ${judgeInstruction}`);
  }
  if (wakeText !== undefined && wakeText.length > 0) {
    lines.push(`Extra instruction: ${wakeText}`);
  }
  return lines.join("\n");
}
