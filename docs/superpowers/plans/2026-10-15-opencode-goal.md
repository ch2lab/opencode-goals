# opencode-goal 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 OpenCode v2.0.29 上实现目标循环插件：带状态的自动唤醒、stall 阶梯 + 旁路裁判、脚本等待看门狗、重启对账、压缩防护、证据门控完成、权限沙箱。

**Architecture:** 单一 `GoalController` 把四个宿主面（command / tool / session hooks / event stream）接到一个持久化 `GoalRecord`（`ctx.storage`）。回合边界上跑纯机械仲裁器；失败升级走旁路 LLM 裁判（`session.generate`）；对外部世界（shell 状态、宿主恢复）一律主动查询事实，不信任内存与单一事件。

**Tech Stack:** TypeScript + Bun（`bun test`），`@opencode/plugin@2.0.29`，无其他运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-15-goal-loop-design.md`（下称 spec，所有行为决策以 spec 为准；本计划只补实现细节）。

## Global Constraints

- 目标宿主：`@opencode/plugin` **2.0.29**（桌面端 opencode-cli 2.0.29）。类型以该版本的 `.d.ts` 为准，不凭记忆假设 API。
- 运行/测试：Bun；`bun test` 全绿 + `tsc --noEmit` 零错误才算任务完成。
- 无运行时第三方依赖（peer deps 仅宿主自带：`@opencode/plugin`）。
- 固定值（来自 spec，测试断言必须用这些精确值）：
  - `MIN_EVIDENCE_LENGTH = 24`，`MIN_CLEAR_REQUEST_LENGTH = 12`
  - 默认 cap：`10` turns / `100_000` tokens；`stallLimit = 3`；`judgeMaxPerGoal = 1`
  - 待办上限 `50`；任务 id 前缀 `t_`，goal id 前缀 `g_`
  - 看门狗：`watchdogTickMs = 30_000`，`shellStallMs = 300_000`（零增长阈值），`waitCheckInMs = 300_000`（久等 check-in 间隔，仅 idle 会话注入）；超时补偿 margin = 一个 `watchdogTickMs`（无独立常量）
  - 权限动作常量 `GOAL_CONTROL_ACTION = "goal.control"`
  - 宿主重启合成消息识别：metadata `{ notice: "restart" }`
  - storage 键：`goal/<sessionID>`；归档 `goal/<sessionID>/archived/<goalID>`
- 所有 fail-closed 原则：解析失败不延长自主性；无 transcript 的破坏性操作拒绝；权限非路径资源不表态；deny 永不放宽。
- 容错纪律（参考项目模式）：storage 写/归档失败、RPC emit 失败、synthetic 通知失败一律 catch + best-effort，**永不炸事件循环**；终态每次 save 都重写归档（同 id = 刷新，最新结果赢）。
- License 未定（用户发布前决定），不阻塞代码任务。

## Review Focus

spec 未逐一覆盖、最可能在真实使用中咬人的输入/条件（每条的固定测试写在归属任务里）：

1. **三重唤醒叠加**：宿主 restart sweep + 旧 pending 唤醒 + 插件合成唤醒同时命中同一会话 → 只续接一次（Task 10 测试 `reconcile-does-not-double-wake-when-host-already-acts`）。
2. **裁判输出损坏**：JSON 截断/verdict 非法/complete 但 evidence 过不了门控 → 分别按 give_up / give_up / 降级 continue，绝不判完成（Task 5 测试覆盖三种畸形）。
3. **事件重放**：带 `durable.seq` 的事件在重启后被重放两次 → 不产生第二次唤醒（Task 8 测试 `replayed-terminal-event-does-not-double-wake`）。
4. **无动作回合的三种形态**：interrupt reason 为 `user` / `inactivity` / `shutdown` 时分别 不唤醒 / 唤醒 / 只记录（Task 8 参数化测试）。
5. **goal_complete 捏造证据**：evidence 长度与锚点都够、但与 transcript 无词元重叠 → 拒绝且 goal 保持 active（Task 2 测试）。
6. **权限资源边界**：资源含 URL 或命令串（混合于路径）→ 整体 leave，绝不部分表态（Task 3 测试）。

---

## 文件结构

```
index.ts              # 插件入口：define({ id: "opencode-goal", setup }) + goals RPC 注册
src/state.ts          # GoalRecord + 纯状态助手（无宿主依赖）
src/options.ts        # 插件 option 解析与默认值
src/evidence.ts       # 证据门控 + clear 请求门控（纯函数）
src/permission.ts     # 路径沙箱 + goal.control 自授判定（纯函数）
src/wake.ts           # 唤醒消息 / 状态块文本构造（纯函数）
src/judge.ts          # 旁路裁判：契约、JSON 解析、fail-closed、prompt 构造
src/controller.ts     # 事件仲裁器、唤醒、命令、工具、看门狗、对账（唯一有宿主副作用的模块）
src/compact.ts        # compaction/context hook 的行为实现（由 controller 接线）
src/types.ts          # 结构化的宿主 context 切片（controller 面向它编程，便于 mock）
test/harness.ts       # mock PluginContext + 确定性事件总线 + 全量调用捕获
test/state.test.ts    test/evidence.test.ts   test/permission.test.ts
test/wake.test.ts     test/judge.test.ts
test/goal-loop.test.ts        # 生命周期/命令/工具集成（走真实 start()）
test/arbiter.test.ts          # 边界/去重/stall/预算集成
test/judge-integration.test.ts # 裁判进 stall 阶梯
test/watchdog.test.ts         # 看门狗/对账/重启集成
test/compact.test.ts          # 压缩防护集成
test/permission-integration.test.ts
scripts/live-smoke.ts         # 隔离宿主：注册、一次唤醒、shell 事件语义、RPC 方法名发现
scripts/diagnostics-*.ts      # spec §14 三个诊断实验脚本
README.md
```

## 接口总览（跨任务契约，所有任务按此签名实现）

```ts
// src/types.ts —— controller 依赖的最小宿主切片（mock 只需实现这些）
interface WakeProbe {
  eventSubscribe(): AsyncIterable<HostEvent>        // ctx.event.subscribe()
  prompt(input: PromptInput): Promise<InboxRef>     // ctx.session.prompt()（delivery/metadata/resume）
  synthetic(input: SyntheticInput): Promise<void>
  context(sessionID: string): Promise<SessionMessage[]>
  storageGet(key: string): Promise<unknown>
  storageSet(key: string, value: unknown): Promise<void>
  storageRemove(key: string): Promise<void>
  storageScan(prefix: string): Promise<Array<{ key: string; value: unknown }>>
  generate(input: { sessionID: string; prompt: string }): Promise<{ text: string }>
  rpcCall(method: string, input: unknown): Promise<unknown>  // shell 查询走这里
  sessionGet(sessionID: string): Promise<{ location?: { directory?: string }; projectID?: string } | undefined>
  inboxList(sessionID: string): Promise<InboxItem[]>
  inboxCancel(inboxID: string): Promise<void>
  projectID?: string
  locationDirectory?: string
  // —— 注册面（adapter 转真实 ctx；harness 记录供断言；hook 载荷字段以 2.0.29 .d.ts 为准）——
  registerCommand(name: string, run: (text: string, sessionID: string) => Promise<void>): void
  registerTool(name: string, spec: { description: string; input: unknown; permission?: string }, run: (input: unknown, sessionID: string) => Promise<string>): void
  onSessionHook(kind: "context" | "compaction", fn: (sessionID: string, payload: Record<string, unknown>) => void): void
  onShellCreateBefore(fn: (input: { command: string; cwd: string; timeout: number }) => void): void
  onPermissionHook(fn: (input: { action: string; resources: readonly string[]; sessionID?: string; incoming: "allow"|"ask"|"deny" }) => Promise<{ effect: "allow"|"deny"; message?: string } | undefined>): void   // undefined = 不表态（leave）；goalActive 由 controller 自查
}
// 说明：types.ts 把 @opencode/plugin 的 Context 结构化成上面的窄接口；
// controller 的构造函数接收 (probe: WakeProbe, options, deps?)；index.ts 里有一个
// adapter 把真实 ctx 包装成 WakeProbe。宿主类型细节（字段名/delivery 枚举）以
// @opencode/plugin@2.0.29 的 .d.ts 为准，adapter 是唯一碰宿主类型的文件。

