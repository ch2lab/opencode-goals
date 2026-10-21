// Minimal host slice the goal-loop controller depends on
// (OpenCode v2.0.29, plugin promise API).
//
// Zero-import discipline: this file only consumes its own definitions.
// Every shape below is a narrowed transcription of the 2.0.29 host types
// (source noted per type). The adapter (Task 7) is the only file that
// touches real host types; the controller depends only on WakeProbe plus
// these payload types; tests implement WakeProbe (test/harness.ts).
//
// .d.ts anchors (node_modules/@opencode, verified 2.0.29):
//   plugin/dist/promise/session.d.ts        SessionPrompt (sessionID, prompt,
//                                           metadata?, delivery), SessionDomain
//                                           (prompt/generate/synthetic/wait/
//                                           context), SessionCompaction
//                                           (result?: { summary } — Task 11)
//   client/dist/promise/client.d.ts         session.prompt -> Promise<SessionInboxUser>,
//                                           session.synthetic -> Promise<SessionInboxSynthetic>,
//                                           session.context -> Promise<SessionMessageInfo[]>,
//                                           session.generate -> Promise<{ text }>,
//                                           session.get -> Promise<SessionInfo>,
//                                           session.inbox.list/cancel,
//                                           event.subscribe -> AsyncIterable<V2Event>
//   client/dist/promise/generated/types.d.ts SessionPromptInput, SessionSyntheticInput,
//                                           SessionInboxUser/Synthetic/Compaction/Move,
//                                           SessionInboxInfo, SessionMessageInfo, V2Event,
//                                           SessionInfo, LocationPublicRef
//   schema/dist/session-inbox.d.ts          Delivery = "steer" | "queue"; inbox item
//                                           type tags user/synthetic/compaction/move
//   schema/dist/session-message.d.ts        per-message shapes (id, type tag, time,
//                                           metadata? on most)
//   schema/dist/tool.d.ts                  Tool.Info { name, input, description,
//                                           options?: { namespace?, permission?, codemode? } }
//   plugin/dist/promise/shell.d.ts          ShellCreateBefore { command, cwd,
//                                           timeout, shell, env }
//   plugin/dist/promise/permission.d.ts     PermissionEvaluation { sessionID,
//                                           agent?, action, resources, metadata?,
//                                           source?, effect, message? }
//   plugin/dist/storage.d.ts + promise/storage.d.ts
//                                           get/set/remove/scan(prefix) -> entries { key, value }
//   plugin/dist/promise/command.d.ts        CommandDefinition { name, description?,
//                                           execute(input: { sessionID, prompt, delivery }) }

/**
 * Generic event envelope for controller consumption.
 *
 * The host V2Event envelope (client/dist/promise/generated/types.d.ts) is
 * `{ id, created, metadata?, type, durable?: { aggregateID, seq, version },
 * location?, data: {...} }`. The adapter maps `type` -> `type`, `id` (or
 * `durable.seq` when the host carries a durable sequence) -> `id`,
 * `data` -> `properties`. `id` drives the controller's `lastHandledEventID`
 * dedup.
 *
 * Kinds the controller consumes (spec §4): session.execution.started /
 * succeeded / failed / interrupted, session.idle, session.tool.called,
 * shell.created, shell.exited, session.usage.updated,
 * session.compaction.started / ended / failed,
 * session.inbox.enqueued / delivered.
 *
 * Inner `properties` field names (data.sessionID, data.info, durable.seq, …)
 * are deliberately NOT hardcoded here: the controller does narrow per-kind
 * access with comments (Task 8).
 */
export interface HostEvent {
  type: string;
  id?: string;
  properties: Record<string, unknown>;
}

/**
 * Narrowed ctx.session.prompt input (host: SessionPromptInput).
 * The host also carries `id?`, `files?`, `agents?`, `skills?` (mention
 * attachments) which the goal loop never sends; `resume` is kept because the
 * host exposes it (SessionPromptInput.resume?: boolean | null) and the goal
 * loop may re-arm the agent with it.
 */
export interface PromptInput {
  sessionID: string;
  text: string;
  /** host: SessionInbox.Delivery = "steer" | "queue" (schema/dist/session-inbox.d.ts) */
  delivery?: "steer" | "queue";
  metadata?: Record<string, unknown>;
  /** host SessionPromptInput.resume?: boolean | null */
  resume?: boolean | null;
}

