// Task 11: compaction-proof goal state (spec §10) — pure string builders for
// the compaction session hook; zero host dependencies (GoalRecord type only).
//
// 2026-10-17 ruling: the "context" session hook (per-turn [GOAL] system part)
// was REMOVED — the plugin writes NO system part at all (any write, even a
// byte-stable one, shifts the request prefix at appearance/disappearance and
// breaks the LLM prefix cache). Goal grounding rides the tail channels only:
// the wake message (wake.ts) + the goal-creation message + the [GOAL STATE]
// block below.
//
// Builders:
// - buildCompactionPrompt: the generate() prompt — conversation history key
//   points (ruling: each message's text, >4000 chars truncated, at most the
//   last 30 messages) + the full goal state block.
// - composeCompactionSummary: the generated text + a MANDATORY trailing
//   [GOAL STATE] section (objective + per-task `N. [status] title` lines +
//   turns usage + caps text) — the section is built last so the summary
//   always carries the full goal state, even if the generated text is empty
//   or malformed.
import type { GoalRecord } from "./state";

// Ruling (controller): the "history key points" truncation strategy.
const MAX_HISTORY_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 4000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} …(truncated)`;
}

/** Turns usage: `used/cap`, or `used/(unbounded)` when the cap is open. */
function turnsUsage(goal: GoalRecord): string {
  return goal.cap.turns !== undefined
    ? `${goal.used.turns}/${goal.cap.turns}`
    : `${goal.used.turns}/(unbounded)`;
}

/** One indented line per task: `N. [status] title` (same shape as the wake message). */
function taskLines(goal: GoalRecord): string {
  if (goal.tasks.length === 0) return "  (no tasks)";
  return goal.tasks
    .map((t, i) => `  ${i + 1}. [${t.status}] ${t.title}`)
    .join("\n");
}

/**
 * The goal state block. With `caps` (the summary path, brief ruling: objective
 * + per-task lines + turns usage + cap text) it carries the budget line;
 * without `caps` (the prompt path) it stays self-contained.
 */
function goalStateBlock(goal: GoalRecord, caps?: string): string {
  const lines = [
    // The section marker is EXACTLY "[GOAL STATE]" (brief test contract:
    // summary.lastIndexOf("[GOAL STATE]") — a header with the id inside the
    // brackets would not contain the literal marker).
    "[GOAL STATE]",
    `Goal: ${goal.id}`,
    `Objective: ${goal.objective}`,
    "Tasks:",
    taskLines(goal),
    `Turns used: ${turnsUsage(goal)}`,
  ];
  if (caps !== undefined) lines.push(`Budget: ${caps}`);
  return lines.join("\n");
}

/**
 * generate() prompt for the compaction summary: a summarization instruction,
 * the conversation history key points (last ≤30 messages, each truncated at
 * 4000 chars), and the full goal state block.
 */
export function buildCompactionPrompt(goal: GoalRecord, history: Array<{ role: string; text: string }>): string {
  return [
    "Summarize the following session so work can continue losslessly after compaction.",
    "Preserve concrete facts: decisions, progress, open items, files, commands, outputs.",
    "",
    "Session history (oldest → newest):",
    ...history.slice(-MAX_HISTORY_MESSAGES).map((m) => `${m.role}: ${truncate(m.text, MAX_MESSAGE_CHARS)}`),
    "",
    goalStateBlock(goal),
  ].join("\n");
}

/**
 * The final compaction summary: the generated text (when non-empty), followed
 * by the MANDATORY trailing [GOAL STATE] block — objective, per-task status
 * lines, turns usage, caps text. The block is appended LAST so the summary
 * carries the full goal state even if the generated text is empty/malformed.
 */
export function composeCompactionSummary(generatedText: string, goal: GoalRecord, caps: string): string {
  const body = generatedText.trim();
  const block = goalStateBlock(goal, caps);
  return body === "" ? block : `${body}\n\n${block}`;
}
