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
 *
 * 2026-10-18 autonomy ruling: reframed from the imperative "…advance the
 * goal." tail — this moment is exactly "background running, model tempted
 * to wait/ask", so the line grants goal-mode autonomy (take the next safe
 * step per the goal's discipline, don't stall on a question to the user) and
 * carries the user-message-overrides clause, like the slim wake.
 *
 * §51 (2026-10-21 ruling): `items` carries the in-flight roster (shell id +
 * elapsed, subtask session id — UNCAPPED, NO command text) so the model does
 * not re-query to find out what it is waiting on. Omitted/empty = the legacy
 * text, byte-for-byte.
 */
export function backgroundCheckInText(inFlight: number, waitSec: number, items?: string[]): string {
  const roster =
    items !== undefined && items.length > 0
      ? `\nIn flight now (no need to re-query):\n${items.map((i) => `  - ${i}`).join("\n")}`
      : "";
  return `Background check-in: ${inFlight} background item(s) in flight, no session activity for ${waitSec}s.${roster} Goal mode: keep working unattended — check what finished, then take the next safe step per the goal's discipline (verify the background result, or make independent progress); don't stall on a question to the user. A user message always overrides this reminder.`;
}

/**
 * Provider-pause entry notice — ONE per incident (goalControl synthetic,
 * 2026-10-17 ruling): the model is failing with a provider-level error
 * (quota/funds), automatic wakes are suspended, and a watchdog retry fires
 * after `minutes`.
 */
export function providerPauseNoticeText(goalID: string, minutes: number): string {
  return `opencode-goal: goal ${goalID} auto-paused — model requests keep failing with a provider error (quota/funds). Automatic wakes suspended; retrying in ${minutes}m. Fix the provider or switch models — the loop resumes on the first successful turn.`;
}

/**
 * Watchdog retry wake fired at the pause deadline (watchdog text family —
 * no options.wakeText, like the check-in). If the provider is still down the
 * boundary re-arms the pause (no duplicate notice); a clean turn resumes.
 *
 * 2026-10-18 autonomy ruling: the tail no longer commands "end this turn with
 * a goal tool call" — the model only reports; the mechanism (boundary
 * resolves the pause) is unchanged, the model is never forced to re-hammer a
 * dead provider.
 */
export function providerPauseRetryText(goalID: string): string {
  return `Provider pause retry: model requests were failing with a provider error (quota/funds) — retrying goal ${goalID}. If a request still fails, note it in your reply — the loop auto-pauses and retries at the next deadline; a clean turn resumes. A user message always overrides this reminder.`;
}

// (2026-10-20 de-cap ruling: the header shows the bare wake counter only —
// `turn N`, no cap denominator. See buildWakeMessage's doc.)

