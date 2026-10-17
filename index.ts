// OpenCode v2.0.29 goal-loop plugin entry (Task 7).
//
// This is the ONLY file that touches the real host types. It adapts the plugin
// Context to the narrow WakeProbe surface (src/types.ts) that GoalController
// depends on, wires the /goal command + goal_* tools through the real
// registration domains, registers the goals.get RPC, and returns the cleanup.
//
// Every host field used here was verified against the 2.0.29 .d.ts (citations
// inline). All host failures are best-effort: logged and swallowed, never
// re-thrown into the host (fault-tolerance discipline).
import { Plugin } from "@opencode/plugin";
import type { Registration } from "@opencode/plugin/promise/registration";
import { GoalController } from "./src/controller";
import { resolveOptions, selectJudgeModel } from "./src/options";
import { SessionGenerateJudge } from "./src/judge";
import type { HostEvent, InboxItem, InboxRef, SessionMessage, WakeProbe } from "./src/types";

type PendingRegistration = Promise<Registration | undefined>;

export default Plugin.define({
  id: "opencode-goal",
  setup: async (ctx) => {
    const options = resolveOptions(ctx.options);
    if (typeof ctx.options?.model === "string" && options.model === undefined) {
      console.warn(
        `opencode-goal: options.model "${ctx.options.model}" is malformed (expected "providerID/modelID"); ` +
          "falling back to the session's own model",
      );
    }

    // Ruling R6: inboxCancel needs the sessionID, which the narrow probe
    // surface does not carry. The adapter maintains inboxID -> sessionID,
    // collected from ctx.session.prompt() results and session.inbox.enqueued
    // events (see eventSubscribe below). Unknown inbox -> best-effort skip.
    const inboxSessions = new Map<string, string>();
    const rememberInbox = (inboxID: string, sessionID: string): void => {
      inboxSessions.set(inboxID, sessionID);
    };

    const registrations: PendingRegistration[] = [];
    const remember = (p: PendingRegistration): void => {
      registrations.push(p);
    };

    // The plugin Context exposes RPC only as typed, per-definition clients:
    // ctx.rpc(definition) -> RpcClient (plugin/dist/promise/rpc.d.ts —
    // RpcDomain extends the RpcApi generic call signature + register; there
    // is no dynamic rpc.call member). The narrow WakeProbe surface (Task 6)
    // addresses host methods by name, so everything routes through one
    // generic definition with the method name carried in the input.
    // TODO(task13): verify in live smoke that this routing matches the host's
    // method addressing (shell queries in Task 8, session inbox below).
    const rpcGeneric = ctx.rpc({
      id: "opencode-goal",
      methods: {
        call: { input: { type: "object" }, output: { type: "object" } },
      },
      events: {},
    });
    const callRpc = async (method: string, input: unknown): Promise<unknown> => {
      return (await rpcGeneric.call({ method, input: input as unknown })) as unknown;
    };

    const probe: WakeProbe = {
      // Per-session values come from sessionGet (Task 6 ruling), not from the
      // plugin's single ctx.location.
      projectID: undefined,
      locationDirectory:
        typeof ctx.location?.directory === "string" ? ctx.location.directory : undefined,

      // ctx.event.subscribe(options?) -> AsyncIterable<V2Event>
      // (client/dist/promise/client.d.ts). V2Event envelope:
      // { id, created, metadata?, type, durable?, location?, data } —
      // `durable` exists only on durable events (e.g. session.created), so it
      // is read defensively. HostEvent.id = durable seq when present, else the
      // event's own id (both plain strings in 2.0.29).
      eventSubscribe: () => {
        const source = ctx.event.subscribe();
        const src = source[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                const r = await src.next();
                if (r.done === true) return { value: undefined, done: true };
                const e = r.value;
                // Ruling R6: session.inbox.enqueued carries
                // { sessionID, inboxID, item } (generated/types.d.ts) —
                // remember the mapping for inboxCancel.
                if (e.type === "session.inbox.enqueued") {
                  const data = e.data as { sessionID?: unknown; inboxID?: unknown };
                  if (typeof data.sessionID === "string" && typeof data.inboxID === "string") {
                    rememberInbox(data.inboxID, data.sessionID);
                  }
                }
                const seq = (e as { durable?: { seq?: unknown } }).durable?.seq;
                const hostEvent: HostEvent = {
                  type: e.type,
                  id: seq !== undefined ? String(seq) : e.id,
                  properties: e.data as Record<string, unknown>,
                };
                return { value: hostEvent, done: false };
              },
              return: async () => {
                await src.return?.();
                return { value: undefined, done: true };
              },
            };
          },
        };
      },

      // ctx.session.prompt (SessionPromptInput { sessionID, text, metadata?,
      // delivery?, resume?, ... }) -> SessionInboxUser { id, sessionID,
      // time, type: "user", payload, delivery } (generated/types.d.ts).
      prompt: async (input) => {
        const item = await ctx.session.prompt({
          sessionID: input.sessionID,
          text: input.text,
          metadata: input.metadata as unknown as Record<string, never> | undefined,
          delivery: input.delivery,
          resume: input.resume,
        });
        rememberInbox(item.id, item.sessionID);
        const ref: InboxRef = {
          id: item.id,
          sessionID: item.sessionID,
          type: "user",
          delivery: item.delivery,
        };
        return ref;
      },

      // ctx.session.synthetic (SessionSyntheticInput { sessionID, text,
      // metadata?, ... }). The goalControl metadata marker rides along.
      synthetic: async (input) => {
        await ctx.session.synthetic({
          sessionID: input.sessionID,
          text: input.text,
          metadata: input.metadata as unknown as Record<string, never> | undefined,
        });
      },

      // ctx.session.context({ sessionID }) -> SessionMessageInfo[]
      // (generated/types.d.ts; per-message shapes in schema/session-message.d.ts,
      // e.g. user messages carry top-level `text`, assistant messages carry
      // content[] with text parts). The controller narrows through the index
      // signature, so the verbatim host objects are handed over.
      context: async (sessionID) => {
        const messages = await ctx.session.context({ sessionID });
        return messages.map((m) => ({ ...m })) as unknown as SessionMessage[];
      },

      // NOTE: the narrow WakeProbe surface intentionally omits `session.wait`
      // (the host has ctx.session.wait, but the controller needs no wait today
      // — re-add in a later task if the wake loop needs it).

      // ctx.storage (plugin/dist/promise/storage.d.ts):
      // get(key) -> Schema.Json | undefined; set(key, value: Schema.Json);
      // scan({ prefix }) -> { entries: [{ key, value }], next? }.
      storageGet: async (key) => {
        return (await ctx.storage.get(key)) ?? undefined;
      },
      storageSet: async (key, value) => {
        await ctx.storage.set(key, value as never); // host type is Schema.Json
      },
      storageRemove: async (key) => {
        await ctx.storage.remove(key);
      },
      storageScan: async (prefix) => {
        const result = await ctx.storage.scan({ prefix });
        // Single page: goal storage is tiny; pagination (result.next) is not
        // needed today.
        return result.entries.map((e) => ({ key: e.key, value: e.value as unknown }));
      },

      // Side-channel text generation: ctx.generate is the GenerateApi
      // (client/dist/promise/client.d.ts: generate.text(GenerateTextInput
      // { prompt, model? { id, providerID, variant? } }) -> { text }). The
      // host API takes no sessionID — the probe surface keeps it for the
      // controller contract, and it selects the side-channel model (2026-10-16):
      // explicit "model" option > the SESSION'S OWN model (ctx.session.get ->
      // SessionInfo.model — per-session, incl. an in-session switch; NOT the
      // global default) > host default (model omitted).
      generate: async (input) => {
        let sessionModel: { providerID: string; id: string; variant?: string } | undefined;
        try {
          const info = await ctx.session.get({ sessionID: input.sessionID });
          const m = (info as { model?: { id?: unknown; providerID?: unknown; variant?: unknown } })?.model;
          if (typeof m?.providerID === "string" && typeof m?.id === "string") {
            sessionModel = {
              providerID: m.providerID,
              id: m.id,
              ...(typeof m.variant === "string" ? { variant: m.variant } : {}),
            };
          }
        } catch (err) {
          // Best-effort: a session lookup failure must not break generation —
          // fall through to the host default model.
          console.warn(`opencode-goal: session model lookup failed for ${input.sessionID}:`, err);
        }
        const model = selectJudgeModel(options.model, sessionModel);
        const { text } = await ctx.generate.text({
          prompt: input.prompt,
          ...(model ? { model } : {}),
        });
        return { text };
      },

      // Generic host-method call (narrow surface). Routed through the typed
      // per-definition RPC client (see callRpc above).
      // TODO(task13): verify in live smoke (see callRpc TODO).
      rpcCall: async (method, input) => {
        return callRpc(method, input);
      },

      // ctx.session.get({ sessionID }) -> SessionInfo { location:
      // LocationPublicRef { directory }, projectID, ... } (generated/types.d.ts).
      sessionGet: async (sessionID) => {
        const info = await ctx.session.get({ sessionID });
        return {
          location: { directory: info.location.directory },
          projectID: info.projectID,
        };
      },

      // session.inbox.list({ sessionID }) -> SessionInboxInfo[] (input shape
      // SessionInboxListInput, generated/types.d.ts). NOTE: the plugin's
      // SessionDomain does not expose inbox.* — the client's session inbox
      // methods are reached over the RPC channel (Task 7 brief ruling).
      // TODO(task13): verify in live smoke that "session.inbox.list" is the
      // RPC method name the host answers.
      inboxList: async (sessionID) => {
        const raw = (await callRpc("session.inbox.list", { sessionID }) ??
          []) as Array<{
            id: string;
            sessionID: string;
            type: InboxItem["type"];
            payload?: unknown;
            delivery?: unknown;
          }>;
        return raw.map((item) => ({
          id: item.id,
          sessionID: item.sessionID,
          type: item.type,
          payload: item.payload as Record<string, unknown> | undefined,
          delivery: item.delivery as InboxItem["delivery"] | undefined,
        }));
      },

      // Ruling R6: host cancel is session.inbox.cancel({ sessionID, inboxID })
      // (SessionInboxCancelInput, generated/types.d.ts) over the RPC channel.
      // The sessionID comes from the inboxSessions mapping; unknown inbox ->
      // warn + skip (best-effort, never throw).
      inboxCancel: async (inboxID) => {
        const sessionID = inboxSessions.get(inboxID);
        if (sessionID === undefined) {
          console.warn(`opencode-goal: inboxCancel skipped — no session known for inbox ${inboxID}`);
          return;
        }
        await callRpc("session.inbox.cancel", { sessionID, inboxID });
      },

      // ctx.command.transform(e => e.add(CommandDefinition { name,
      // description?, execute(input: CommandInvocation { sessionID,
      // prompt: { text }, delivery }) })) (plugin/dist/promise/command.d.ts).
      registerCommand: (name, description, run) => {
        remember(
          ctx.command.transform((e) => {
            e.add({
              name,
              // CommandDefinition.description (schema-verified 2.0.29) — the
              // friendly hint shown in the host's / command list.
              description,
              execute: async (inv) => {
                await run(inv.prompt.text, inv.sessionID);
              },
            });
          }).catch((err) => {
            console.warn(`opencode-goal: command "${name}" registration failed:`, err);
            return undefined;
          }),
        );
      },

      // ctx.tool.transform(e => e.add(Info)) (plugin/dist/promise/tool.d.ts;
      // Info extends schema/tool.d.ts Tool.Info: { name, input: ValueSchema,
      // description, options?: { namespace?, permission? }, execute(input,
      // context: Tool.Context) }). Tool.Context carries sessionID
      // (schema/tool.d.ts — Ruling R5). execute returns a Tool.Result.
      registerTool: (name, spec, run) => {
        remember(
          ctx.tool.transform((e) => {
            e.add({
              name,
              input: spec.input as never, // our specs are plain JSON Schema objects
              description: spec.description,
              options: spec.permission !== undefined ? { permission: spec.permission } : undefined,
              execute: async (input, context) => {
                // Host Tool.Result (schema/tool.d.ts): `output` is only legal when the tool
                 // declares an `output` schema; ours declares none →
                 // OutputValue<undefined> = never. Return `content` (string)
                 // instead — the reference plugin's shape. Live A/B (2026-10-16)
                 // proved the old `{ output: ... }` made the host mark every
                 // call "declared output without an output schema" (status
                 // error) and hide the real result text from the model.
                 return { content: await run(input, context.sessionID) };
              },
            });
          }).catch((err) => {
            console.warn(`opencode-goal: tool "${name}" registration failed:`, err);
            return undefined;
          }),
        );
      },

      // ctx.session.hook("context" | "compaction", cb) — ModelHooks
      // (plugin/dist/promise/session.d.ts SessionHooks: context =
      // SessionContext, compaction = SessionCompaction — both carry sessionID
      // via SessionRequest).
      onSessionHook: (kind, fn) => {
        // Expression body (not block): the registration surface accepts a
        // `Promise<void> | void` callback and AWAITs the returned promise —
        // the controller's arrow returns its async hook work, so the host
        // sees payload.result only after the compaction flow finishes.
        // Dropping the promise (block body) would make the host read
        // payload.result before the flow completes → result always undefined.
        remember(
          ctx.session.hook(kind, (payload) =>
            fn(payload.sessionID, payload as unknown as Record<string, unknown>),
          ).catch((err) => {
            console.warn(`opencode-goal: session hook "${kind}" registration failed:`, err);
            return undefined;
          }),
        );
      },

      // ctx.shell.hook("create.before", cb) — ShellCreateBefore { command,
      // cwd, timeout, shell, env } (plugin/dist/promise/shell.d.ts).
      onShellCreateBefore: (fn) => {
        remember(
          ctx.shell.hook("create.before", (p) => {
            fn({ command: p.command, cwd: p.cwd, timeout: p.timeout });
          }).catch((err) => {
            console.warn("opencode-goal: shell create.before registration failed:", err);
            return undefined;
          }),
        );
      },

      // ctx.permission.hook("evaluate", cb) — PermissionEvaluation {
      // sessionID, agent?, action, resources, metadata?, source?, effect,
      // message? } (plugin/dist/promise/permission.d.ts; Permission.Effect =
      // "allow" | "deny" | "ask" — @opencode/schema/dist/permission.d.ts,
      // same three values as our narrow `incoming`).
      //
      // Host decision mechanism (2.0.29): Hooks<Spec> (promise/registration.d.ts)
      // types the hook callback as (input) => Promise<void> | void — there is
      // NO return-value channel. The "evaluate" hook instead expresses its
      // decision by MUTATING the payload: `effect` is the only non-readonly
      // member of PermissionEvaluation (message? is mutable too) and the host
      // reads `effect` after the callback settles. Mapping (one direction per
      // boundary, controller contract untouched):
      //   host → ours:    action, resources, sessionID, incoming = p.effect
      //                    (the effect the host has ALREADY configured);
      //   ours → host:    undefined (leave) → leave the payload untouched;
      //                    { effect, message? } → p.effect = effect,
      //                    p.message = message when present.
      // TODO(task13): confirm in live smoke that mutating p.effect/p.message
      // in place is the host's real decision channel for "evaluate" hooks
      // (and that p.effect on entry is the configured effect). If the
      // mechanism differs, only this adapter changes — the controller
      // contract (PermissionHookInput / PermissionDecision) does not.
      onPermissionHook: (fn) => {
        remember(
          ctx.permission.hook("evaluate", (p) => {
            return fn({
              action: p.action,
              resources: p.resources,
              sessionID: p.sessionID,
              incoming: p.effect,
            }).then((decision) => {
              if (decision === undefined) return; // leave: no stance
              p.effect = decision.effect;
              if (decision.message !== undefined) p.message = decision.message;
            });
          }).catch((err) => {
            console.warn("opencode-goal: permission hook registration failed:", err);
            return undefined;
          }),
        );
      },
    };

    // Task 12 folds in the judge side channel: SessionGenerateJudge over the
    // probe's generate channel (the stall ladder's single non-mechanical step
    // — deps.judge, at most one verdict per goal).
    const controller = new GoalController(probe, options, {
      tickMs: options.watchdogTickMs,
      judge: new SessionGenerateJudge(probe.generate),
    });
    const controllerCleanup = await controller.start();

    // goals.get RPC: PortableDefinition (schema/rpc.d.ts) — id + methods
    // (PortableValueSchema = JSON Schema here) + events (required key).
    // Handlers take Rpc.Output<schema> (unknown for JSON Schema) and return
    // the handler output (Promise<Rpc.HandlerOutput<...> | error>).
    const rpcRegistration = await ctx.rpc.register(
      {
        id: "opencode-goal",
        methods: {
          get: {
            input: {
              type: "object",
              properties: { sessionID: { type: "string" } },
              required: ["sessionID"],
            },
            output: { type: "object" },
          },
        },
        events: {},
      },
      {
        get: async (input) => {
          const sessionID = (input as { sessionID?: unknown } | undefined)?.sessionID;
          if (typeof sessionID !== "string") return undefined;
          return controller.snapshot(sessionID);
        },
      },
    );

    return async () => {
      await controllerCleanup();
      for (const reg of await Promise.allSettled(registrations)) {
        if (reg.status === "fulfilled" && reg.value !== undefined) {
          await reg.value.dispose().catch((err) => {
            console.warn("opencode-goal: registration dispose failed:", err);
          });
        }
      }
      await rpcRegistration.dispose().catch((err) => {
        console.warn("opencode-goal: rpc registration dispose failed:", err);
      });
    };
  },
});
