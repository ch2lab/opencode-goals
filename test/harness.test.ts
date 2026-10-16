// Meta-tests: verify the harness's own semantics (the 9 behavior contracts
// from the Task 6 brief). The harness has no failing state — these tests
// exist to pin its contract for the controller tests (Tasks 8-12).
import { expect, test } from "bun:test";
import { createGoal } from "../src/state.ts";
import { JudgeGenerator, SessionGenerateJudge } from "../src/judge.ts";
import { createHarness, type Harness } from "./harness.ts";
import type { HostEvent } from "../src/types.ts";

// --- Contract 1: emit deterministic order ---------------------------------

test("contract 1: emit keeps order — the async iterator receives events in emit order", async () => {
  const h = await createHarness();
  const types = ["session.execution.started", "session.idle", "session.execution.succeeded"];
  const got: string[] = [];
  const loop = (async () => {
    for await (const e of h.probe.eventSubscribe()) {
      got.push(e.type);
      if (got.length === types.length) return;
    }
  })();
  // Fire all three without awaiting the previous one (still in order).
  await Promise.all(
    types.map((type, i) => h.emit({ type, id: `e${i + 1}`, properties: { data: { sessionID: "s1" } } })),
  );
  await loop;
  expect(got).toEqual(types);
});

test("contract 1: event payload (id + properties) is delivered verbatim", async () => {
  const h = await createHarness();
  const seen: HostEvent[] = [];
  const loop = (async () => {
    for await (const e of h.probe.eventSubscribe()) {
      seen.push(e);
      if (seen.length === 1) return;
    }
  })();
  await h.emit({ type: "session.tool.called", id: "evt_7", properties: { data: { sessionID: "s1", input: { n: 1 } } } });
  await loop;
  expect(seen).toEqual([
    { type: "session.tool.called", id: "evt_7", properties: { data: { sessionID: "s1", input: { n: 1 } } } },
  ]);
});

// --- Contract 2: emit resolve semantics (done-promise) ---------------------

test("contract 2: await emit resolves only AFTER the consuming loop processed the event", async () => {
  const h = await createHarness();
  let processed = 0;
  const loop = (async () => {
    for await (const e of h.probe.eventSubscribe()) {
      processed += 1; // consumer body sets the flag while processing e
      if (e.type === "stop") return;
    }
  })();
  await h.emit({ type: "session.idle", properties: {} });
  expect(processed).toBe(1); // zero-race: the flag is set once emit resolved
  await h.emit({ type: "stop", properties: {} });
  await loop;
  expect(processed).toBe(2);
});

test("contract 2: emit waits for an ASYNC consumer body, not just event delivery", async () => {
  const h = await createHarness();
  let processed = 0;
  const loop = (async () => {
    for await (const e of h.probe.eventSubscribe()) {
      await new Promise((r) => setTimeout(r, 5)); // body is genuinely async
      processed += 1;
      if (e.type === "stop") return;
    }
  })();
  await h.emit({ type: "session.idle", properties: {} });
  expect(processed).toBe(1);
  await h.emit({ type: "stop", properties: {} });
  await loop;
});

test("contract 2: with no consumer, emit resolves after a microtask (dropped, no hang)", async () => {
  const h = await createHarness();
  let settled = false;
  await h.emit({ type: "session.idle", properties: {} }).then(() => {
    settled = true;
  });
  expect(settled).toBe(true);
  // The dropped event never reaches a consumer that connects later.
  const got: string[] = [];
  const loop = (async () => {
    for await (const e of h.probe.eventSubscribe()) {
      got.push(e.type);
      if (got.length === 2) return;
    }
  })();
  await h.emit({ type: "kept1", properties: {} });
  await h.emit({ type: "kept2", properties: {} });
  await loop;
  expect(got).toEqual(["kept1", "kept2"]);
});

// --- Contract 3: prompt ----------------------------------------------------

