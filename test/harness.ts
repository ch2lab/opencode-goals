// Deterministic test host for the goal-loop controller (Task 6).
//
// Implements a WakeProbe fake backed by in-memory state, plus an assertion
// surface (captured calls, scriptable responses) for the controller tests.
//
// The only non-trivial piece is the event stream: a hand-rolled
// multi-consumer queue with the done-promise pattern — `emit(e)` resolves
// only after the consuming loop has PROCESSED e (the consumer re-enters
// next() or ends the stream), and with no active consumer the event is
// dropped and emit resolves after one microtask (controller ruling: a test
// must never hang on an unconsumed event).
//
// Deep copies use structuredClone (Bun native) so callers and the harness
// backends are isolated, mirroring persistence.
import type {
  HostEvent,
  InboxItem,
  InboxRef,
  PermissionDecision,
  PermissionHookInput,
  PromptInput,
  SessionMessage,
  ShellEntry,
  SyntheticInput,
  WakeProbe,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Assertion surface
// ---------------------------------------------------------------------------

export interface PromptCall {
  input: PromptInput;
  id: string;
}

export interface SyntheticCall {
  input: SyntheticInput;
}

export interface Harness {
  probe: WakeProbe; // 传给 GoalController
  emit(event: HostEvent): Promise<void>; // 推入事件流（确定序）；resolve 语义见 EventStream
  storage: Map<string, unknown>; // storageGet/Set/Remove/Scan 的后端
  prompts: PromptCall[]; // 捕获的 prompt 调用（含 metadata/delivery）
  synthetics: SyntheticCall[];
  toolExecutor(name: string, input: unknown, sessionID: string): Promise<string>; // 驱动已注册工具（R5: 携带 sessionID）
  commandExecutor(sessionID: string, text: string): Promise<void>; // 驱动已注册命令（R5: 携带 sessionID）
  setGenerate(reply: string | ((input: { sessionID: string; prompt: string }) => string)): void;
  generated: Array<{ sessionID: string; prompt: string; reply: string }>; // 记录旁路调用
  inbox: Map<string, InboxItem[]>; // 每会话 inbox（活后端：inboxCancel 会就地移除条目）；cancelledInbox 记录
  cancelledInbox: string[];
  // 调 controller 注册的 permission 回调；返回最后一次成功回调的决定（R9：决定有返回通道）
  permissionHook(input: PermissionHookInput): Promise<PermissionDecision | undefined>;
  permissions: Array<{ input: PermissionHookInput; error?: unknown }>;
  // R9: 每个回调调用的决定（throw 的回调记 undefined）
  permissionDecisions: Array<PermissionDecision | undefined>;
  setSession(sessionID: string, settings: { location?: { directory?: string }; projectID?: string; parentID?: string; outcome?: string; time?: { created?: number; updated?: number; idle?: number; viewed?: number } }): void; // sessionGet / sessionList 后端
  setMessages(sessionID: string, messages: SessionMessage[]): void; // context() 后端
  setShells(entries: ShellEntry[]): void; // host shell-store 后端（shell.list）；事件同步维护（见 emit）
  failShellList(on: boolean): void; // 脚本化 shell.list 抛错（信号不可用用例）
  shellListCalls: number; // shell.list 查询次数（活值 getter）
  commands: Map<string, (text: string, sessionID: string) => Promise<void>>;
  commandDescriptions: Map<string, string>; // 命令菜单里的友好描述（宿主 CommandDefinition.description）
  tools: Map<
    string,
    { spec: { description: string; input: unknown; permission?: string }; run: (input: unknown, sessionID: string) => Promise<string> }
  >;
  sessionHooks: {
    context: Array<(sessionID: string, payload: Record<string, unknown>) => void>;
    compaction: Array<(sessionID: string, payload: Record<string, unknown>) => void>;
  };
  shellCreateBefore: Array<(input: { command: string; cwd: string; timeout: number }) => void>;
}

// ---------------------------------------------------------------------------
// Event stream (deterministic queue with done-promises)
// ---------------------------------------------------------------------------

type StreamConsumer = {
  index: number; // next log position to hand out (no replay of old events)
  wait: ((r: IteratorResult<HostEvent>) => void) | null;
  inflight: HostEvent | null; // delivered, consumer body not yet finished
};

type PendingEmit = {
  event: HostEvent;
  acks: Set<StreamConsumer>; // consumers that received it and must process it
  orphan: boolean; // no active consumer at emit time -> droppable
  done: boolean;
  resolve: () => void;
};

class EventStream {
  private log: HostEvent[] = [];
  private consumers = new Set<StreamConsumer>();
  private pending: PendingEmit[] = [];

  /** ctx.event.subscribe() stand-in: every subscriber gets future events in order. */
  subscribe(): AsyncIterable<HostEvent> {
    return { [Symbol.asyncIterator]: () => this.iterator() };
  }

  /**
   * Push an event into the stream (deterministic order) and return a promise
   * that resolves once the consuming loop(s) have processed it. With no
   * active consumer the event is dropped and the promise resolves after one
   * microtask (ruling: never hang a test).
   */
  emit(event: HostEvent): Promise<void> {
    const pending: PendingEmit = {
      event,
      acks: new Set(),
      orphan: this.consumers.size === 0,
      done: false,
      resolve: () => {},
    };
    const done = new Promise<void>((resolve) => {
      pending.resolve = resolve;
    });
    this.log.push(event);
    this.pending.push(pending);
    this.deliver();
    if (pending.orphan) {
      queueMicrotask(() => {
        if (!pending.done && pending.acks.size === 0 && this.consumers.size === 0) {
          this.finish(pending);
        }
      });
    }
    return done;
  }

  private iterator(): AsyncIterator<HostEvent> {
    const self = this;
    const c: StreamConsumer = { index: this.log.length, wait: null, inflight: null };
    this.consumers.add(c);
    // A late subscriber never replays history: any orphan event it cannot
    // receive is dropped (its emit resolves) instead of hanging forever.
    for (const p of this.pending) {
      if (!p.done && p.orphan && p.acks.size === 0) this.finish(p);
    }
    // Methods on the returned literal get `this` = the literal, so the
    // stream is referenced through `self`.
    return {
      next(): Promise<IteratorResult<HostEvent>> {
        if (c.inflight !== null) {
          // Re-pumping means the consumer's body for the previous event
          // has finished -> that event is "processed".
          self.ack(c);
          c.inflight = null;
        }
        const event = self.log[c.index];
        if (event !== undefined) {
          c.index += 1;
          c.inflight = event;
          self.markDelivered(event, c);
          return Promise.resolve({ value: event, done: false });
        }
        return new Promise<IteratorResult<HostEvent>>((resolve) => {
          c.wait = resolve;
        });
      },
      return(): Promise<IteratorResult<HostEvent>> {
        self.end(c);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  private markDelivered(event: HostEvent, c: StreamConsumer): void {
    for (const p of this.pending) {
      if (p.event === event && !p.done) p.acks.add(c);
    }
  }

  private ack(c: StreamConsumer): void {
    for (const p of this.pending) {
      if (p.acks.delete(c) && !p.done && p.acks.size === 0) this.finish(p);
    }
  }

  private finish(p: PendingEmit): void {
    if (p.done) return;
    p.done = true;
    p.resolve();
  }

  /** Hand the next buffered event to every consumer with a free slot. */
  private deliver(): void {
    for (const c of this.consumers) {
      if (c.inflight !== null || c.wait === null) continue;
      const event = this.log[c.index];
      if (event === undefined) continue;
      c.index += 1;
      c.inflight = event;
      this.markDelivered(event, c);
      const wait = c.wait;
      c.wait = null;
      wait({ value: event, done: false });
    }
  }

  private end(c: StreamConsumer): void {
    this.consumers.delete(c);
    if (c.inflight !== null) {
      // The loop ended only after its body ran: the event was processed.
      this.ack(c);
      c.inflight = null;
    }
    if (c.wait !== null) {
      const wait = c.wait;
      c.wait = null;
      wait({ value: undefined, done: true });
    }
    if (this.consumers.size === 0) {
      // Nobody left to consume: drop everything still in flight so no
      // emit can hang.
      for (const p of this.pending) if (!p.done) this.finish(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Harness factory
// ---------------------------------------------------------------------------

const OVERRIDE_KEYS = ["projectID", "locationDirectory"] as const;

export async function createHarness(overrides?: Record<string, unknown>): Promise<Harness> {
  // Keep the surface minimal: only the probe's static fields are overridable.
  for (const key of Object.keys(overrides ?? {})) {
    if (!OVERRIDE_KEYS.includes(key as (typeof OVERRIDE_KEYS)[number])) {
      throw new Error(`createHarness: unknown override "${key}" (allowed: ${OVERRIDE_KEYS.join(", ")})`);
    }
  }

  const stream = new EventStream();
  const storage = new Map<string, unknown>();
  const sessions = new Map<string, { location?: { directory?: string }; projectID?: string; parentID?: string; outcome?: string; time?: { created?: number; updated?: number; idle?: number; viewed?: number } }>();
  const messages = new Map<string, SessionMessage[]>();
  const inbox = new Map<string, InboxItem[]>();
  const cancelledInbox: string[] = [];
  const prompts: PromptCall[] = [];
  const synthetics: SyntheticCall[] = [];
  const generated: Harness["generated"] = [];
  const permissions: Harness["permissions"] = [];
  const permissionDecisions: Harness["permissionDecisions"] = [];
  const commands: Harness["commands"] = new Map();
  const commandDescriptions: Harness["commandDescriptions"] = new Map();
  const tools: Harness["tools"] = new Map();
  const sessionHooks: Harness["sessionHooks"] = { context: [], compaction: [] };
  const shellCreateBefore: Harness["shellCreateBefore"] = [];
  const permissionFns: Array<(input: PermissionHookInput) => Promise<PermissionDecision | undefined>> = [];
  let inboxSeq = 0;
  let generateReply: string | ((input: { sessionID: string; prompt: string }) => string) = "";
  // Host shell store (contract: location-scoped, running-only, self-pruning —
  // "Exited commands are not included"). Maintained by emit() like the host;
  // model-originated shells (no events on the real host) enter via setShells.
  let shellStore: ShellEntry[] = [];
  let shellListFail = false;
  let shellListCalls = 0;

  const probe: WakeProbe = {
    projectID: typeof overrides?.projectID === "string" ? overrides.projectID : undefined,
    locationDirectory: typeof overrides?.locationDirectory === "string" ? overrides.locationDirectory : undefined,
    eventSubscribe: () => stream.subscribe(),
    prompt: async (input) => {
      const id = `inbox_${++inboxSeq}`;
      prompts.push({ input: structuredClone(input), id });
      const ref: InboxRef = {
        id,
        sessionID: input.sessionID,
        type: "user",
        delivery: input.delivery ?? "queue",
      };
      return ref;
    },
    synthetic: async (input) => {
      synthetics.push({ input: structuredClone(input) });
    },
    context: async (sessionID) => structuredClone(messages.get(sessionID) ?? []),
    storageGet: async (key) => structuredClone(storage.get(key)),
    storageSet: async (key, value) => {
      storage.set(key, structuredClone(value));
    },
    storageRemove: async (key) => {
      storage.delete(key);
    },
    storageScan: async (prefix) => {
      const out: Array<{ key: string; value: unknown }> = [];
      for (const [key, value] of storage) {
        if (key.startsWith(prefix)) out.push({ key, value: structuredClone(value) });
      }
      return out;
    },
    // Signature is verbatim-compatible with src/judge.ts JudgeGenerator —
    // Task 9 passes probe.generate straight into new SessionGenerateJudge().
    generate: async ({ sessionID, prompt }) => {
      const reply = typeof generateReply === "function" ? generateReply({ sessionID, prompt }) : generateReply;
      generated.push({ sessionID, prompt, reply });
      return { text: reply };
    },
    sessionGet: async (sessionID) => structuredClone(sessions.get(sessionID)),
    sessionList: async () =>
      structuredClone(
        [...sessions.entries()].map(([id, s]) => ({
          id,
          projectID: s.projectID,
          parentID: s.parentID,
          outcome: s.outcome,
          time: s.time,
        })),
      ),
    inboxList: async (sessionID) => structuredClone(inbox.get(sessionID) ?? []),
    inboxCancel: async (inboxID) => {
      cancelledInbox.push(inboxID);
      for (const items of inbox.values()) {
        const i = items.findIndex((item) => item.id === inboxID);
        if (i !== -1) {
          items.splice(i, 1);
          break;
        }
      }
    },
    shellList: async () => {
      if (shellListFail) throw new Error("shell store query failed (scripted)");
      shellListCalls += 1;
      return structuredClone(shellStore);
    },
    registerCommand: (name, description, run) => {
      commands.set(name, run);
      commandDescriptions.set(name, description);
    },
    registerTool: (name, spec, run) => {
      tools.set(name, { spec: { ...spec }, run });
    },
    onSessionHook: (kind, fn) => {
      sessionHooks[kind].push(fn);
    },
    onShellCreateBefore: (fn) => {
      shellCreateBefore.push(fn);
    },
    onPermissionHook: (fn) => {
      permissionFns.push(fn);
    },
  };

  const harness: Harness = {
    probe,
    emit: (event) => {
      // Mirror the host: the shell store is host-maintained — started adds a
      // running entry, ended removes it (exited shells are not in the store).
      // On the real host, model-originated shells get NO events; such entries
      // are injected directly via setShells in tests.
      if (event.type === "session.shell.started") {
        const p = event.properties as { sessionID?: string; shell?: { id?: string; status?: string } };
        if (p?.sessionID !== undefined && p.shell?.id !== undefined) {
          shellStore.push({ id: p.shell.id, status: p.shell.status ?? "running", sessionID: p.sessionID });
        }
      } else if (event.type === "session.shell.ended") {
        const id = (event.properties as { shell?: { id?: string } })?.shell?.id;
        if (id !== undefined) shellStore = shellStore.filter((e) => e.id !== id);
      }
      return stream.emit(event);
    },
    storage,
    prompts,
    synthetics,
    toolExecutor: async (name, input, sessionID) => {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error(`toolExecutor: unknown tool "${name}"`);
      return tool.run(input, sessionID);
    },
    commandExecutor: async (sessionID, text) => {
      // Mirror the real host: route by command name. The test passes either the
      // full "/goal set x" form (name + args, as a user types it) or the bare
      // host-routed remainder "set x" (the host strips the command name before
      // calling us). The bare remainder always routes to the master "goal".
      const trimmed = text.trim();
      let name: string;
      let rest: string;
      if (trimmed.startsWith("/")) {
        const sp = trimmed.indexOf(" ");
        const head = sp === -1 ? trimmed : trimmed.slice(0, sp);
        name = head.slice(1); // drop the leading "/"
        rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
      } else {
        name = "goal";
        rest = trimmed;
      }
      const run = commands.get(name);
      if (run === undefined) throw new Error(`commandExecutor: unknown command "${name}"`);
      await run(rest, sessionID);
    },
    setGenerate: (reply) => {
      generateReply = reply;
    },
    generated,
    inbox,
    cancelledInbox,
    permissionHook: async (input) => {
      // R9: decisions are recorded per callback (undefined for a throwing
      // one) and the LAST successful callback's decision is returned.
      let last: PermissionDecision | undefined;
      for (const fn of permissionFns) {
        try {
          last = await fn(input);
          permissions.push({ input: structuredClone(input) });
          permissionDecisions.push(last);
        } catch (error) {
          // Fault-tolerance discipline: a throwing callback is recorded,
          // not propagated to the caller (and records no decision).
          permissions.push({ input: structuredClone(input), error });
          permissionDecisions.push(undefined);
        }
      }
      return last;
    },
    permissions,
    permissionDecisions,
    setSession: (sessionID, settings) => {
      sessions.set(sessionID, structuredClone(settings));
    },
    setShells: (entries) => {
      shellStore = structuredClone(entries);
    },
    failShellList: (on) => {
      shellListFail = on;
    },
    get shellListCalls() {
      return shellListCalls;
    },
    setMessages: (sessionID, msgs) => {
      messages.set(sessionID, structuredClone(msgs));
    },
    commands,
    commandDescriptions,
    tools,
    sessionHooks,
    shellCreateBefore,
  };
  return harness;
}