// src/state.ts
type GoalStatus = "active"|"paused"|"completed"|"blocked"|"budget_limited"|"stalled"|"cleared"
type GoalTaskStatus = "todo"|"doing"|"done"
interface GoalTask { id: string; title: string; status: GoalTaskStatus; createdAt: number; updatedAt: number }
interface GoalRecord {
  version: 1; id: string; sessionID: string; objective: string; status: GoalStatus
  createdAt: number; updatedAt: number
  cap: { turns?: number; tokens?: number }
  used: { turns: number; tokens: number }
  stalls: number; continuations: number
  tasks: GoalTask[]
  waitingShells?: Array<{ id: string; timeoutMs?: number; since: number }>
  waitUntil?: number
  lastHandledEventID?: string
  judgeUsed?: boolean
  evidence?: string; blocker?: string; stallReport?: string
}
const GOAL_STORAGE_PREFIX: string                    // "goal/"
function goalStorageKey(sessionID: string): string
function archivedGoalKey(sessionID: string, goalID: string): string
function isTerminal(status: GoalStatus): boolean
function isCapReached(goal: GoalRecord): boolean
function createGoal(input: { sessionID: string; objective: string; cap?: GoalRecord["cap"] }, now?: number): GoalRecord
function nextGoalID(now?: number): string
function addTask(goal: GoalRecord, title: string, now?: number): GoalTask   // 上限 50，超出抛 TaskLimitError
function resolveTaskRef(tasks: readonly GoalTask[], ref: string): number    // 1-based 序号或 id；未找到 -1

// src/options.ts
interface Options {
  stallLimit: number          // 3
  defaultCapTurns: number     // 10
  defaultCapTokens: number    // 100000
  judgeEnabled: boolean       // true
  judgeMaxPerGoal: number     // 1
  watchdogTickMs: number      // 30000
  shellStallMs: number        // 300000
  waitCheckInMs: number       // 300000（"活着地失败"检票点：有增长但久等的 check-in 间隔，仅 idle 会话注入）
  timeoutWrap: boolean        // false
  wakeText?: string
}
function resolveOptions(pluginOptions: Record<string, unknown>): Options

