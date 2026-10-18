import { describe, expect, test } from "bun:test";
import {
  GOAL_STORAGE_PREFIX,
  addTask,
  archivedGoalKey,
  createGoal,
  goalStorageKey,
  isCapReached,
  isTerminal,
  nextGoalID,
  resolveTaskRef,
  type GoalRecord,
  type GoalStatus,
  type GoalTask,
} from "../src/state.ts";

const NOW = 1_750_000_000_000;

function goalWith(over: Partial<GoalRecord>): GoalRecord {
  return { ...createGoal({ sessionID: "s1", objective: "ship it" }, NOW), ...over };
}

describe("createGoal", () => {
  test("initial values: active, used zeroed, no tasks, g_ prefix, version 1", () => {
    const g = createGoal({ sessionID: "s1", objective: "ship it" }, NOW);
    expect(g.version).toBe(1);
    expect(g.id.startsWith("g_")).toBe(true);
    expect(typeof g.id).toBe("string");
    expect(g.sessionID).toBe("s1");
    expect(g.objective).toBe("ship it");
    expect(g.status).toBe("active");
    expect(g.createdAt).toBe(NOW);
    expect(g.updatedAt).toBe(NOW);
    expect(g.cap).toEqual({});
    expect(g.used).toEqual({ turns: 0, tokens: 0 });
    expect(g.stalls).toBe(0);
    expect(g.continuations).toBe(0);
    expect(g.tasks).toEqual([]);
  });

  test("carries explicit cap through", () => {
    const g = createGoal(
      { sessionID: "s1", objective: "x", cap: { turns: 4, tokens: 9 } },
      NOW,
    );
    expect(g.cap).toEqual({ turns: 4, tokens: 9 });
  });
});

describe("nextGoalID", () => {
  test("string with g_ prefix, distinct calls are distinct", () => {
    const a = nextGoalID(NOW);
    const b = nextGoalID(NOW);
    expect(typeof a).toBe("string");
    expect(a.startsWith("g_")).toBe(true);
    expect(b.startsWith("g_")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("storage keys", () => {
  test("GOAL_STORAGE_PREFIX", () => {
    expect(GOAL_STORAGE_PREFIX).toBe("goal/");
  });

  test("goalStorageKey", () => {
    expect(goalStorageKey("s1")).toBe("goal/s1");
  });

  test("archivedGoalKey", () => {
    expect(archivedGoalKey("s1", "g1")).toBe("goal/s1/archived/g1");
  });
});

describe("isTerminal", () => {
  // spec §5: 终态 = completed/blocked/budget_limited/stalled/cleared
  test.each([
    ["active", false],
    ["paused", false],
    ["completed", true],
    ["blocked", true],
    ["budget_limited", true],
    ["stalled", true],
    ["cleared", true],
  ] as [GoalStatus, boolean][])("%s → %s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});

describe("isCapReached", () => {
  test("no cap: never reached, even with high usage", () => {
    const g = goalWith({ used: { turns: 999, tokens: 999_999 } });
    expect(isCapReached(g)).toBe(false);
  });

  test("turns reached", () => {
    const g = goalWith({ cap: { turns: 10 }, used: { turns: 10, tokens: 0 } });
    expect(isCapReached(g)).toBe(true);
  });

  test("tokens reached", () => {
    const g = goalWith({ cap: { tokens: 100_000 }, used: { turns: 0, tokens: 100_000 } });
    expect(isCapReached(g)).toBe(true);
  });

  test("neither reached", () => {
    const g = goalWith({
      cap: { turns: 10, tokens: 100_000 },
      used: { turns: 9, tokens: 99_999 },
    });
    expect(isCapReached(g)).toBe(false);
  });

  test("exceeding cap is also reached", () => {
    expect(isCapReached(goalWith({ cap: { turns: 10 }, used: { turns: 11, tokens: 0 } }))).toBe(true);
    expect(isCapReached(goalWith({ cap: { tokens: 100_000 }, used: { turns: 0, tokens: 100_001 } }))).toBe(true);
  });
});

describe("addTask", () => {
  test("appends a todo task with t_ id and timestamps, returns it", () => {
    const g = createGoal({ sessionID: "s1", objective: "x" }, NOW);
    const t = addTask(g, "first step", NOW);
    expect(t.id.startsWith("t_")).toBe(true);
    expect(t.title).toBe("first step");
    expect(t.status).toBe("todo");
    expect(t.createdAt).toBe(NOW);
    expect(t.updatedAt).toBe(NOW);
    expect(g.tasks).toHaveLength(1);
    expect(g.tasks[0]).toBe(t);
  });

  test("no task cap (2026-10-18 user ruling: the 50 limit is gone) — the 51st and 100th adds succeed", () => {
    const g = createGoal({ sessionID: "s1", objective: "x" }, NOW);
    for (let i = 1; i <= 100; i++) {
      addTask(g, `task ${i}`, NOW);
    }
    expect(g.tasks).toHaveLength(100);
    expect(g.tasks[50]).toMatchObject({ title: "task 51", status: "todo" });
  });
});

describe("resolveTaskRef", () => {
  const tasks: GoalTask[] = [
    { id: "t_a", title: "one", status: "todo", createdAt: 1, updatedAt: 1 },
    { id: "t_b", title: "two", status: "doing", createdAt: 1, updatedAt: 1 },
    { id: "t_c", title: "three", status: "done", createdAt: 1, updatedAt: 1 },
  ];

  test("1-based numeric index", () => {
    expect(resolveTaskRef(tasks, "3")).toBe(3);
    expect(resolveTaskRef(tasks, "1")).toBe(1);
  });

  test("task id resolves to its 1-based index", () => {
    expect(resolveTaskRef(tasks, "t_b")).toBe(2);
  });

  test("unresolvable ref is -1", () => {
    expect(resolveTaskRef(tasks, "abc")).toBe(-1);
  });

  test("out-of-range index is -1", () => {
    expect(resolveTaskRef(tasks, "0")).toBe(-1);
    expect(resolveTaskRef(tasks, "4")).toBe(-1);
    expect(resolveTaskRef(tasks, "99")).toBe(-1);
  });
});
