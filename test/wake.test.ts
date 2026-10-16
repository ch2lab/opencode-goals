import { expect, test } from "bun:test";
import { createGoal, type GoalRecord, type GoalTask } from "../src/state.ts";
import { buildWakeMessage, objectiveBlock } from "../src/wake.ts";

const NOW = 1_700_000_000_000;

function makeTask(title: string, status: GoalTask["status"], i: number): GoalTask {
  return {
    id: `t_${i}`,
    title,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function goalWith(opts: {
  id?: string;
  objective?: string;
  cap?: GoalRecord["cap"];
  used?: { turns: number; tokens: number };
  tasks?: GoalTask[];
} = {}): GoalRecord {
  const goal = createGoal(
    {
      sessionID: "ses_test",
      objective: opts.objective ?? "ship the wake builders",
    },
    NOW,
  );
  goal.id = opts.id ?? "g_abc";
  goal.cap = opts.cap ?? { turns: 10 };
  goal.used = opts.used ?? { turns: 3, tokens: 1200 };
  goal.tasks = opts.tasks ?? [];
  return goal;
}

// --- header: goal id, objective, turns usage ---

test("wake message carries [GOAL <id>], the verbatim objective, and turns usage", () => {
  const g = goalWith({ objective: "ship the wake builders" });
  const msg = buildWakeMessage(g, "10 turns / 100k tokens");
  expect(msg).toContain("[GOAL g_abc");
  expect(msg).toContain("ship the wake builders");
  expect(msg).toContain("3/10");
});

test("caps string is embedded verbatim in both wake message and objective block", () => {
  const g = goalWith({});
  const caps = "10 turns / 100k tokens";
  expect(buildWakeMessage(g, caps)).toContain(caps);
  expect(objectiveBlock(g, caps)).toContain(caps);
});

test("undefined cap.turns renders the usage as (unbounded)", () => {
  const g = goalWith({ cap: {}, used: { turns: 2, tokens: 5 } });
  const msg = buildWakeMessage(g, "unbounded");
  expect(msg).toContain("(unbounded)");
});

// --- task lines: "N. [status] title" ---

test("each task renders as 'N. [status] title' with 1-based index", () => {
  const g = goalWith({
    tasks: [
      makeTask("搭骨架", "done", 1),
      makeTask("写测试", "doing", 2),
      makeTask("提交", "todo", 3),
    ],
  });
  const msg = buildWakeMessage(g, "10 turns");
  expect(msg).toContain("1. [done] 搭骨架");
  expect(msg).toContain("2. [doing] 写测试");
  expect(msg).toContain("3. [todo] 提交");
});

// --- terminal-tool keywords ---

test("wake message steers to goal_complete and goal_block", () => {
  const msg = buildWakeMessage(goalWith({}), "unbounded");
  expect(msg).toContain("goal_complete");
  expect(msg).toContain("goal_block");
});

// --- judge instruction: both directions ---

test("judge instruction appears as its own section when provided", () => {
  const instruction = "证据必须是可复跑的命令输出";
  const msg = buildWakeMessage(goalWith({}), "10 turns", instruction);
  expect(msg).toContain(`裁判提示: ${instruction}`);
});

// --- wakeText (Task 14 Fix 3a): appended as the final 补充指示 line ---

test("wakeText appends a 补充指示 line at the end (after the judge section)", () => {
  const instruction = "证据必须是可复跑的命令输出";
  const msg = buildWakeMessage(goalWith({}), "10 turns", instruction, "务必先看 CI 日志");
  expect(msg).toContain("裁判提示: 证据必须是可复跑的命令输出");
  expect(msg.endsWith("补充指示: 务必先看 CI 日志")).toBe(true);
  expect(msg.indexOf("裁判提示")).toBeLessThan(msg.indexOf("补充指示"));
});

test("wakeText without a judge section lands directly after the main body", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns", undefined, "务必先看 CI 日志");
  expect(msg.endsWith("补充指示: 务必先看 CI 日志")).toBe(true);
  expect(msg).not.toContain("裁判提示");
});

test("default (no wakeText) message is byte-identical to the pre-Fix-3a template", () => {
  // Pinned byte-for-byte: the 4th parameter must be a pure no-op when unset.
  const g = goalWith({});
  const expected = [
    "[GOAL g_abc | 第 3/10 轮]",
    "预算: 10 turns",
    "目标: ship the wake builders",
    "进度:",
    "  （无待办）",
    "请核对以上进度，然后必须用工具调用结束本轮：",
    "- 完成条件已满足 → goal_complete(evidence)（evidence 须是具体可核对的锚点：文件/测试/输出，≥24 字符）；",
    "- 确实无法推进 → goal_block(reason)，给出具体原因；",
    "- 否则 → 用下一个具体工具推进：无待办先 goal_add_task(title) 规划，推进中用 goal_update_task(ref, status) 同步更新。",
  ].join("\n");
  expect(buildWakeMessage(g, "10 turns")).toBe(expected);
  expect(buildWakeMessage(g, "10 turns", undefined, undefined)).toBe(expected);
});

test("judge section is absent when no instruction is provided", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns");
  expect(msg).not.toContain("裁判提示");
});

// --- empty tasks ---

test("goal with no tasks: no-todo marker, no task lines, rest of contract holds", () => {
  const g = goalWith({ objective: "no tasks goal" });
  const msg = buildWakeMessage(g, "unbounded");
  expect(msg).toContain("（无待办）");
  expect(msg).not.toContain("1. [");
  expect(msg).toContain("[GOAL g_abc");
  expect(msg).toContain("no tasks goal");
  expect(msg).toContain("goal_complete");
  expect(msg).toContain("goal_block");
});

// --- P0-2 (2026-10-16 A/B): imperative task-maintenance instruction ---
// Evidence: live A/B — the reference plugin's model actively used
// goal_add_task/goal_update_task across every scenario; ours never did
// (tasks[] empty in all four runs). Its objective block carries an explicit
// imperative instruction; ours only had a passive "同步更新待办状态" aside.

test("objectiveBlock carries the imperative task-maintenance instruction (goal_add_task + goal_update_task)", () => {
  const block = objectiveBlock(goalWith({}), "10 turns");
  expect(block).toContain("goal_add_task");
  expect(block).toContain("goal_update_task");
});

test("wake message carries the imperative task-maintenance instruction (goal_add_task + goal_update_task)", () => {
  const msg = buildWakeMessage(goalWith({}), "10 turns");
  expect(msg).toContain("goal_add_task");
  expect(msg).toContain("goal_update_task");
});

// --- objectiveBlock: isomorphic but no task detail ---

test("objective block has header, objective, turns usage — and no task detail", () => {
  const g = goalWith({
    objective: "block objective",
    tasks: [
      makeTask("搭骨架", "done", 1),
      makeTask("写测试", "doing", 2),
    ],
  });
  const block = objectiveBlock(g, "10 turns");
  expect(block).toContain("[GOAL g_abc");
  expect(block).toContain("block objective");
  expect(block).toContain("3/10");
  expect(block).not.toContain("1. [");
  expect(block).not.toContain("2. [doing] 写测试");
});
