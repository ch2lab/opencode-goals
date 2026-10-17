// Task 12: permission sandbox wiring (goal.control self-grant + path
// containment), driven through the deterministic harness's permissionHook
// (R9 surface: input carries sessionID + incoming; the callback RETURNS a
// decision, undefined = leave / no stance).
//
// Precondition per the brief: createHarness({ projectID: "p1" }) (harness
// overrides) + controller start + h.setSession laying the session(s).
// The wiring order (controller brief, all mechanical): incoming deny ->
// leave, no sessionID -> leave, project attribution, self-lookup goalActive,
// decidePermission (per-session directory, fallback instance default),
// leave -> undefined. Any exception -> undefined (warn, never throw).
// decidePermission's pure logic is Task 3's and untouched here — these
// tests exercise the WIRING over it.
import { expect, test } from "bun:test";
import { resolveOptions } from "../src/options.ts";
import { GoalController } from "../src/controller.ts";
import { createHarness, type Harness } from "./harness.ts";

async function boot(): Promise<{ h: Harness; stop: () => Promise<void> }> {
  const h = await createHarness({ projectID: "p1" });
  const ctrl = new GoalController(h.probe, resolveOptions({}));
  const stop = await ctrl.start();
  return { h, stop };
}

/** Lay an active goal via the /goal command surface. */
async function setGoal(h: Harness, sessionID: string): Promise<void> {
  await h.commandExecutor(sessionID, "set build the thing");
}

test("1: self-grant — active goal allows goal.control even with empty resources (control plane is separated from the data plane)", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "goal.control",
      resources: [],
      sessionID: "s1",
      incoming: "ask",
    });
    expect(decision).toEqual({ effect: "allow" });
    // R9 decision channel recorded by the harness.
    expect(h.permissionDecisions).toEqual([{ effect: "allow" }]);
  } finally {
    await stop();
  }
});

test("2: in-directory read — no stance (reads are unrestricted, 2026-10-17 ruling)", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "fs.read",
      resources: ["/proj/a.txt"],
      sessionID: "s1",
      incoming: "ask",
    });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("3: out-of-directory read — no stance (reads are unrestricted, 2026-10-17 ruling)", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "fs.read",
      resources: ["/etc/passwd"],
      sessionID: "s1",
      incoming: "ask",
    });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("4: no active goal — no stance (undefined); a paused goal counts the same", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    // No goal at all.
    expect(await h.permissionHook({ action: "fs.read", resources: ["/proj/a.txt"], sessionID: "s1", incoming: "ask" })).toBeUndefined();
    // A paused goal is not active.
    await setGoal(h, "s1");
    await h.commandExecutor("s1", "pause");
    expect(await h.permissionHook({ action: "fs.read", resources: ["/proj/a.txt"], sessionID: "s1", incoming: "ask" })).toBeUndefined();
  } finally {
    await stop();
  }
});

test("5: configured deny — never relaxed (undefined), even with an active goal and an in-directory path", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "fs.read",
      resources: ["/proj/a.txt"],
      sessionID: "s1",
      incoming: "deny",
    });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("6: configured allow — not re-stated (undefined)", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "fs.read",
      resources: ["/proj/a.txt"],
      sessionID: "s1",
      incoming: "allow",
    });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("7: multi-location attribution — a session of another project gets no stance", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s2", { projectID: "other" });
    await setGoal(h, "s2");
    const decision = await h.permissionHook({
      action: "goal.control",
      resources: [],
      sessionID: "s2",
      incoming: "ask",
    });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("8: missing sessionID — no attribution possible, no stance", async () => {
  const { h, stop } = await boot();
  try {
    const decision = await h.permissionHook({ action: "goal.control", resources: [], incoming: "ask" });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("9: windows read through the real wiring — no stance (reads are unrestricted)", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "D:\\dev\\proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "fs.read",
      resources: ["d:/dev/proj\\x.txt"],
      sessionID: "s1",
      incoming: "ask",
    });
    expect(decision).toBeUndefined();
  } finally {
    await stop();
  }
});

test("11: out-of-directory WRITE — denied with a message naming the path and goal_block", async () => {
  const { h, stop } = await boot();
  try {
    h.setSession("s1", { location: { directory: "/proj" } });
    await setGoal(h, "s1");
    const decision = await h.permissionHook({
      action: "fs.write",
      resources: ["/etc/passwd"],
      sessionID: "s1",
      incoming: "ask",
    });
    expect(decision?.effect).toBe("deny");
    expect(decision?.message).toContain("/etc/passwd");
    expect(decision?.message).toContain("goal_block");
  } finally {
    await stop();
  }
});

test("10: hook never throws — a rejecting sessionGet still resolves with undefined (no stance)", async () => {
  const { h, stop } = await boot();
  const originalSessionGet = h.probe.sessionGet;
  // Fake a broken session lookup (the fake 铺一个 reject 的会话).
  h.probe.sessionGet = async () => {
    throw new Error("session storage exploded");
  };
  try {
    const decision = await h.permissionHook({
      action: "goal.control",
      resources: [],
      sessionID: "s1",
      incoming: "ask",
    });
    expect(decision).toBeUndefined();
  } finally {
    h.probe.sessionGet = originalSessionGet;
    await stop();
  }
});