// src/evidence.ts
function validateEvidence(evidence: string, transcript?: TranscriptMessage[]): string | undefined
function validateClearRequest(request: string, transcript?: TranscriptMessage[]): string | undefined
// 拒绝原因文案前缀固定："Goal NOT completed: " / "Goal NOT cleared: "（测试断言前缀）

// src/permission.ts
export const GOAL_CONTROL_ACTION = "goal.control"
type PermissionDecision = { effect: "allow"|"deny"; message?: string } | { effect: "leave" }
interface PermissionInput { action: string; resources: readonly string[]; sessionDirectory?: string; goalActive: boolean; incoming: "allow"|"ask"|"deny" }
function decidePermission(input: PermissionInput): PermissionDecision
// 规则序：incoming==="deny"→leave；action===GOAL_CONTROL_ACTION→goalActive?allow:leave；
// 资源全为绝对路径才表态：全在目录内→(ask 时)allow 否则 leave；有目录外→deny+引导 goal_block 的 message；
// 任一资源非绝对路径→leave。

// src/wake.ts
function buildWakeMessage(goal: GoalRecord, caps: string, judgeInstruction?: string): string
function objectiveBlock(goal: GoalRecord, caps: string): string
// 内容契约（测试断言）：含 "[GOAL " + goal.id、objective 原文、每条 task 的序号+状态+标题、
// 三个终结指令关键词 goal_complete/goal_block、turns 用量；judgeInstruction 存在时含独立段落。

// src/judge.ts
type JudgeVerdict = { verdict: "continue"|"complete"|"needs_human"|"give_up"; reason: string; evidence?: string; instruction?: string }
function buildJudgePrompt(goal: GoalRecord, noActionTexts: readonly string[], budgetText: string): string
function parseJudgeOutput(raw: string): JudgeVerdict | undefined   // 不合法一律 undefined（fail-closed）
interface Judge { judge(goal: GoalRecord, noActionTexts: readonly string[]): Promise<JudgeVerdict> }
class SessionGenerateJudge implements Judge   // 构造依赖 WakeProbe.generate；解析失败 → { verdict: "give_up", reason: "judge output unparseable" }