test("contract 3: prompt records the call (input as-is + incrementing id) and returns a matching InboxRef", async () => {
  const h = await createHarness();
  const input1: Harness["prompts"][number]["input"] = { sessionID: "s1", text: "a", delivery: "steer", metadata: { goal: "g1" } };
  const input2: Harness["prompts"][number]["input"] = { sessionID: "s1", text: "b" };
  const ref1 = await h.probe.prompt(input1);
  const ref2 = await h.probe.prompt(input2);
  expect(h.prompts).toEqual([
    { input: input1, id: ref1.id },
    { input: input2, id: ref2.id },
  ]);
  const n1 = Number(ref1.id.slice("inbox_".length));
  const n2 = Number(ref2.id.slice("inbox_".length));
  expect(n2).toBe(n1 + 1); // different and incrementing
  expect(ref1).toEqual({ id: ref1.id, sessionID: "s1", type: "user", delivery: "steer" });
  expect(ref2).toEqual({ id: ref2.id, sessionID: "s1", type: "user", delivery: "queue" });
});

// --- Contract 4: storage ----------------------------------------------------

test("contract 4: storageSet deep-copies (mutating the original after set does not leak)", async () => {
  const h = await createHarness();
  const original = { n: 1, nested: { arr: [1, 2] } };
  await h.probe.storageSet("goal:a", original);
  original.n = 99; // mutate the original after set
  original.nested.arr.push(3);
  expect(await h.probe.storageGet("goal:a")).toEqual({ n: 1, nested: { arr: [1, 2] } });
  // And the other direction: mutating a fetched value must not leak in.
  const fetched = (await h.probe.storageGet("goal:a")) as { n: number };
  fetched.n = 1000;
  expect(await h.probe.storageGet("goal:a")).toEqual({ n: 1, nested: { arr: [1, 2] } });
});

test("contract 4: storageScan filters by prefix; storageRemove deletes completely", async () => {
  const h = await createHarness();
  await h.probe.storageSet("goal:a", { n: 1 });
  await h.probe.storageSet("goal:b", 2);
  await h.probe.storageSet("other:c", 3);
  expect(await h.probe.storageScan("goal:")).toEqual([
    { key: "goal:a", value: { n: 1 } },
    { key: "goal:b", value: 2 },
  ]);
  expect(await h.probe.storageGet("missing")).toBeUndefined();
  await h.probe.storageRemove("goal:a");
  expect(h.storage.has("goal:a")).toBe(false);
  expect(await h.probe.storageScan("goal:")).toEqual([{ key: "goal:b", value: 2 }]);
  expect(await h.probe.storageGet("goal:a")).toBeUndefined();
});

// --- Contract 5: generate ----------------------------------------------------

test("contract 5: setGenerate(string) -> { text }, recorded; setGenerate(fn) takes the fn branch", async () => {
  const h = await createHarness();
  h.setGenerate("X");
  expect(await h.probe.generate({ sessionID: "s1", prompt: "p1" })).toEqual({ text: "X" });
  h.setGenerate(({ sessionID, prompt }) => `${sessionID}:${prompt}`);
  expect(await h.probe.generate({ sessionID: "s2", prompt: "p2" })).toEqual({ text: "s2:p2" });
  expect(h.generated).toEqual([
    { sessionID: "s1", prompt: "p1", reply: "X" },
    { sessionID: "s2", prompt: "p2", reply: "s2:p2" },
  ]);
});

test("contract 5: probe.generate is verbatim-assignable to JudgeGenerator (Task 9 wiring)", async () => {
  const h = await createHarness();
  const generator: JudgeGenerator = h.probe.generate; // compile-time: signatures must match verbatim
  h.setGenerate('{"verdict":"complete","reason":"tests green","evidence":"bun test: 138 pass"}');
  const goal = createGoal({ sessionID: "ses_t", objective: "ship" }, 1_700_000_000_000);
  const verdict = await new SessionGenerateJudge(generator).judge(goal, []);
  expect(verdict.verdict).toBe("complete");
  expect(h.generated).toHaveLength(1);
  expect(h.generated[0]).toEqual({
    sessionID: "ses_t",
    prompt: h.generated[0].prompt,
    reply: '{"verdict":"complete","reason":"tests green","evidence":"bun test: 138 pass"}',
  });
});

// --- Contract 6: rpc ---------------------------------------------------------

