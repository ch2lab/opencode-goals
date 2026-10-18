# @ch2lab/opencode-goals

OpenCode v2 目标循环插件：给模型一个"设定目标 → 自主执行 → 证据门控收尾"的循环，面向无人值守长任务。

An OpenCode v2 goal-loop plugin: gives the model a "set goal → work autonomously → evidence-gated completion" loop, built for unattended long-running tasks.

源码仓库（MIT 协议）：[github.com/ch2lab/opencode-goals](https://github.com/ch2lab/opencode-goals) · 问题与反馈走 [GitHub Issues](https://github.com/ch2lab/opencode-goals/issues)

Source (MIT): [github.com/ch2lab/opencode-goals](https://github.com/ch2lab/opencode-goals) · Feedback via [GitHub Issues](https://github.com/ch2lab/opencode-goals/issues)

## 它解决什么问题 · What It Solves

无人值守的长任务（跨夜重构、迁移、"改到测试全绿为止"）有三种典型失败：

Unattended long tasks (overnight refactors, migrations, "keep going until the tests pass") fail in three characteristic ways:

- **静默停滞**：模型自认为做完了就停下，实际只完成一半，且无人察觉；
  **Silent stall** — the model believes it is done and stops while the work is half-finished, with nobody to notice;
- **假完成**：模型宣布"完成"，但没有可核查的依据；
  **Fake completion** — the model declares "done" with no verifiable basis;
- **长脚本挂起**：脚本长时间运行，会话空转，无人查看状态。
  **Long script hangs** — a script runs for a long time; the session idles and nobody checks on it.

本插件给宿主一个目标状态机 + 唤醒机制，让模型"边干边被盯着"：

This plugin gives the host a goal state machine + a wake mechanism, so the model works "with a supervisor":

| 机制 Mechanism | 作用 Effect |
|---|---|
| 目标循环 Goal loop | 每个执行边界（回合成功/失败、会话空闲、脚本退出）至多唤醒一次；有后台工作在飞时不立即唤醒，静默期后武装一次性进展检查；模型继续推进，直到目标收尾或预算耗尽。 Wakes the model at most once per execution boundary (turn success/failure, session idle, script exit); a boundary with background work in flight does not wake immediately — it arms a one-shot progress check after a silence window. |
| 证据门控 Evidence gate | `complete` 必须给出具体、可核查的证据（≥24 字符、锚定事实、接地于对话），否则视为未完成。 `complete` requires concrete, verifiable evidence (≥24 chars, fact-anchored, grounded in the conversation); otherwise it counts as not done. |
| 停滞仲裁 Stall arbitration | 连续 N（默认 3）次"无动作"唤醒达到上限 → **默认直接把 goal 标记为 stalled**（停滞报告 + 归档，浮出给人裁决）；旁路 LLM 裁判是**可选**仲裁（`judgeEnabled` 开启时，停滞前每 goal 至多解读 1 次停滞原因：继续 / 收尾 / 转人工；裁判输出不可解析 = give up，绝不伪造）。 Consecutive no-action wakes (default 3) reaching the limit → **by default the goal is marked stalled outright** (stall report + archive, surfaced to the human); the bypass LLM judge is **opt-in** (with `judgeEnabled` on, it interprets the stall cause at most once per goal before stalling: continue / wrap up / hand off; unparseable judge output = give up, never fabricated). |
| 看门狗 Watchdog | 零主动检查：脚本退出 → 结果唤醒（纯事件驱动）；有后台工作在飞（shell/子任务会话）的边界不立即唤醒，武装一次性进展检查（静默 `checkInDelaySec` 秒后触发），期间任何活动取消它。 No active checking: script exit → result wake (event-driven); a boundary with in-flight background work (shells / subtask sessions) does not wake — it arms a one-shot progress check that fires after `checkInDelaySec` of silence, and any activity cancels it. |
| 预算 Budget | 默认 10 turns；token 默认**仅统计、不设限**，上限可 opt-in（`--tokens N` / `defaultCapTokens`）。 Default 10 turns; tokens are stats-only by default — a cap is opt-in. |
| 待办任务 Task list | 每 goal 无上限（2026-10-18 裁定撤销 50 上限；结算历史归项目文档），`todo / doing / done` 三态，随唤醒消息/停滞报告/压缩 `[GOAL STATE]` 块呈现。 Tasks per goal are uncapped (the old 50 limit was removed 2026-10-18; settled history belongs in project docs), `todo / doing / done` states, surfaced in wake messages / stall reports / the compaction `[GOAL STATE]` block. |
| 等待声明 `goal_wait` | 模型声明"我在等"并挂起 N 分钟（整数 1–60），不消耗停滞预算。 The model declares "I'm waiting" and suspends for N minutes (integer 1–60), without consuming the stall budget. |

## 安装 · Install

### npm（正式分发）/ npm (canonical)

把插件条目加进 OpenCode 的配置文件，宿主启动时自动从 npm 拉取（零运行时依赖）：

Add the plugin entry to your OpenCode config file; the host fetches it from npm automatically (zero runtime dependencies):

- **全局**：`~/.config/opencode/opencode.jsonc`（对所有项目生效）
- **项目**：项目根目录的 `opencode.json` / `opencode.jsonc`（仅本项目）

  - **Global**: `~/.config/opencode/opencode.jsonc` (applies to all projects)
  - **Project**: `opencode.json` / `opencode.jsonc` in the project root (this project only)

文件里已有 `plugins` 数组的话，把条目合并进去即可：

If the file already has a `plugins` array, just merge the entry in:

```jsonc
{
  "plugins": [
    { "package": "@ch2lab/opencode-goals", "options": {} }
  ]
}
```

保存后宿主热重载即生效（2.0.29+ 已实测；不想等热重载就重启宿主）。装好后 `/goal` 出现在命令列表，插件状态显示 `active`。`options` 留空用默认值，可调项见下文 options 表。按版本钉住可写 `"@ch2lab/opencode-goals@1.1.0"`。

The host hot-reloads the plugin when the config changes (verified on 2.0.29+; restart the host if you prefer). After install, `/goal` appears in the command list and the plugin shows `active`. Leave `options` empty for the defaults; the tunables are in the options table below. Pin a version with `"@ch2lab/opencode-goals@1.1.0"`.

> 入口是剥离 wrapper 的零 import 变体（活宿主验证过的形态），对 `@opencode/plugin` 宿主版本漂移免疫。
> The entry is a wrapper-stripped, zero-import variant (the host-verified form), immune to `@opencode/plugin` version drift.

本地源码目录（开发/自测）：克隆源码仓库，入口 `index.ts` 可直接加载、无需构建（`@opencode/plugin` 需 pin 到宿主版本作 dev 依赖：`bun add -d @opencode/plugin@2.0.29`）：

Local source directory (for development): clone the source repo; `index.ts` loads directly, no build needed (`@opencode/plugin` pinned to the host version as a dev dependency: `bun add -d @opencode/plugin@2.0.29`):

```bash
git clone https://github.com/ch2lab/opencode-goals
```

```jsonc
{
  "plugins": [
    { "package": "<本地源码目录路径>", "options": {} }
  ]
}
```

## 用法 · Usage

### `/goal` 命令（用户侧）/ `/goal` commands (user side)

| 命令 Command | 说明 Description |
|---|---|
| `/goal set <objective> [--turns N] [--tokens N] [--unbounded]` | 启动目标。turns 未给用 options 默认（10）；tokens 默认仅统计、不限制（`--tokens N` 显式开启上限）；`--unbounded` = 不设 cap。 Start a goal. Omitted turns fall back to the options default (10); tokens are stats-only unless `--tokens N` sets a cap; `--unbounded` = no cap. |
| `/goal view` | 查看当前 goal（状态 / 目标 / 预算上限与已用）。 View the current goal (status / objective / cap & usage). |
| `/goal pause` | 暂停当前 goal。 Pause the current goal. |
| `/goal resume` | 恢复当前 goal。 Resume the current goal. |
| `/goal complete <evidence>` | 标记完成（证据门控：长度/锚点/接地三层）。 Mark complete (evidence-gated). |
| `/goal block <reason>` | 标记受阻（原因必填；blocked 后任意用户消息即恢复）。 Mark blocked (reason required; any user message resumes it). |
| `/goal clear` | 清除当前 goal（请求必须引用用户原话，fail-closed）。 Clear the goal (the request must quote the user's own words; fail-closed). |
| `/goal history` | 本会话已归档 goal 列表。 List archived goals of this session. |
| `/goal task add <title>` | 添加待办任务（无上限）。 Add a task (uncapped). |
| `/goal task <n> <todo\|doing\|done>` | 改任务状态，`n` = 1-based 序号或任务 id。 Change a task's status; `n` = 1-based index or task id. |

每个子命令另注册独立细粒度命令（`/goal-set` / `/goal-view` / `/goal-pause` / `/goal-resume` / `/goal-complete` / `/goal-block` / `/goal-clear`），在 `/` 菜单逐行可见、参数帮助独立——裸 `/goal` 输出 usage 菜单。 Each subcommand is also registered as a fine-grained command (`/goal-set` / … / `/goal-clear`), visible as separate `/` menu lines with per-command argument help — bare `/goal` prints the usage menu.

### 典型流程 · Typical Flow

```
/goal set 完成 auth 模块重构，保持所有测试通过 --turns 15
```

模型随后进入目标循环：每个执行边界被唤醒继续推进；`/goal view` 随时查看进度；达成标准时模型自行 `goal_complete` 收尾（证据门控）；卡住时（连续无动作唤醒达 `stallLimit`）默认直接把 goal 标记为 stalled（报告留给人裁决），启用裁判时先仲裁一次（继续 / 收尾 / 转人工）；预算耗尽自动进入终态。

The model then enters the goal loop: it is woken at each execution boundary to keep going; check progress any time with `/goal view`; when the bar is met it completes itself via `goal_complete` (evidence-gated); a stall (no-action wakes reaching `stallLimit`) marks the goal stalled by default (the report is for the human), or runs one judge arbitration first when enabled; an exhausted budget ends the goal automatically.

### Options（插件 `options` 字段）/ Options (the plugin's `options`)

| option | 类型 Type | 默认 Default | 说明 Description |
|---|---|---|---|
| `stallLimit` | number | `3` | 连续无动作唤醒达到该数后进入停滞：默认直接把 goal 标记为 stalled；`judgeEnabled` 开启时先经一次旁路裁判仲裁再停滞。 Consecutive no-action wakes before the stall: by default the goal is stalled outright; with `judgeEnabled` on, a one-shot bypass-judge arbitration runs first. |
| `providerFailLimit` | number | `2` | provider 失败暂停：连续 N 个"最后一条 assistant 消息带 provider 错误"的边界触发静默暂停——不唤醒、不烧 turn、不计 stall，每事故一条 synthetic 通知；干净边界自动恢复并清零连击。 Consecutive provider-error boundaries before a silent pause: no wakes, no turns burned, no stall count, one synthetic notice per incident; a clean boundary auto-resumes and resets the streak. |
| `providerPauseMs` | number | `1800000` | provider 失败暂停时长（毫秒，默认 30 分钟）；到期发一条一次性重试唤醒，失败重试续期不重复通知。 Provider-failure pause duration in ms (default 30 min); a one-shot retry wake fires at expiry, and failed retries extend the pause without re-noticing. |
| `defaultCapTurns` | number | `10` | 默认预算：turn 数（`/goal set` 未给 `--turns` 时生效）。 Default turn budget when `/goal set` omits `--turns`. |
| `defaultCapTokens` | number | （无 none） | 默认 token 上限。**不设 = token 仅统计不限制**；设置后，未给 `--tokens` 的 goal 按此值设上限。 Default token cap. **Omitted = tokens are stats-only**; set it to cap goals that omit `--tokens`. |
| `judgeEnabled` | boolean | `false` | 是否启用旁路裁判（**默认关**：停滞上限到达时 goal 直接 stalled 并浮出给人；开启后输出解析失败 = give up，fail-closed）。 Enable the bypass judge (**default off**: at the stall limit the goal stalls and surfaces to the human; when on, unparseable output = give up, fail-closed). |
| `judgeMaxPerGoal` | number | `1` | 解析保留，但**行为 spec 固定为每 goal 至多 1 次**（防裁判/代理互踢环；设其他值无效）。 Resolved but **behavior is spec-fixed to at most once per goal** (anti judge/agent kick-loop; other values have no effect). |
| `watchdogTickMs` | number | `30000` | 看门狗 tick 周期（每个 active goal 一个 timer）。 Watchdog tick period (one timer per active goal). |
| `checkInDelaySec` | number | `300` | 后台等待门禁：边界上有后台工作（shell/子任务会话）在飞时不立即唤醒，静默达到这么多秒后触发一次进展检查；期间任何活动取消它。以秒为单位。 Background in-flight gate: a boundary with background work in flight (shells / subtask sessions) does not wake immediately; it arms a one-shot progress check after this many SECONDS of silence. Any activity cancels it. |
| `timeoutWrap` | boolean | `false` | 是否强制为无超时脚本包装超时（opt-in）。开启后：有 active goal 时，宿主对 `timeout === 0` 的 spawn 把 `timeout` 就地改写为 `checkInDelaySec × 1000`（按"本实例有任一 active goal"判定，不做 per-shell 归属）。 Opt-in: while any goal in this instance is active, spawns with `timeout === 0` get `timeout` rewritten in place to `checkInDelaySec × 1000`. |
| `wakeText` | string | （无 none） | 自定义唤醒文案；设置后作为末行 `Extra instruction: <wakeText>` 追加到边界/裁判降级唤醒消息（后台进展检查是独立文案，不套用）。 Custom wake text; appended as a final `Extra instruction: <wakeText>` line to boundary/judge-downgrade wake messages (the background progress check uses its own text). |
| `wakeDetail` | `"full"` \| `"slim"` | `slim` | 边界/裁判降级唤醒消息在转录里的显示粒度。`slim`（默认）= 标题 + 一行 goal 模式自主提醒（无人值守按纪律推进、别停在提问上；停止只有 `goal_complete` / `goal_block`；用户消息永远优先），共 2 行——目标由会话上下文携带，工具已暴露在系统提示，唤醒不再重述。`full` = 唤醒消息内完整重述预算 + 目标 + 任务进度，附同一自主条款（强 re-grounding）。仅接受这两个字面值，其余回退默认。 Wake transcript footprint. `slim` (default) = header + one goal-mode autonomy line only (advance unattended per the goal's discipline, don't stall on questions; the only stops are `goal_complete` / `goal_block`; a user message always overrides — the objective rides the conversation context and the goal tools are exposed in the system prompt, so the wake re-states nothing); `full` = budget + objective + task progress re-grounded inside the wake, with the same autonomy clause. Strict literal; other values fall back to the default. |
| `model` | string | （会话当前模型 session model） | 旁路生成（裁判 + 压缩摘要）所用模型，格式 `"providerID/modelID"`（如 `"ch2lab/Qwen3.8-Flash-Next"`）。**不设 = 跟随会话当前使用的模型**（逐会话，含会话内切换；会话无显式模型时回落宿主默认）。严格两段、非法格式告警并回退。 Model used for bypass generation (judge + compaction summary), `"providerID/modelID"`. **Omitted = follow the session's current model** (per-session, including mid-session switches; falls back to the host default when the session has no explicit model). Strict two-segment format; invalid values warn and fall back. |

数值项只接受正整数、布尔项只接受 boolean 字面量，其余一律回退默认值（纯函数解析，无副作用）。

Numbers must be positive integers, booleans must be boolean literals; anything else silently falls back to the default (pure-function parsing, no side effects).

## 设计思路 · Design

- **每个边界一次唤醒，唤醒消息是普通状态消息**——没有特殊审计通道、没有状态升级：模型在自己的上下文里决定如何继续，循环不劫持宿主的正常会话流。
  **One wake per boundary, and the wake message is a plain state message** — no special audit channel, no state escalation: the model decides how to continue from its own context; the loop never hijacks the host's normal conversation flow.
- **fail-closed**：在飞事实只靠事件计数，事件丢失至多让进展检查延迟、绝不产生假唤醒；裁判输出不可解析 → give up；证据不达标 → 视为未完成；`clear` 未引用用户原话 → 拒绝。
  **fail-closed**: in-flight facts are event-counted — a lost event can at most delay the progress check, never cause a false wake; unparseable judge output → give up; insufficient evidence → treated as not done; `clear` without the user's own words → refused.
- **控制面 / 数据面分权**：8 个 `goal_*` 工具统一声明专属权限动作 `goal.control`，插件只在"会话有 active goal 且归属本实例"时自授 allow；数据面的路径沙箱永不放宽用户已配置的 deny。
  **Control plane / data plane separation**: all 8 `goal_*` tools declare the dedicated permission action `goal.control`; the plugin self-grants allow only when "the session has an active goal and belongs to this instance"; the data-plane path sandbox never relaxes user-configured deny rules.
- **旁路生成默认跟随会话当前模型**，可用 `model` 钉一个更便宜的模型——裁判与压缩摘要不污染主对话上下文。
  **Bypass generation follows the session's current model by default**; pin a cheaper one via `model` — the judge and compaction summary never pollute the main conversation context.
- **零运行时依赖**：发布入口是剥离 wrapper 的零 import 变体，对 `@opencode/plugin` 版本漂移免疫。
  **Zero runtime dependencies**: the published entry is a wrapper-stripped, zero-import variant, immune to `@opencode/plugin` version drift.

## 工具（模型可调用）· Tools (model-facing)

8 个工具统一声明 `goal.control` 权限；每个工具的门控一句话：

All 8 tools declare the `goal.control` permission; one-line gating rule per tool:

| 工具 Tool | 门控 Gating |
|---|---|
| `goal_set` | 存在非终态 goal 时拒绝（先 complete/block/clear）。 Refused while a non-terminal goal exists (complete/block/clear first). |
| `goal_complete` | 需 active goal；证据必须具体、可核查（长度/锚点/接地三层）。 Requires an active goal; evidence must pass the three-layer check. |
| `goal_block` | 需 active goal + 非空 reason。 Requires an active goal + non-empty reason. |
| `goal_clear` | 需 active goal；请求必须引用用户原话（接地于非 assistant 消息，fail-closed）。 Requires an active goal; the request must quote the user's own words (grounded in non-assistant messages; fail-closed). |
| `goal_history` | 只读，无 goal 也可用。 Read-only; works without a goal. |
| `goal_add_task` | 需非终态 goal；账本无上限。 Requires a non-terminal goal; the task ledger is uncapped. |
| `goal_update_task` | 需非终态 goal + 有任务；`status ∈ todo\|doing\|done`。 Requires a non-terminal goal with tasks; `status ∈ todo\|doing\|done`. |
| `goal_wait` | 需 active goal；挂起唤醒 N 分钟（整数 1–60），声明"我在等"、不消耗停滞预算。 Requires an active goal; suspends the wake for N minutes (integer 1–60), declares "I'm waiting", does not consume the stall budget. |

## 无人值守安全 · Unattended Safety

- **路径沙箱**：仅当 goal 为 active 时介入权限评估；会话工作目录内的绝对路径 → 自动 allow，目录外 → 自动 deny（消息引导模型走 `goal_block`）。
  **Path sandbox**: engages in permission evaluation only while a goal is active, and only for write actions (`fs.write`); absolute paths inside the session working directory → auto-allow, outside → auto-deny (the message steers the model to `goal_block`). Read actions and indistinguishable actions are unrestricted (the plugin takes no stance; 2026-10-17 ruling: reads open, writes contained only).
- **deny 永不放宽**：用户已配置的 deny 条目插件永不放宽；URL、命令等非路径资源一律不表态（保留宿主原有决策）。
  **deny is never relaxed**: user-configured deny entries are never overridden by the plugin; non-path resources (URLs, commands) are left undecided (the host's own policy applies).
- **fail-closed 原则**：在飞事实只靠事件计数，事件丢失至多让进展检查延迟、绝不产生假唤醒；裁判输出不可解析 → give up；证据不达标 → 视为未完成。
  **fail-closed**: in-flight facts are event-counted — a lost event can at most delay the progress check, never cause a false wake; unparseable judge output → give up; insufficient evidence → treated as not done.

## 数据面（宿主数据面）· Data plane

插件经宿主自身的 **HTTP client 面**读取宿主状态（进程内 `ctx.rpc` 是宿主→插件的注册面，插件→宿主的查询在 2.0.32 不可用——2026-10-17 修订，见 spec 附录 §17）：

- **发现**：`%USERPROFILE%\.local\state\opencode\service.json`（`XDG_STATE_HOME` 可重定向）：`{id, version, url, pid, password}`——受管服务的注册文件。
- **鉴权**：HTTP Basic，username 固定 `opencode`，password 取自注册文件。
- **自识别**：注册文件 `pid` 必须等于加载本插件的宿主进程 pid；mismatch / 解析失败 → 走查询失败路径（绝不猜测、绝不连错宿主）。
- **端点**：`GET /api/shell`（在飞后台 shell；位置经 `x-opencode-directory` 请求头（URL-encoded abs dir）指定——服务端 `requestRef` 只认该头或 `location[directory]` 方括号查询参数，点记法 `location.directory=` 对它不可见，会静默回退到服务 cwd（`serve --service` 下恒为 home））、`GET /api/session/:id/inbox`、`DELETE /api/session/:id/inbox/:inboxID`（404 `SessionNotFoundError` = 空列表 / 已完成的语义，不是错误）。
- **三态信号**：在飞信号为 `{own, other, ownKnown}`——查询失败报 `own=0, other=0, ownKnown=false`（不假报计数）：该边界 **skip**（不唤醒、不武装 check-in、不消耗 stall 预算）——宿主上下文已死，复活会话不是插件的活。每个 wake / hold / skip 各写一行 **决策日志** `<tempdir>/opencode-goal/decisions-<hostpid>.jsonl`（append-only，best-effort）。

The plugin reads host state over the host's own **HTTP client surface** (in-process `ctx.rpc` is the host→plugin registration channel; plugin→host queries are unavailable on 2.0.32 — 2026-10-17 revision, spec appendix §17):

- **Discovery**: `%USERPROFILE%\.local\state\opencode\service.json` (`XDG_STATE_HOME`-redirectable): `{id, version, url, pid, password}` — the managed-service registration file.
- **Auth**: HTTP Basic, username fixed `opencode`, password from the registration file.
- **Self-identification**: the registration file's `pid` must equal the host process that loaded this plugin; mismatch / parse failure → the query-failure path (never guess, never connect to the wrong host).
- **Endpoints**: `GET /api/shell` (in-flight background shells; the location is passed via the `x-opencode-directory` request header, URL-encoded — the server's `requestRef` only honors that header or the bracket query `location[directory]`; dot-notation params like `location.directory=` are invisible and silently fall back to the service's cwd, which is always home under `serve --service`), `GET /api/session/:id/inbox`, `DELETE /api/session/:id/inbox/:inboxID` (a 404 `SessionNotFoundError` = empty-list / already-done semantics, not an error).
- **Tri-state signal**: the in-flight signal is `{own, other, ownKnown}` — a failed query reports `own=0, other=0, ownKnown=false` (never a fake count): that boundary is **skipped** (no wake, no check-in arm, no stall budget spend) — the host context is dead, and reviving sessions is not the plugin's job. Every wake / hold / skip appends one line to the **decision log** `<tempdir>/opencode-goal/decisions-<hostpid>.jsonl` (append-only, best-effort).

## 已知限制（2.0.29 宿主实测）· Known Limitations (measured on host 2.0.29)

1. **CLI serve 形态不向模型暴露插件工具**：插件注册成功，但模型调用任何 `goal_*` 均被宿主拒绝；**桌面端运行时完整可用**（8 个工具全部对模型可见）。影响：CLI 形态下模型侧终态动作（`goal_complete` 等）不可用，无人值守收尾只能靠停滞/预算终态或用户侧 `/goal` 命令。
   **The CLI serve form does not expose plugin tools to the model**: the plugin registers fine, but the host rejects any `goal_*` call; **the desktop app runtime is fully functional** (all 8 tools visible to the model). Consequence: in the CLI form, model-side terminal actions (`goal_complete`, …) are unavailable — unattended closure relies on stall/budget terminals or the user-side `/goal` commands.
2. **插件→宿主数据通道 = HTTP client 面（2026-10-17 变更）**：进程内 `ctx.rpc`（宿主→插件注册面）在 2.0.32 对插件侧查询不可用——早期的"零探测、纯事件流"裁决已被替换：门禁走 shell store 查询（`GET /api/shell`），进展检查（check-in）走 queued 消息投递、取消是插件内存态（inbox 端点保留在数据面契约上，但不再用于 check-in 回路）；看门狗仍事件驱动（`session.shell.started/ended`）。
   **The plugin→host data channel is the HTTP client surface (2026-10-17 change)**: in-process `ctx.rpc` (the host→plugin registration channel) is unavailable for plugin-side queries on 2.0.32 — the earlier zero-probe / events-only ruling is replaced: the gate queries the shell store (`GET /api/shell`); the progress check (check-in) is delivered as a queued message and cancelled in plugin memory (the inbox endpoints remain in the data-plane contract but are no longer part of the check-in loop); the watchdog remains event-driven (`session.shell.started/ended`).
3. **唤醒投递的两级语义**：宿主只在会话 idle 时投递 queued inbox 项；模型自己的回合进行中（含阻塞在 `question` 表单）投递被推迟——宿主调度行为，非插件缺陷。
   **Two-level wake delivery**: the host delivers queued inbox items only when the session is idle; delivery is deferred while the model's own turn is in flight (including when blocked on a `question` form) — host scheduling behavior, not a plugin defect.
4. **宿主重启**（idle 等 shell 时杀 service 重启）：shell 记录消失且宿主不发任何取消通知；插件不做重启对账（2026-10-17 已删），僵尸 waiting shell 保留为持久事实，退化为周期性进展检查的节奏，宿主自身的重启清扫恢复会话、下一个边界重新武装门禁。
   **Host restart** (killing the service while idling on a shell): shell records vanish and the host sends no cancellation notice; the plugin no longer reconciles on restart (removed 2026-10-17) — a stale waiting shell persists as a fact and degrades to the progress-check cadence, while the host's own restart sweep resumes the session, whose next boundary re-arms the gate.
5. **宿主原生恢复未触发**（turn 进行中杀 serve 进程重启）：无 restart 合成消息、无挂起会话清扫——`serve` 形态下实证。
   **Host-native recovery not triggered** (killing the serve process mid-turn and restarting): no restart synthetic message, no suspended-session sweep — verified in the serve form.
6. **宿主 quirk**：未配置模型时宿主回退到内置 `exo-free`（已废弃）；`POST /api/session/:id/shell` 的响应在 **shell 退出时才返回**（长脚本会挂住 POST）。
   **Host quirk**: with no model configured the host falls back to the built-in (deprecated) `exo-free`; the `POST /api/session/:id/shell` response only returns **when the shell exits** (long scripts hang the POST).
7. **（2026-10-17 已撤销）早期"位置路由缺口"结论系本插件探针的编码错误，非宿主缺口**：shell 列表（`GET /api/shell`）确实是**每位置一份的内存表**（仅列 `status=running`），但位置路由可用——服务端 `requestRef` 只认 `x-opencode-directory` 请求头（URL-encoded）或 `location[directory]` 方括号查询参数；早期探针误发点记法 `location.directory=`，对服务端不可见，静默回退服务 cwd（`serve --service` 主动 chdir 到 home），因而被误诊为"所有请求落 home"。本插件 `shellList` 已改用 `x-opencode-directory` 请求头（2026-10-17 对照公开源码 anomalyco/opencode v2.0.32 核对 + 隔离宿主实机 5/5 验证）；非默认位置在飞的 shell（含模型自起的后台 shell）现在可见，在飞门禁覆盖正确的 location 表。
   **(retracted 2026-10-17) the earlier "location-routing gap" was our own probe encoding error, not a host gap**: the shell list (`GET /api/shell`) is a **per-location in-memory table** (lists only `status=running`), but location routing works — the server's `requestRef` only honors the `x-opencode-directory` header (URL-encoded) or the bracket query param `location[directory]`; early probes sent dot-notation `location.directory=`, which is invisible to the server and silently falls back to the service's cwd (`serve --service` chdirs to home), so every request "landed on home" and was misdiagnosed as a gap. The plugin's `shellList` now sends the `x-opencode-directory` header (2026-10-17, checked against the public source anomalyco/opencode v2.0.32 + 5/5 live verification against an isolated host); in-flight shells in a non-default location (including the model's own background shells) are now visible, and the gate covers the right location's table.

## 开发 · Development

模型相关脚本（live-smoke 的非 `--skip-model` 模式、三个诊断）需要本地 LLM，凭据**只从环境变量**读取（代码中无任何默认凭据）：

Model-dependent scripts (live smoke without `--skip-model`, the three diagnostics) need a local LLM; credentials are read **only from environment variables** (no default credentials in code):

```bash
export OPENCODE_LAB_PROVIDER_BASE="http://<lab-host>:8000/v1"
export OPENCODE_LAB_PROVIDER_KEY="<key>"          # scripts exit with code 2 when missing
# optional: OPENCODE_LIVE_SMOKE_MODEL_ID

bun test            # full unit + integration suite (the gate)
bun run typecheck   # tsc --noEmit
bun run scripts/live-smoke.ts            # live smoke (isolated, safe; --skip-model needs no credentials)
bun run scripts/diagnostics-callback.ts  # diagnostic: lost script callback (manual read, not gated)
bun run scripts/diagnostics-restart.ts   # diagnostic: kill/restart while idling on a shell
bun run scripts/diagnostics-native-resume.ts  # diagnostic: kill/restart mid-turn (needs local LLM)
```