/**
 * Narrowed inbox item returned by ctx.session.prompt (host: SessionInboxUser).
 * The host item also has `time: { created }` and `payload` (text/files/
 * metadata); only `id` is needed by the controller (dedup + wake receipts).
 */
export interface InboxRef {
  id: string;
  sessionID: string;
  type: "user";
  delivery: "steer" | "queue";
}

/**
 * Narrowed ctx.session.synthetic input (host: SessionSyntheticInput).
 * The host also carries `id?`, `description?`, `delivery?`, `resume?` — the
 * goal loop sends text + metadata, and `resume: false` for terminal/pause
 * notices (records that must not host-auto-wake; spec §48).
 */
export interface SyntheticInput {
  sessionID: string;
  text: string;
  /**
   * host: SessionSyntheticInput.metadata (Record<string, JsonValue>). The
   * goal loop's user-visible feedback always carries { goalControl: true } —
   * the Task 8 arbiter depends on this marker.
   */
  metadata?: Record<string, unknown>;
  /**
   * host: SessionSyntheticInput.resume?: boolean. The host auto-wakes a
   * synthetic on admission (default delivery "steer" + execution.wake), so a
   * goalControl record would kick a model turn unless `resume: false`.
   * Terminal/pause notices are RECORDS (not wakes) and pass `resume: false`
   * (spec §48). Command result lines (handleCommand) omit it — their kick is
   * the intended /goal set / resume trigger.
   */
  resume?: boolean | null;
}

/**
 * Narrowed inbox item (host: SessionInboxInfo = SessionInboxUser |
 * SessionInboxSynthetic | SessionInboxCompaction | SessionInboxMove — all
 * four carry id, sessionID, time, type, payload, delivery). `type` is the
 * discriminator the controller uses for lastInbox attribution.
 */
export interface InboxItem {
  id: string;
  sessionID: string;
  type: "user" | "synthetic" | "compaction" | "move";
  payload?: Record<string, unknown>;
  delivery?: "steer" | "queue";
}

/**
 * Minimal session message (host: SessionMessageInfo — the 11-member union
 * from schema/dist/session-message.d.ts: "agent-switched",
 * "model-switched", "location-switched", "user", "synthetic", "system",
 * "skill", "shell", "assistant", "compaction", "idle"; every member has
 * `id` + `type`, all have `time`, most have `metadata?`). The controller
 * narrows access to the fields it needs (e.g. user/assistant text) through
 * the index signature.
 */
