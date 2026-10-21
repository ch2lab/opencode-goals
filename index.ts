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
import { createHostApi } from "./src/hostapi";
import { resolveOptions, selectJudgeModel } from "./src/options";
import { SessionGenerateJudge } from "./src/judge";
import type { HostEvent, InboxRef, SessionMessage, WakeProbe } from "./src/types";

type PendingRegistration = Promise<Registration | undefined>;

// Host Tool.Info builder, shared by single (registerTool) and group
// (registerToolGroup) registration. 2.0.32 Options carries `codemode`
// (subagent precedent: codemode:false = native tools-array exposure) and
// `namespace` (the model sees `namespace_name`); older hosts ignore unknown
// option fields — in-process editor, no codec boundary.
function hostToolInfo(
  name: string,
  spec: { description: string; input: unknown; permission?: string; codemode?: boolean; namespace?: string },
  run: (input: unknown, sessionID: string) => Promise<string>,
) {
  const hasOptions =
    spec.permission !== undefined || spec.codemode !== undefined || spec.namespace !== undefined;
  return {
    name,
    input: spec.input as never, // our specs are plain JSON Schema objects
    description: spec.description,
    options: hasOptions
      ? {
          ...(spec.namespace !== undefined ? { namespace: spec.namespace } : {}),
          ...(spec.permission !== undefined ? { permission: spec.permission } : {}),
          ...(spec.codemode !== undefined ? { codemode: spec.codemode } : {}),
        }
      : undefined,
    execute: async (input: unknown, context: { sessionID: string }) => {
      // Host Tool.Result (schema/tool.d.ts): `output` is only legal when the
      // tool declares an `output` schema; ours declares none →
      // OutputValue<undefined> = never. Return `content` (string) instead —
      // the reference plugin's shape. Live A/B (2026-10-16) proved the old
      // `{ output: ... }` made the host mark every call "declared output
      // without an output schema" (status error) and hide the real result
      // text from the model.
      return { content: await run(input, context.sessionID) };
    },
  };
}

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

    // HTTP data plane (2026-10-17): the host's own services (shell store,
    // session inbox) are NOT in the in-process ctx.rpc registry (that channel
    // is host -> plugin-registered domains only); they live on the HTTP API
    // surface. hostapi discovers the local service.json registration file
    // (re-read per query), authenticates with Basic, self-identifies by pid.
    // A query failure throws here; the controller maps it to its signal.
    const hostApi = createHostApi();

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
          // §48: forward `resume` so terminal/pause notices (resume:false)
          // are records that do NOT host-auto-wake a model turn.
          resume: input.resume,
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

      // ctx.session.get({ sessionID }) -> SessionInfo { location:
      // LocationPublicRef { directory }, projectID, ... } (generated/types.d.ts).
      sessionGet: async (sessionID) => {
        const info = await ctx.session.get({ sessionID });
        return {
          location: { directory: info.location.directory },
          projectID: info.projectID,
        };
      },

      // Host inbox (hostapi): GET /api/session/:sessionID/inbox. A session
      // gone (404 SessionNotFound) is an empty list, not a failure.
      inboxList: async (sessionID) => {
        const r = await hostApi.inboxList(sessionID);
        if (r.state !== "ok") {
          throw new Error(`inbox query failed (${r.reason})`);
        }
        return r.value ?? [];
      },

      // Ruling R6: cancel needs the sessionID, carried by the inboxSessions
      // mapping (prompt results + session.inbox.enqueued events). Host cancel
      // is hostapi: DELETE /api/session/:sessionID/inbox/:inboxID. Unknown
      // inbox -> warn + skip; host failures are best-effort (never throw).
      inboxCancel: async (inboxID) => {
        const sessionID = inboxSessions.get(inboxID);
        if (sessionID === undefined) {
          console.warn(`opencode-goal: inboxCancel skipped — no session known for inbox ${inboxID}`);
          return;
        }
        const r = await hostApi.inboxCancel(sessionID, inboxID);
        if (r.state !== "ok") {
          console.warn(`opencode-goal: inboxCancel failed for ${inboxID} (${r.reason})`);
        }
      },

      // Host shell store (hostapi): GET /api/shell?location.directory=… —
      // location-scoped, running-only ("Exited commands are not included");
      // entries carry metadata.sessionID for attribution. A query failure
      // throws here (the controller maps it to its failure signal).
      shellList: async (locationDirectory) => {
        const r = await hostApi.shellList(locationDirectory);
        if (r.state !== "ok") {
          throw new Error(`shell store query failed (${r.reason})`);
        }
        return r.value ?? [];
      },

      // §52: hostapi POST /api/session/:id/background (the host's Ctrl+B
      // server action). A failure throws here — foregroundShellScan catches,
      // warns, and retries on the next scan.
      sessionBackground: async (sessionID) => {
        const r = await hostApi.sessionBackground(sessionID);
        if (r.state !== "ok") {
          throw new Error(`session background failed (${r.reason})`);
        }
      },

      // Host session list (hostapi): GET /api/session, location-scoped like
      // shellList — the goal's project's sessions, each with parentID + time
      // (the in-flight subtask-discovery source; the in-process ctx.session.get
      // above does not return parentID). A query failure throws here
      // (countSubtasksInFlight catches and fails open).
      sessionList: async (locationDirectory) => {
        const r = await hostApi.sessionList(locationDirectory);
        if (r.state !== "ok") {
          throw new Error(`session list query failed (${r.reason})`);
        }
        return r.value ?? [];
      },

      // Host active map (hostapi): GET /api/session/active, location-scoped —
      // {data: Map<sessionID, status>}, the host's in-memory liveness state
      // (the signal the UI reads; 2026-10-20 reference-UI ruling: the
      // in-flight subtask criterion is status === "running"). A query failure
      // throws here (countSubtasksInFlight catches and fails open).
      activeSessions: async (locationDirectory) => {
        const r = await hostApi.activeSessions(locationDirectory);
        if (r.state !== "ok") {
          throw new Error(`active map query failed (${r.reason})`);
        }
        return r.value ?? {};
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

      // ctx.tool.transform(e => e.namespace({ name, description })) — declares
      // the namespace the tools group under (host editor.namespace,
      // MCP-server style). The host's catalog groups by it; the model sees
      // flattened `namespace_name` tools.
      registerNamespace: (name, description) => {
        remember(
          ctx.tool.transform((e) => {
            e.namespace({ name, description });
          }).catch((err) => {
            console.warn(`opencode-goal: namespace "${name}" declaration failed:`, err);
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
            e.add(hostToolInfo(name, spec, run));
          }).catch((err) => {
            console.warn(`opencode-goal: tool "${name}" registration failed:`, err);
            return undefined;
          }),
        );
      },
      // ONE transform for the whole group (MCP-server style): one commit, one
      // Registration — atomic teardown, one catalog rebuild; a malformed
      // entry only lands in the host's registration errors (siblings safe).
      registerToolGroup: (tools) => {
        remember(
          ctx.tool.transform((e) => {
            for (const t of tools) e.add(hostToolInfo(t.name, t, t.run));
          }).catch((err) => {
            console.warn("opencode-goal: tool group registration failed:", err);
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
      // task13 closed 2026-10-20 (live smoke): mutating p.effect/p.message in
      // place IS the host's real decision channel for "evaluate" hooks —
      // proven end-to-end on a 2.0.32 production host and the isolated serve
      // host (model goal_* calls passed this hook's self-grant and reached
      // the plugin). If the mechanism ever differs, only this adapter
      // changes — the controller contract (PermissionHookInput /
      // PermissionDecision) does not.
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