test("contract 6: rpcCall is a FIFO script; exhausted queue returns undefined and still records", async () => {
  const h = await createHarness();
  h.rpc.queue.push({ method: "shell.list", input: { cwd: "/w" }, reply: [{ id: "sh_1" }] });
  h.rpc.queue.push({ method: "other" });
  expect(await h.probe.rpcCall("shell.list", { cwd: "/w" })).toEqual([{ id: "sh_1" }]);
  expect(await h.probe.rpcCall("other", undefined)).toBeUndefined();
  expect(await h.probe.rpcCall("shell.list", {})).toBeUndefined(); // queue exhausted
  expect(h.rpc.queue).toEqual([]);
  expect(h.rpc.calls).toEqual([
    { method: "shell.list", input: { cwd: "/w" }, output: [{ id: "sh_1" }] },
    { method: "other", input: undefined, output: undefined },
    { method: "shell.list", input: {}, output: undefined },
  ]);
});

// --- Contract 7: inbox ---------------------------------------------------------

test("contract 7: inboxList returns deep copies; inboxCancel records (and removes) the item", async () => {
  const h = await createHarness();
  const items = [
    { id: "in_1", sessionID: "s1", type: "user" as const, payload: { text: "hi" }, delivery: "queue" as const },
    { id: "in_2", sessionID: "s1", type: "synthetic" as const, payload: { text: "note" }, delivery: "steer" as const },
  ];
  h.inbox.set("s1", items);
  const listed = await h.probe.inboxList("s1");
  expect(listed).toEqual(items);
  (listed as Array<{ payload?: Record<string, unknown> }>)[0].payload = { text: "mutated" }; // isolate result from backend
  expect(h.inbox.get("s1")?.[0]).toEqual(items[0]);
  expect(await h.probe.inboxList("missing")).toEqual([]);
  const in2 = structuredClone(items[1]); // snapshot before cancel mutates the backend array
  await h.probe.inboxCancel("in_1");
  expect(h.cancelledInbox).toEqual(["in_1"]);
  expect(await h.probe.inboxList("s1")).toEqual([in2]);
});

// --- Contract 8: sessionGet ----------------------------------------------------

test("contract 8: sessionGet -> undefined until setSession, then the configured location/projectID", async () => {
  const h = await createHarness();
  expect(await h.probe.sessionGet("s1")).toBeUndefined();
  h.setSession("s1", { location: { directory: "D:/work" }, projectID: "prj_1" });
  expect(await h.probe.sessionGet("s1")).toEqual({ location: { directory: "D:/work" }, projectID: "prj_1" });
  // Multi-location attribution: a second session with a different directory.
  h.setSession("s2", { location: { directory: "D:/other" } });
  expect(await h.probe.sessionGet("s2")).toEqual({ location: { directory: "D:/other" } });
  expect(await h.probe.sessionGet("s1")).toEqual({ location: { directory: "D:/work" }, projectID: "prj_1" });
  // Copied out: mutating the result does not leak into the backend.
  const got = (await h.probe.sessionGet("s1")) as { projectID?: string };
  got.projectID = "mutated";
  expect(await h.probe.sessionGet("s1")).toEqual({ location: { directory: "D:/work" }, projectID: "prj_1" });
});

// --- Contract 9: registration surface ------------------------------------------