// src/controller.ts
interface ControllerDeps { judge?: Judge; shellProbe?: ShellProbe; tickMs?: number }
interface ShellProbe { list(): Promise<Array<{ id: string; state: "running"|"exited"; exitCode?: number; outputTail?: string }>> }
class GoalController {
  constructor(probe: WakeProbe, options: Options, deps?: ControllerDeps)
  start(): Promise<() => Promise<void>>      // 注册 command/tools/hooks/事件订阅；执行一次启动对账
  snapshot(sessionID: string): Promise<GoalRecord | undefined>
}
```

---

### Task 1: 脚手架 + `src/state.ts`

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig`（默认即可）, `.gitignore`, `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Produces: 上方 `src/state.ts` 全部签名。

- [ ] **Step 1: 脚手架**

`git init`；`package.json`：`{ "name": "opencode-goal", "type": "module", "exports": { ".": "./index.ts" }, "devDependencies": { "@opencode/plugin": "2.0.29", "typescript": "^5.8.0", "@types/bun": "^1.3.0" }, "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" } }`。`bun install`。提交 `chore: scaffold opencode-goal`。

- [ ] **Step 2: 写失败测试 `test/state.test.ts`**

至少覆盖：`createGoal` 初始值（status active、used 0、tasks []、id 前缀 `g_`、version 1）；`isTerminal` 五种终态/三种非终态（`active`/`paused` 为 false）；`isCapReached` 四种（无 cap / turns 到 / tokens 到 / 都未到）；`goalStorageKey("s1") === "goal/s1"`；`archivedGoalKey("s1","g1") === "goal/s1/archived/g1"`；`addTask` 到 50 条后抛 `TaskLimitError`；`resolveTaskRef` 支持 `"3"`（1-based）、task id、`"abc"`→-1。

- [ ] **Step 3: 运行确认失败** — `bun test test/state.test.ts`，Expected: 模块不存在而失败。

- [ ] **Step 4: 实现 `src/state.ts`** — 按签名。纯函数，无 import。

- [ ] **Step 5: 运行确认通过 + typecheck** — `bun test test/state.test.ts && bun run typecheck`，Expected: 全绿。

- [ ] **Step 6: 提交** — `git commit -am "feat: goal state model with pure transitions"`

### Task 2: `src/options.ts` + `src/evidence.ts`

**Files:**
- Create: `src/options.ts`, `src/evidence.ts`
- Test: `test/options.test.ts`, `test/evidence.test.ts`

**Interfaces:**
- Produces: 上方 `Options`/`resolveOptions`/`validateEvidence`/`validateClearRequest`。

- [ ] **Step 1: 写失败测试**

`options.test.ts`：空入参 → 全部默认值精确断言（`stallLimit 3 / defaultCapTurns 10 / defaultCapTokens 100000 / judgeEnabled true / judgeMaxPerGoal 1 / watchdogTickMs 30000 / shellStallMs 300000 / waitCheckInMs 300000 / timeoutWrap false`）；部分覆盖 → 覆盖生效、其余保持默认；非数字入参 → 回落默认。

`evidence.test.ts`：
- 长度 <24 → 拒绝，消息以 `Goal NOT completed: evidence is too weak` 开头
- 够长但无锚点（无 `/`、无数字、无扩展名、无关键词）→ 拒绝 `no checkable anchor`
- 含 `/path` 或含数字或含 `test` 词 → 通过锚点检查
- transcript 接地：evidence 的词元（参考项目精确分词器：`[^a-z0-9_./-]+` 切分、保留 ≥6 字符、去停用词——该正则保留 `/` `.`，路径片段完整存活）与 transcript 无重叠 → 拒绝 `not grounded`；有重叠 → undefined（通过）
- transcript 为空数组 → 跳过接地检查（其余规则照常）
- `validateClearRequest`：空 → 拒；<12 → 拒；不含 clear/remove/…词 → 拒；有 transcript 但引用词元只出现在 assistant 消息 → 拒（`assistant text does not count` 语义，断言拒绝即可）；无 transcript → 拒（fail-closed）；非 assistant 消息含相同词元 → undefined。
- 覆盖 Review Focus #5（捏造证据：长度锚点都够、与 transcript 零重叠 → 拒绝）。

- [ ] **Step 2: 运行确认失败** — `bun test test/options.test.ts test/evidence.test.ts`

- [ ] **Step 3: 实现两个模块** — evidence 的结构检查移植自先例（长度/锚点/接地三层，停用词表可精简但需覆盖测试）；拒绝文案前缀用固定值。

- [ ] **Step 4: 全绿 + typecheck** — `bun test && bun run typecheck`

- [ ] **Step 5: 提交** — `git commit -am "feat: options + evidence gates"`

### Task 3: `src/permission.ts`

**Files:**
- Create: `src/permission.ts`
- Test: `test/permission.test.ts`

**Interfaces:**
- Produces: 上方 `decidePermission` + `GOAL_CONTROL_ACTION`。

- [ ] **Step 1: 写失败测试**

覆盖规则序（每个规则一个用例，断言精确 decision 对象）：
1. `incoming: "deny"` → `{ effect: "leave" }`（即使 goalActive）
2. `action === "goal.control"` 且 goalActive → `{ effect: "allow" }`；goalActive=false → leave
3. 资源全绝对路径且全在 `sessionDirectory` 内：incoming ask → allow；incoming allow → leave
4. 有目录外路径 → `{ effect: "deny", message }`，message 含被拒路径且含 `goal_block` 字样
5. 覆盖 Review Focus #6：resources 混入 `https://x` 或 `npm install` → 整体 leave
6. 路径含 `..` 穿越（`/root/../../../etc/passwd` 形式）→ 归一化后按目录外 deny；glob 后缀 `dir/**` 剥离后比较
7. `sessionDirectory` 缺失 → leave
8. **Windows 绝对路径**（参考项目缺陷：其 `looksLikeAbsolutePath` 只认 `/` 开头，沙箱在 Windows 全失效）：`D:\dev\proj\file.txt` 与 `D:/dev/proj/file.txt` 均识别为绝对路径并归一化（反斜杠→`/`、`..` 消解、盘符与目录名大小写不敏感）→ 目录内 allow / 目录外 deny；`\` 与 `/` 混写同样工作

- [ ] **Step 2: 运行确认失败** — `bun test test/permission.test.ts`

- [ ] **Step 3: 实现** — `normalizePath`（绝对路径归一化、`..` 消解）、`stripGlob`、`isPathInside`（前缀+`/`边界）三个纯函数 + `decidePermission` 规则序。

- [ ] **Step 4: 全绿 + typecheck** — `bun test && bun run typecheck`

- [ ] **Step 5: 提交** — `git commit -am "feat: path sandbox + goal.control self-grant decision"`

### Task 4: `src/wake.ts`

**Files:**
- Create: `src/wake.ts`
- Test: `test/wake.test.ts`

**Interfaces:**
- Consumes: `GoalRecord`（Task 1）、`Options`（Task 2）。
- Produces: `buildWakeMessage(goal, caps, judgeInstruction?)`、`objectiveBlock(goal, caps)`。

- [ ] **Step 1: 写失败测试** — 断言 spec 唤醒契约：`buildWakeMessage` 输出含 `"[GOAL " + goal.id`、objective 原文、每个 task 的 `N. [status] title` 行、`goal_complete`、`goal_block`、turns 用量文本（`used.turns + "/" + cap` 或 `(unbounded)`）；`judgeInstruction` 传入时含独立段落且不含在没传的输出里；`objectiveBlock` 与唤醒同构但更短（不含 task 明细行）。

- [ ] **Step 2: 运行确认失败** — `bun test test/wake.test.ts`

- [ ] **Step 3: 实现** — 模板文案按 spec §7（措辞可打磨，契约不变）。

- [ ] **Step 4: 全绿 + typecheck**

- [ ] **Step 5: 提交** — `git commit -am "feat: wake message + objective block builders"`

### Task 5: `src/judge.ts`（旁路裁判）

**Files:**
- Create: `src/judge.ts`
- Test: `test/judge.test.ts`

**Interfaces:**
- Consumes: `GoalRecord`（Task 1）、`WakeProbe.generate`（Task 6 的 harness 提供 fake）。
- Produces: `buildJudgePrompt`、`parseJudgeOutput`、`Judge`、`SessionGenerateJudge`。

- [ ] **Step 1: 写失败测试**

`parseJudgeOutput`（纯函数，覆盖 Review Focus #2 全部畸形）：
- 合法 JSON 四 verdict 各一例 → 精确对象
- 截断 JSON / 前后带散文 / verdict 为 "finished" → `undefined`
- verdict "complete" 但缺 evidence → `undefined`（complete 必须带 evidence 字段，parse 层就拒）
- verdict "continue" 缺 instruction → 允许（instruction 可选）

`SessionGenerateJudge`（注入 fake probe）：
- generate 返回合法 JSON → 返回解析结果
- generate 返回垃圾文本 → `{ verdict: "give_up", reason: "judge output unparseable" }`
- generate 抛异常 → 同上 give_up（fail-closed）

`buildJudgePrompt`：含 objective、每条 task 状态行、传入的 noActionTexts 原文、预算文本、且明确指示"只输出 JSON + 四值 verdict 枚举"。

- [ ] **Step 2: 运行确认失败** — `bun test test/judge.test.ts`

- [ ] **Step 3: 实现** — parse 用严格校验（`JSON.parse` 在 try/catch 内 + 类型检查），不做宽容解析。

- [ ] **Step 4: 全绿 + typecheck**

- [ ] **Step 5: 提交** — `git commit -am "feat: side-channel judge with fail-closed parsing"`

### Task 6: `test/harness.ts`（测试基础设施）

**Files:**
- Create: `test/harness.ts`, `src/types.ts`
- Test: `test/harness.test.ts`（元测试）

**Interfaces:**
- Produces: `WakeProbe` 完整 mock + `Harness`：

```ts
interface Harness {
  probe: WakeProbe                     // 传给 GoalController
  emit(event: HostEvent): void         // 推入事件流（确定序）
  storage: Map<string, unknown>
  prompts: PromptCall[]                // 捕获的 session.prompt 调用（含 metadata/delivery）
  synthetics: SyntheticCall[]
  toolExecutor: (name: string, input: unknown, sessionID: string) => Promise<string>  // 直接驱动工具
  commandExecutor: (sessionID: string, text: string) => Promise<void>
  setGenerate(reply: string | ((input) => string)): void            // 脚本化 generate
  rpc: { method: string; input: unknown; reply?: unknown }[]        // 脚本化 rpcCall
  inbox: InboxItem[]
  permissionHook: (input: PermissionHookInput) => Promise<PermissionDecision | undefined>  // 模拟宿主调 hook，记录决定
}
function createHarness(overrides?: Partial<...>): Promise<Harness>
```

- [ ] **Step 1: 写 `src/types.ts`** — 按"接口总览"；对照 `@opencode/plugin@2.0.29` 的 `dist/promise/*.d.ts` 确认字段名（尤其 `PromptInput` 的 delivery/metadata/resume、`SessionInbox` 项的 type 字段），以 .d.ts 为准修正注释。
- [ ] **Step 2: 写元测试 `test/harness.test.ts`** — `createHarness` 后：`emit` 的事件按序到达 `eventSubscribe()` 的 async iterator（发 3 收 3）；**`emit` 语义（参考项目模式）：该事件被循环处理完毕后才 resolve**（断言与循环零竞态）；`prompt` 调用进入 `prompts` 且返回递增 id；`storage` 的 get/set/scan(prefix) 行为正确（`set` 深拷贝值，模拟持久化隔离）；`rpcCall` 按脚本返回且记录调用；`sessionGet` 支持 per-session 设置 projectID/location（多 location 归属测试用）。
- [ ] **Step 3: 运行** — `bun test test/harness.test.ts` 全绿（harness 无独立失败态，直接实现到通过即可）。
- [ ] **Step 4: typecheck** — `bun run typecheck`
- [ ] **Step 5: 提交** — `git commit -am "test: deterministic harness + host context types"`

### Task 7: 控制器骨架：生命周期 + 命令 + 工具 + 入口

**Files:**
- Create: `src/controller.ts`, `index.ts`
- Test: `test/goal-loop.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部、Task 6 harness。
- Produces: `GoalController`（本任务实现 `start` 的命令/工具/存储部分，事件仲裁留 Task 8；`start()` 注册一切、返回 cleanup）。

- [ ] **Step 1: 写失败测试（走真实 `start()`）**

- `set→view`：`/goal set Ship it` → storage 出现 active goal（cap 10/100000）；`/goal view` 合成通知含 objective 与 cap
- `/goal set` 存在非终态 goal 时 → 拒绝文案含 "still"；旧 goal 被归档（`archivedGoalKey` 下可读）
- `goal_complete` 工具：active + 合格证据 → status completed、outcome completed、归档；非 active → 拒绝
- `goal_block`：active + 原因 → blocked；无原因 → 拒绝且保持 active
- `goal_clear`：引用用户原话（harness inbox 里塞一条 user 消息）→ cleared（fail-closed 分支在 Task 5 已测纯函数，此处测接线）
- `/goal task add` + `/goal task 1 doing` → tasks 更新；50 条上限报错文案
- `/goal pause` 后 `goal_complete` 被拒（`not active`）；`/goal resume` 恢复
- `goal_add_task`/`goal_update_task` 工具与命令等价
- `goal_wait` 工具：active goal 必需，`minutes` 1..60；写 `waitUntil = now + minutes*60_000`，返回确认文案（期间 check-in 静默、不消耗 stall 预算）
- 所有 goal_* 工具注册时 `permission === GOAL_CONTROL_ACTION`（从 harness 捕获的注册表断言）

- [ ] **Step 2: 运行确认失败** — `bun test test/goal-loop.test.ts`

- [ ] **Step 3: 实现** — `GoalController.start` 里用 harness 暴露的 `commandExecutor`/工具注册面注册；行为照 spec §6-§9；`index.ts` 按"接口总览"接真实 `ctx`（adapter 是唯一碰宿主类型的文件）并注册 `goals.get` RPC（`ctx.rpc.register`，方法名/释放方式以 2.0.29 的 `RpcDomain` .d.ts 为准）。

- [ ] **Step 4: 全绿 + typecheck**

- [ ] **Step 5: 提交** — `git commit -am "feat: goal lifecycle controller, commands, tools, plugin entry"`

### Task 8: 事件仲裁器 + 唤醒循环

**Files:**
- Modify: `src/controller.ts`
- Test: `test/arbiter.test.ts`

**Interfaces:**
- Consumes: Task 7 的 controller；harness 的 `emit`。
- Produces: 仲裁行为（spec §6/§7/§11）；`used.turns`/`used.tokens` 记账；blocked 的任意用户消息 resume（spec §15-9）。

- [ ] **Step 1: 写失败测试**

- 边界唤醒：active goal + `session.execution.succeeded` → `prompts` 出现一条唤醒（metadata `goalWake: true`、`goalID` 匹配；`delivery: "queue"`；`used.turns` +1、`continuations` +1）
- **去重**（Review Focus #3）：同一 eventID 发两次 → 只唤醒一次；`continuationPending` 窗口内再来一条边界 → 忽略；`session.execution.started` 清除 pending 后边界才再次生效
- **执行中有 `session.tool.called`** → 唤醒注入但 `stalls` 归零（先例语义：每个终态边界都续接；tool.called 只影响计数）
- **归属判定**（spec §6 ⑤，参考项目 lastInbox 模式）：最后入队 inbox 项为**本插件唤醒**（metadata goalWake + goalID 匹配）且本轮无 tool.called → `stalls += 1`；最后入队为**用户消息**且无 tool.called → `stalls` 归零（用户轮次不是停滞）；最后入队为带 `goalControl` 标记的本插件控制通知 → 只记 eventID、不注入唤醒（断言 synthetic 通知后不被自触发二次唤醒）
- **stall 阶梯**：连续 3 次**本插件唤醒发起**的无 tool.called 边界 → 3 次唤醒后触发 deps.judge（fake judge 计数）；第 3 次唤醒前 `stalls` 精确为 1/2/3
- **预算**：`session.usage.updated` tokens=100000 → 下一边界后 `budget_limited`（outcome 同名、不 complete 文案）；turns cap 同理
- **interrupt reason 参数化**（Review Focus #4）：`user` → 不唤醒只记 eventID；`inactivity` → 当普通边界唤醒；`shutdown` → 只记录
- **blocked resume**：goal blocked + `session.inbox.enqueued`（user 类型）→ status 回 active、stalls 清零、注入唤醒；同消息二次投递不重复（inboxID 去重）
- 事件重放（Review Focus #3）：重启场景——新 harness 实例载入同一 storage，重放同一 terminal event → 不二次唤醒（`lastHandledEventID` 生效）

- [ ] **Step 2: 运行确认失败** — `bun test test/arbiter.test.ts`

- [ ] **Step 3: 实现** — 事件订阅循环 + 仲裁序（spec §6 的 ①-⑤，本任务中 ② 的看门狗交互先留 TODO 接口：`waitingShells` 非空时本边界不唤醒，Task 10 接上）；resume/inbox 订阅。

- [ ] **Step 4: 全绿 + typecheck**

- [ ] **Step 5: 提交** — `git commit -am "feat: boundary arbiter, wake loop, budget, blocked resume"`

### Task 9: 裁判进 stall 阶梯

**Files:**
- Modify: `src/controller.ts`
- Test: `test/judge-integration.test.ts`

**Interfaces:**
- Consumes: `Judge`（Task 5）、Task 8 仲裁器。
- Produces: spec §8 的四个 verdict 处置 + `stallReport`。

- [ ] **Step 1: 写失败测试**（fake judge 注入，逐一固定行为）
- 3 次空话后 judge 返回 `continue` → stalls 归零、再注入一次唤醒且含 judge 的 instruction 段、`judgeUsed` 变 true
- judge 返回 `complete`（evidence 合格）→ status completed + 归档（走证据门控：不合格的 evidence → 降级 continue 分支也测一例）
- judge 返回 `needs_human` → blocked，blocker 含 judge reason
- judge 返回 `give_up` → stalled，`stallReport` 含：objective、tasks 快照、最后 3 条无动作文本、judge reason；合成通知含报告
- `judgeMaxPerGoal=1`：continue 后再 3 次空话 → 不再调 judge（fake 计数断言），直接 stalled
- `judgeEnabled=false`：第 3 次空话直接 stalled（不调 fake judge）
- judge 抛异常/返回 give_up（fail-closed 已在 Task 5 覆盖，此处只验证接线不崩）

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 收集"最近 N 条无动作 assistant 文本"按参考项目 executionTail 规则：`probe.context` 中找最后一条 `user`/`synthetic` 消息为界，取其后的消息；找不到界则用全部；只取 assistant 的 text part
- [ ] **Step 4: 全绿 + typecheck**
- [ ] **Step 5: 提交** — `git commit -am "feat: judge in stall ladder + stall report"`

### Task 10: 看门狗 + 重启对账

**Files:**
- Modify: `src/controller.ts`（可拆出 `src/watchdog.ts` 纯调度逻辑，controller 接线）
- Test: `test/watchdog.test.ts`

**Interfaces:**
- Consumes: `ShellProbe`（Task 6 提供 fake）、`Options.watchdogTickMs/shellStallMs`。
- Produces: spec §7.1 + 重启对账全部行为。

- [ ] **Step 1: 写失败测试**（deps.tickMs 设 1ms；fake ShellProbe 脚本化）
- **超时感知**（spec §7.1）：`create.before` 记录 `(command,cwd)→timeout` 并在 `shell.created` 关联成 shell 条目；有超时 T 的 shell 在 T+一个 tick 前零增长**不**触发状态核查（fake tick 推进到 T+watchdogTickMs 后才触发）；无超时 shell 用 `shellStallMs` 基准；关联失败（command/cwd 对不上）→ 按无超时处理
- **快路径**：边界时 waitingShells 非空（`shell.created` 事件登记）→ 本边界不唤醒；随后 `shell.exited` 事件 → 合成唤醒带退出码（status 为 `"timeout"` / `"killed"` 时文案分别区分"超时"/"被杀"）
- **事件丢失自愈**：shell 记录直接变 exited 但无 exited 事件 → tick 到点后 rpc 查到 exited → 合成唤醒（文本含 "exit" 状态）
- **check-in 双信号**：probe 返回 running 且（outputTail 零增长超 `shellStallMs` **或** 有增长但等待超 `waitCheckInMs`），且 `waitUntil` 未生效 → **仅会话 idle 时**注入"状态核查"唤醒（两种理由文案分别断言：卡死嫌疑 / 等待已久需确认推进）；active 会话不注入（下一边界自然带走）；有增长且未到 `waitCheckInMs` → 继续等不唤醒；check-in 唤醒后模型若"有动作"（再发一次带 tool.called 的边界）→ 本停滞段结束，会话再次 idle 时起全新倒计时（断言每段停滞至多一次 check-in，不连续自转）
- **goal_wait 静默**：check-in 唤醒后模型以 `goal_wait(N)` 工具调用回应 → 写入 `waitUntil`；此后 check-in 到期但 `now < waitUntil` → 不注入、不 stall；`waitUntil` 过期后下个到期照常注入；check-in 回应为纯文本 → stall 计数照常
- **计时取消**：被等 shell 退出（事件或 probe 查到）→ 止表，走结果唤醒（快路径）；会话恢复活跃或 goal 终态 → 止表且解除看门狗；取消后再次停滞 → 新停滞点起全新倒计时（断言无"脚本已结束仍发 check-in"的鬼影唤醒）
- **对账-宿主已接手**（Review Focus #1）：setup 时上下文中存在 `notice: "restart"` 合成消息且会话 active → 不注入新唤醒，只武装看门狗
- **对账-idle 丢脚本**：idle + probe 显示等待的 shell 已消失 → 注入"脚本随重启丢失"唤醒（文本含 lost/cancelled 语义）；同时若 inbox 有本插件 pending 唤醒 → `inboxCancel` 被调用（捕获断言）
- **对账-软重载**：probe 显示 shell 仍 running → 重武装看门狗、不唤醒
- 看门狗随 cleanup 全停（cleanup 后 tick 不再触发 rpc）

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — `shell.hook("create.before")` 记录 `(command, cwd) → timeout`；`waitingShells` 在 `shell.created` 时写入（事件 data.info 里取 shell id，并按 command+cwd 关联出超时值，关联失败按无超时处理）；看门狗 = 每 active goal 一个 timer（武装时写 `since`；tick 到期 → probe.list → 按每 shell 的阈值三选一：退出→唤醒 / check-in 条件未满足→继续 / 触发 check-in（零增长超 `shellStallMs` 或有增长超 `waitCheckInMs`，阈值含每 shell `max(shellStallMs, T+tick)`，且 `waitUntil` 未生效）→ 仅 idle 会话注入状态核查唤醒）；启动对账按 spec §7.1 步骤序
- [ ] **Step 4: 全绿 + typecheck**
- [ ] **Step 5: 提交** — `git commit -am "feat: watchdog + restart reconciliation"`

### Task 11: 压缩防护（`src/compact.ts` 接线）

**Files:**
- Create: `src/compact.ts`
- Modify: `src/controller.ts`（接线两个 hook）
- Test: `test/compact.test.ts`

**Interfaces:**
- Produces: `onContextHook(probe, sessionID, systemParts)` 与 `onCompactionHook(probe, sessionID, compaction)`（由 controller 的 hook 注册调用）。

- [ ] **Step 1: 写失败测试**
- context hook：active goal → `system` 追加一条 `[GOAL ...]` 文本（断言 `objectiveBlock` 内容契约）；无 goal/paused 外的状态 → 不追加
- compaction hook：active goal → 经 `probe.context(sessionID)` 取对话历史，调 `probe.generate`（摘要请求，断言 prompt 含**对话历史要点**与状态块——`SessionCompaction.result` 是整段替换，只放状态块会丢对话，已对 2.0.29 .d.ts 核实）并把返回文本 + 强制的 `[GOAL STATE]` 段写入 `result.summary`；generate 失败 → 不设置 result（宿主默认压缩照走，fail-safe）；无 active goal → 两个 hook 都是 no-op
- 集成断言：一次"压缩前后"——压缩 hook 执行后，`result.summary` 含 objective + 每条 task 状态（"压缩砸不掉"的可执行定义）

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — hook 注册在 controller.start；summary 构造 = generate 文本 + 状态块拼接（状态块永远最后，保证存在）
- [ ] **Step 4: 全绿 + typecheck**
- [ ] **Step 5: 提交** — `git commit -am "feat: compaction-proof goal state (context + compaction hooks)"`

### Task 12: 权限 hook 接线

**Files:**
- Modify: `src/controller.ts`
- Test: `test/permission-integration.test.ts`

**Interfaces:**
- Consumes: `decidePermission`（Task 3）。

- [ ] **Step 1: 写失败测试**（harness `permissionHook` 驱动）
- goal active + 目录内路径 ask → hook 后 effect 变 allow
- goal active + 目录外路径 → deny 且 message 引导 goal_block
- goal active + `goal.control` 动作 → allow（即使资源为空）
- 无 active goal → hook 不改任何 effect（断言原样）
- 配置 deny 原样（incoming deny → leave）
- 多 location 归属：`probe.sessionGet` 返回的 projectID ≠ 本实例 → 不表态

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现** — 按 spec §12 + §15-8
- [ ] **Step 4: 全绿 + typecheck**
- [ ] **Step 5: 提交** — `git commit -am "feat: permission sandbox wiring (goal.control + path containment)"`

### Task 13: live smoke + 诊断实验 + README

**Files:**
- Create: `scripts/live-smoke.ts`, `scripts/diagnostics-callback.ts`, `scripts/diagnostics-restart.ts`, `scripts/diagnostics-native-resume.ts`, `README.md`

- [ ] **Step 1: `scripts/live-smoke.ts`** — 起隔离宿主（独立数据目录，隔离配方借鉴参考项目 live-smoke.sh：重定向环境变量出独立 config/data → `opencode serve` 随机端口 → 从 stdout 解析 server password → `POST /api/location/reload` 物化 location → 轮询 `/api/command` 断言 `/goal` 已注册；Windows 下环境变量换成桌面端实际配置路径）；注入一个 active goal + 一个无 tool 回合，断言唤醒被投递（日志/inbox 可查）；**顺带发现 shell RPC 方法名**：调用 `ctx.rpc.call` 探测 shell.list/get 的精确方法名与载荷，把结果写回 `src/controller.ts` 里 `RpcShellProbe` 的常量（替换 Task 10 的 placeholder），并在 test 里加一条"真实探针方法名与 .d.ts/实测一致"的冒烟断言。
- [ ] **Step 2: 三个诊断脚本**（spec §14，各 ~50 行，输出结构化结果供人工判读，不进门禁）：
  - `diagnostics-callback.ts`：后台跑必然失败的脚本，记录 `shell.exited` 是否发出、是否变 inbox 消息、会话是否被唤醒
  - `diagnostics-restart.ts`：idle 等 shell 状态杀 service 重启，记录 shell 记录去向 + 是否收到取消通知 + goal 对账结果
  - `diagnostics-native-resume.ts`：turn 进行中杀重启，记录是否出现 `notice: "restart"` 合成消息并重跑
- [ ] **Step 3: README.md** — 安装（npm pin 版本 + 目录安装）、options 全表（含每个默认值，抄 Global Constraints）、/goal 命令表、无人值守使用建议（spec §12 安全面）、v2 路线图（spec §16）。
- [ ] **Step 4: 全量验证** — `bun test && bun run typecheck` 全绿；`git commit -am "chore: live smoke, diagnostics, README"`。

---

## Self-Review 记录

1. **Spec 覆盖**：§5 状态→T1；§9 证据/门控→T2,T7；§12 权限→T3,T12；§7 唤醒→T4,T8；§8 裁判→T5,T9；§7.1 看门狗/对账→T10；§10 压缩→T11；§6 仲裁→T8；§13 命令/工具→T7；§14 测试→T6,T13；§16 v2 不实现（符合非目标）。无缺口。
2. **步骤扫描**：各任务步骤均为单动作（一个测试组 / 一个模块 / 一次运行 / 一次提交），无 TBD；RpcShellProbe 方法名是唯一实现期发现项，已显式放进 T13 Step 1 并在 T10 用 fake 隔离。
3. **类型一致性**：`GoalRecord`/`Options`/`Judge`/`ShellProbe`/`WakeProbe` 全部在"接口总览"定义一次，任务引用不重定义。
4. **Review Focus**：#1→T10、#2→T5、#3→T8、#4→T8、#5→T2、#6→T3，均有归属测试。
5. **比例**：计划与 spec 同数量级，代码体未转录（只留契约与断言点）。