export interface SessionMessage {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Permission hook payload (R9): what the HOST hands in — the action, its
 * resources, the session attribution (`sessionID`) and the host's ALREADY
 * CONFIGURED effect (`incoming` = host Permission.Effect,
 * "allow" | "deny" | "ask"). `goalStatus` and `sessionDirectory` are
 * deliberately NOT here: they are facts the controller looks up itself
 * (storage / sessionGet) — not host input (controller ruling R9).
 */
export interface PermissionHookInput {
  action: string;
  resources: readonly string[];
  sessionID?: string;
  incoming: "allow" | "ask" | "deny";
}

/**
 * The controller's stance on one permission evaluation. Structurally
 * compatible with the non-"leave" arms of src/permission.ts
 * `PermissionDecision` (zero-import discipline: defined inline here rather
 * than imported). The ABSENCE of a value (`undefined`) is "leave" — no
 * stance, the host keeps its own configured effect.
 */
export type PermissionDecision = { effect: "allow" | "deny"; message?: string };

/** A running shell as reported by the host shell store (shell.list).
 * Contract pinned 2026-10-17 (2.0.32 binary forensics): location-scoped and
 * running-only ("Exited commands are not included"); metadata.sessionID
 * attributes the shell to the session that started it (absent = unattributed). */
export interface ShellEntry {
  id: string;
  status: string; // "running"
  sessionID?: string;
  /** Host shell store: start timestamp (ms) — §51 check-in roster shows the
   * elapsed time. Optional: the harness may omit it (roster then shows the
   * bare id). */
  time?: { started?: number };
  /** §52: true when the shell runs in background observation (the host's
   * `metadata.background` — Ctrl+B / session.background semantics). Absent
   * or false = foreground (blocking) shell. */
  background?: boolean;
}

/**
 * The probe the controller codes against. The real host (adapter, Task 7)
 * and the deterministic test harness (test/harness.ts) both implement it.
 */
/** Host session record (GET /api/session list item) — the in-flight gate reads
 * `parentID` (subtask attribution: whose parent chain walks back to the goal
 * session). `time`/`outcome` are carried for completeness but are NO LONGER
 * the liveness criterion (2026-10-20 reference-UI ruling: the host's active
 * map, sessionID→status, is the in-flight signal — these time fields go stale
 * and counted dead sessions forever: the 1.1.3 zombie lock). Same source the
 * host UI reads — the in-process `ctx.session.get` does NOT return `parentID`. */
export interface HostSession {
  id: string;
  projectID?: string;
  parentID?: string;
  outcome?: string;
  time?: { created?: number; updated?: number; idle?: number; viewed?: number };
  [key: string]: unknown;
}

export interface WakeProbe {
  eventSubscribe(): AsyncIterable<HostEvent>; // ctx.event.subscribe()
  prompt(input: PromptInput): Promise<InboxRef>; // ctx.session.prompt()（delivery/metadata/resume）
  synthetic(input: SyntheticInput): Promise<void>;
  context(sessionID: string): Promise<SessionMessage[]>;
  storageGet(key: string): Promise<unknown>;
  storageSet(key: string, value: unknown): Promise<void>;
  storageRemove(key: string): Promise<void>;
  storageScan(prefix: string): Promise<Array<{ key: string; value: unknown }>>;
  generate(input: { sessionID: string; prompt: string }): Promise<{ text: string }>;
  sessionGet(sessionID: string): Promise<{ location?: { directory?: string }; projectID?: string } | undefined>;
  inboxList(sessionID: string): Promise<InboxItem[]>; // hostapi GET /api/session/:id/inbox
  inboxCancel(inboxID: string): Promise<void>; // hostapi DELETE /api/session/:id/inbox/:inboxID
  shellList(locationDirectory: string): Promise<ShellEntry[]>; // hostapi GET /api/shell（宿主 shell store）
  /** §52: POST /api/session/:sessionID/background（宿主 Ctrl+B 的服务端动作，
   * 2026-10-21 活宿主 openapi.json 实锤）——把该会话所有前台阻塞的
   * backgroundable 工具转后台观察（继续运行）+ 宿主注入 synthetic。
   * 失败 throw（调用方 catch + 下次扫描重试）。 */
  sessionBackground(sessionID: string): Promise<void>;
  sessionList(locationDirectory: string): Promise<HostSession[]>; // hostapi GET /api/session（按目录限定，同 shellList；parentID 链 = 子任务归属源）
  activeSessions(locationDirectory: string): Promise<Record<string, string>>; // hostapi GET /api/session/active（参考UI 在飞判据，2026-10-20：sessionID→status，"running" = 在飞；缺条目 = idle）
  projectID?: string;
  locationDirectory?: string;
  // —— 注册面（adapter 转真实 ctx；harness 记录供断言；hook 载荷字段以 2.0.29 .d.ts 为准）——
  // Ruling R5: command invocations (CommandInvocation) and tool contexts
  // (Tool.Context) both carry sessionID in 2.0.29 — multi-session attribution.
  registerCommand(name: string, description: string, run: (text: string, sessionID: string) => Promise<void>): void;
  // Host namespace declaration (MCP-server style; host editor.namespace): the
  // tools below carry this name in spec.namespace; the host flattens the
  // model-visible name to `namespace_name` (effectiveName).
  registerNamespace(name: string, description: string): void;
  registerTool(name: string, spec: { description: string; input: unknown; permission?: string; codemode?: boolean; namespace?: string }, run: (input: unknown, sessionID: string) => Promise<string>): void;
  // ONE group registration (2026-10-20 ruling, MCP-server style): the host
  // commits all entries in a single transform → ONE Registration (atomic
  // teardown, one catalog commit); a malformed entry only lands in the
  // host's registration errors, siblings unaffected.
  registerToolGroup(tools: Array<{
    name: string;
    description: string;
    input: unknown;
    permission?: string;
    codemode?: boolean;
    namespace?: string;
    run: (input: unknown, sessionID: string) => Promise<string>;
  }>): void;
  onSessionHook(kind: "context" | "compaction", fn: (sessionID: string, payload: Record<string, unknown>) => void): void;
  onShellCreateBefore(fn: (input: { command: string; cwd: string; timeout: number }) => void): void;
  // R9: the callback receives the full PermissionHookInput and RETURNS its
  // decision (undefined = no stance / leave); goalStatus is the controller's
  // own fact, never an input.
  onPermissionHook(fn: (input: PermissionHookInput) => Promise<PermissionDecision | undefined>): void;
}