test("contract 9: registration surface lands in the harness; executors drive it (R5: with sessionID); permissionHook is fault-tolerant", async () => {
  const h = await createHarness();
  const commandTexts: string[] = [];
  const commandSessions: string[] = [];
  const toolCalls: unknown[] = [];
  const toolSessions: string[] = [];
  const shellInputs: unknown[] = [];
  const sessionCalls: Array<[string, Record<string, unknown>]> = [];
  const permissionActions: string[] = [];

  h.probe.registerCommand("goal", async (text, sessionID) => {
    commandTexts.push(text);
    commandSessions.push(sessionID);
  });
  h.probe.registerTool(
    "goal_complete",
    { description: "mark the goal complete", input: { evidence: "string" }, permission: "goal.control" },
    async (input, sessionID) => {
      toolCalls.push(input);
      toolSessions.push(sessionID);
      return "complete";
    },
  );
  h.probe.onSessionHook("context", (sessionID, payload) => {
    sessionCalls.push(["context", payload]);
  });
  h.probe.onSessionHook("compaction", (sessionID, payload) => {
    sessionCalls.push(["compaction", payload]);
  });
  h.probe.onShellCreateBefore((input) => {
    shellInputs.push(input);
  });
  h.probe.onPermissionHook(async (input) => {
    permissionActions.push(input.action);
    return undefined; // R9: no stance (a silent callback leaves the host's effect alone)
  });
  const boom = new Error("permission hook boom");
  h.probe.onPermissionHook(async () => {
    throw boom;
  });

  // Everything landed in the harness's Maps/arrays.
  expect(h.commands.get("goal")).toBeTypeOf("function");
  expect(h.tools.get("goal_complete")?.spec).toEqual({
    description: "mark the goal complete",
    input: { evidence: "string" },
    permission: "goal.control",
  });
  expect(h.sessionHooks.context.length).toBe(1);
  expect(h.sessionHooks.compaction.length).toBe(1);
  expect(h.shellCreateBefore.length).toBe(1);

  // toolExecutor drives the registered tool (with its sessionID) and returns
  // its result.
  const result = await h.toolExecutor("goal_complete", { evidence: "e1" }, "s1");
  expect(result).toBe("complete");
  expect(toolCalls).toEqual([{ evidence: "e1" }]);
  expect(toolSessions).toEqual(["s1"]);
  await expect(h.toolExecutor("nope", {}, "s1")).rejects.toThrow(/unknown tool "nope"/);

  // commandExecutor drives the registered command with the text + sessionID.
  await h.commandExecutor("s1", "start the goal");
  expect(commandTexts).toEqual(["start the goal"]);
  expect(commandSessions).toEqual(["s1"]);

  // Session/shell hooks are callable through the recorded fns.
  h.sessionHooks.context[0]("s1", { info: 1 });
  h.sessionHooks.compaction[0]("s1", { result: "summary" });
  h.shellCreateBefore[0]({ command: "ls", cwd: "D:/w", timeout: 30_000 });
  expect(sessionCalls).toEqual([
    ["context", { info: 1 }],
    ["compaction", { result: "summary" }],
  ]);
  expect(shellInputs).toEqual([{ command: "ls", cwd: "D:/w", timeout: 30_000 }]);

  // permissionHook calls each callback in order, records inputs, and a
  // throwing callback is recorded (error) without reaching the caller.
  // R9: the callback sees the full PermissionHookInput (sessionID +
  // incoming; goalActive/sessionDirectory are controller facts, not input)
  // and its RETURNED decision is recorded in permissionDecisions.
  const permInput = {
    action: "fs.write",
    resources: ["D:/w/f.txt"] as readonly string[],
    sessionID: "s1",
    incoming: "ask" as const,
  };
  await h.permissionHook(permInput);
  expect(permissionActions).toEqual(["fs.write"]);
  expect(h.permissions).toHaveLength(2);
  expect(h.permissions[0].input).toEqual(permInput);
  expect(h.permissions[0].error).toBeUndefined();
  expect(h.permissions[1].input).toEqual(permInput);
  expect(h.permissions[1].error).toBe(boom);
  // Decision channel: the silent first callback records undefined; the
  // throwing second one records no decision either (recorded as undefined).
  expect(h.permissionDecisions).toEqual([undefined, undefined]);
});

// --- createHarness overrides -----------------------------------------------------

test("createHarness: only projectID / locationDirectory may be overridden", async () => {
  const h = await createHarness({ projectID: "prj_9", locationDirectory: "D:/root" });
  expect(h.probe.projectID).toBe("prj_9");
  expect(h.probe.locationDirectory).toBe("D:/root");
  await expect(createHarness({ probe: "nope" })).rejects.toThrow(/unknown override "probe"/);
});

// --- context() backend -------------------------------------------------------------

test("setMessages backs probe.context() with deep copies", async () => {
  const h = await createHarness();
  expect(await h.probe.context("s1")).toEqual([]);
  h.setMessages("s1", [
    { id: "m1", type: "user", text: "hi" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
  const msgs = await h.probe.context("s1");
  expect(msgs).toEqual([
    { id: "m1", type: "user", text: "hi" },
    { id: "m2", type: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
  (msgs as Array<Record<string, unknown>>)[0].text = "mutated"; // isolate result from backend
  const after = await h.probe.context("s1");
  expect(after).toHaveLength(2);
  expect(after[0]).toMatchObject({ id: "m1", type: "user", text: "hi" });
});