/**
 * builds the WAKE message — the per-turn grounding channel (tail-appended —
 * appends never break the LLM prefix cache; the plugin writes NO system part).
 *
 * 2026-10-20 ruling (single wake format — wakeDetail removed): the goal's own
 * data (objective / per-task progress) is NOT re-stated in the wake — it is
 * the model's OWN tool-generated data (goal_set / goal_add_task), already in
 * the conversation context, and after compaction the summary's mandatory
 * [GOAL STATE] block carries it. The wake = speaker tag + ONE autonomy line +
 * the next-step section (goal_next_step) only.
 *
 * Autonomy framing (2026-10-18): the body is NO LONGER an imperative
 * forced-tool-call menu ("End this turn with a tool call: …"). It grants
 * goal-mode autonomy — you advance the goal unattended per its discipline,
 * don't stall on questions to the user — and names the ONLY two stops:
 * goal_complete (done) and goal_block (genuinely blocked). A live user
 * message always overrides. Enforcement backstop is unchanged: turns that
 * neither stop nor advance still tick the stall ladder.
 *
 * "Safe" de-emphasis (2026-10-20 ruling, 129 live block incident): the line
 * used to say "take the next SAFE step" — the word gave the model a veto
 * criterion: uncertainty mapped to "not safe enough", and goal_block was the
 * face-saving stop. The safety net is the record + the flow (the next-step
 * record, the stall ladder, user override) — not a word in the prompt.
 * "genuinely blocked" stays: that is the bar for a real stop, not an escape.
 *
 * Header ruling (2026-10-20, user ruling chain): the header is the speaker tag
 * `[goal] turn-N:` — the goal ID is GONE (the model's goal tools are
 * session-bound — the controller resolves the goal per session, the ID is
 * not an input; attribution rides message metadata `goalID` + the decision
 * log + goal_view output), and the cap denominator is GONE (a visible usage
 * FRACTION + the growing 1/M..N/M sequence in the wake history reads as
 * "nearly out of budget" → end-game behavior; the plugin is the budget
 * authority). Only the bare wake counter survives. The judge/compaction
 * channels keep their budget context (separate model calls — ruling scope).
 *
 * Next-step resume (2026-10-20 ruling — goal_next_step, the dispatch-brief
 * structure): every boundary wake carries a next-step section, in TWO branches
 * (both details). Recorded (goal.nextStep set — the session ended its turn
 * per the rules) → REPLAY the model's own last synthesis and command
 * verify-then-execute. Absent (the session stopped without recording — the
 * rules don't force turn-end ritual, so this is the common case) → the wake
 * commands the model to record one FIRST (the woken turn's guaranteed first
 * act — the synthesis rides the wake, not the model's spontaneous discipline),
 * then execute it. The recorded text is user content: verbatim, any language.
 */
/**
 * `wakeText` (Task 14 Fix 3a): when non-empty, appends ONE final line
 * `Extra instruction: <wakeText>` — after the judge section when one is
 * present, directly after the next-step section otherwise. Absent/empty =
 * byte-identical to the template without it.
 */
export function buildWakeMessage(
  goal: GoalRecord,
  judgeInstruction?: string,
  wakeText?: string,
): string {
  const lines = [
    `[goal] turn-${goal.used.turns}: You advance this goal unattended. Don't ask the user questions and wait — follow the goal's discipline and take the next step. The only stops are goal_complete(evidence, a concrete verifiable anchor ≥24 chars) when the goal is done and goal_block(concrete reason) when you are genuinely blocked. A user message always overrides this reminder.`,
  ];
  // Reactivation context (2026-10-20 ruling): a reactivated goal's first
  // wakes carry ONE line — the prior status and (if the previous phase
  // completed) its evidence — so the model picks up where the goal left
  // off instead of redoing finished work.
  if (goal.reactivation !== undefined) {
    const prior = goal.evidenceHistory?.[goal.evidenceHistory.length - 1];
    lines.push(
      prior
        ? `Reactivated from ${goal.reactivation.from} — last completed phase: "${prior.evidence}". That work is already done; pick up where it left off, don't redo it.`
        : `Reactivated from ${goal.reactivation.from} — pick up where the goal left off.`,
    );
  }
  // Staleness guard: a record more than one turn behind the current usage
  // means the LAST turn never updated it (the model stopped without
  // re-recording — e.g. a mid-run restart lost the wake) — an old plan is
  // not trusted: the record-first line forces a FRESH synthesis.
  const fresh =
    goal.nextStep !== undefined && goal.used.turns - goal.nextStep.turn < 2;
  if (goal.nextStep !== undefined && fresh) {
    lines.push(
      `Resume — your last recorded next step (turn ${goal.nextStep.turn}): ${goal.nextStep.text}`,
      "Verify it is still valid (update it with goal_next_step if the situation changed), then execute it.",
    );
  } else {
    lines.push(
      "No recorded next step yet — first record one: goal_next_step(<what is done, the ONE next concrete step, how you will judge it>), then execute it.",
    );
  }
  if (judgeInstruction !== undefined) {
    lines.push("", `Judge note: ${judgeInstruction}`);
  }
  if (wakeText !== undefined && wakeText.length > 0) {
    lines.push(`Extra instruction: ${wakeText}`);
  }
  return lines.join("\n");
}
