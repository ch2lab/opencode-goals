// Wake message / objective block builders (spec §7). Pure string builders,
// zero runtime imports — consumes GoalRecord type only.
import type { GoalRecord } from "./state";

/** Turns usage text: `used/cap`, or `used/(unbounded)` when cap is open. */
function turnsUsage(goal: GoalRecord): string {
  const { used, cap } = goal;
  return cap.turns !== undefined
    ? `${used.turns}/${cap.turns}`
    : `${used.turns}/(unbounded)`;
}

/** One indented line per task: `N. [status] title`; marker when no tasks. */
function taskLines(goal: GoalRecord): string {
  if (goal.tasks.length === 0) return "  （无待办）";
  return goal.tasks
    .map((t, i) => `  ${i + 1}. [${t.status}] ${t.title}`)
    .join("\n");
}

/**
 * Builds the stall-wake message: re-grounds the goal and forces a terminal
 * tool call (goal_complete / goal_block / advance). `caps` is the
 * caller-provided budget description (e.g. "10 turns / 100k tokens",
 * "unbounded"), embedded verbatim in the "full" detail. `wakeText` (Task 14
 * Fix 3a): when non-empty, appends ONE final line `补充指示: <wakeText>` —
 * after the judge section when one is present, directly after the main body
 * otherwise. Absent/empty = byte-identical to the pre-Fix-3a template.
 *
 * `detail` (2026-10-17 transcript-noise ruling): "full" re-grounds budget +
 * objective + per-task progress in the wake itself; "slim" keeps only the
 * header + one-line forced-tool-call instruction — the context-hook system
 * part already carries objective/budget before EVERY model call (and the
 * compaction summary carries full state), so the wake need not repeat them.
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
          `[GOAL ${goal.id} | 第 ${turnsUsage(goal)} 轮]`,
          "核对进度（目标与预算见 [GOAL] 系统上下文），必须用工具调用结束本轮：完成 → goal_complete(evidence，具体可核对锚点 ≥24 字符)；受阻 → goal_block(具体原因)；否则 → 推进（先 goal_add_task 规划 / goal_update_task 同步）。",
        ]
      : [
          `[GOAL ${goal.id} | 第 ${turnsUsage(goal)} 轮]`,
          `预算: ${caps}`,
          `目标: ${goal.objective}`,
          "进度:",
          taskLines(goal),
          "请核对以上进度，然后必须用工具调用结束本轮：",
          "- 完成条件已满足 → goal_complete(evidence)（evidence 须是具体可核对的锚点：文件/测试/输出，≥24 字符）；",
          "- 确实无法推进 → goal_block(reason)，给出具体原因；",
          "- 否则 → 用下一个具体工具推进：无待办先 goal_add_task(title) 规划，推进中用 goal_update_task(ref, status) 同步更新。",
        ];
  if (judgeInstruction !== undefined) {
    lines.push("", `裁判提示: ${judgeInstruction}`);
  }
  if (wakeText !== undefined && wakeText.length > 0) {
    lines.push(`补充指示: ${wakeText}`);
  }
  return lines.join("\n");
}

/**
 * Builds the compact objective block (compression guard / reminder use):
 * same header as the wake message but without task detail lines. Carries the
 * two imperative instruction lines (A/B 2026-10-16): autonomy + task
 * maintenance via goal_add_task / goal_update_task.
 */
export function objectiveBlock(goal: GoalRecord, caps: string): string {
  return [
    `[GOAL ${goal.id} | 第 ${turnsUsage(goal)} 轮]`,
    `预算: ${caps}`,
    `目标: ${goal.objective}`,
    "推进纪律: 自主推进目标，优先具体动作而非叙述。",
    "保持待办最新: 开工先用 goal_add_task(title) 规划，推进中用 goal_update_task(ref, status)（todo/doing/done）同步更新。",
  ].join("\n");
}
