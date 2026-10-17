# Background Check-in Gate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端边界上的立即唤醒加一道门：有后台工作（shell 或子任务，数量 > 0）在飞时不立即唤醒，改为武装一个默认 5 分钟（可配置，秒）的静默计时器；计时器到期且会话仍无活动 → 一次性"进展检查"唤醒；期间有任何活动 → 取消计时，等下一个 idle 重新仲裁。

**Architecture:** 复用现有边界仲裁（`arbitrateBoundary`）+ 现有看门狗 tick（30s 周期）两个挂载点。新增两个纯内存状态：`activeSessions`（本 project 内所有过 session 门禁的会话的活跃标记，goal 无关）与 `checkinDue`（每会话一次性进展检查 deadline）。在飞计数 = `goal.waitingShells.length`（现有）+ 其它活跃会话数（新）。不认工具名/父子关系——只数数量（用户裁决）。

**Tech Stack:** TypeScript / bun test / 现有 harness（`test/harness.ts`）；无新依赖。

## Spec（用户裁决原文，2026-10-17，三条消息合并）

1. "主任务结束立马唤醒的前提是，没有任何 shell 或者子任务在运行。一旦有任何后台任务在运行，就不能立即唤醒，因为会话本来就是在等待。这种情况只做一件事情，就是开始计时5分钟。"
2. "如果5分钟内，会话还没有活动，只是触发一下进展检查而已，如果在这期间有任何活动，都立即停止计时并等待下一个idle触发。"
3. "这个等待时间，默认值5分钟，可以作为插件的配置参数来修改。以秒为单位。"
4. 补充裁决："拿不到子任务或者shell名称不重要，我们只需要全程跟踪，当前有无正在执行的 shell 或子任务数量 > 0。"
5. 补充裁决："（插件）也不用主动去替会话检查任务是否死掉了，我们只是在会话 idle 了一定时间后，如果还没激活，提醒它去检查而已"——提醒机制零任务体检：不探测、不诊断输出、不判"卡死"，文案只是提醒；检查动作由会话（模型）自己完成。

**语义细化（裁决的直接推论，实施依据）：**
- 在飞边界上**重新武装会重置 5 分钟时钟**（边界本身说明模型刚干完一轮 = 活动；"等待下一个 idle 触发" → 时钟只在持续静默期间走动，进展检查只在真正 5 分钟无活动时发生）。
- `goal_wait`（waitUntil）生效期间：不武装计时器、不触发进展检查（沿用 §7.1 quiet 静默一切语义）。
- 现有例外保留：上一条 inbox 是本插件看门狗唤醒时，边界走正常仲裁（§7.1：check-in 的纯文本回复计入 stall 阶梯），不重新武装。
- shell 退出唤醒（exit wake / lost reconcile）是事件驱动的结果投递，不属于"等待中的唤醒"，**不动**。
- 被取代：原 shell 双信号 check-in（零增长 `shellStallMs` / 有增长 `waitCheckInMs` 两个分支）——由会话级 5 分钟一次性计时器统一覆盖（更宽：同时覆盖子任务；更简单：一个机制）。
- 按裁决 5，看门狗的**全部主动检查机制移除**：probe 退出自愈（probe 里 exited 但无事件）、lost reconcile、tail 尾状态、双信号 check-in。shell 状态机退化为纯事件驱动：`shell.started` → waitingShells +1；`shell.exited` 事件 → −1 +（会话 idle → exit wake 投递退出事实）。罕见事件丢失（exited 事件丢）→ waitingShells 条目变陈旧 → 门禁持续 armed → 该会话退化为"5 分钟提醒"节奏（活存性保持、节奏降级）——接受，模型被提醒后自己查真。

## Global Constraints

- 插件自产文本一律英文（i18n 裁决 #12126）；用户内容原样。
- 对 system part 零写入（前缀缓存裁决）。
- options 解析风格与现有字段一致：整数 ≥ 1，非法回退默认值。
- TDD：先红测试 → 最小实现 → 绿 → commit。
- 门禁：`bun run test` + `bun run typecheck`（当前基线 245 pass / 0 fail，930 expect；本计划完成后 expect 总数变化属预期）。
- 版本保持 1.0.5（发布前不递增，用户规则）；commit 用 conventional 前缀。
- `checkinDue` / `activeSessions` 均纯内存、不持久化（与现有 watchdog 状态同生命周期；宿主重启后由下一个边界重新武装——可接受，已记录）。

## Review Focus

| # | 失败模式 | 期望行为 | 钉在 |
|---|---|---|---|
| 1 | 同宿主上有**其它 project** 的活跃会话 | `sessionBelongs` 门禁 fail-closed：不计入在飞数，立即唤醒照旧 | Task 2 |
| 2 | 事件丢失：子会话终态边界未见（在飞过计数）或 `shell.exited` 未见（waitingShells 条目陈旧） | 无自愈但自限：5 分钟进展检查照常触发，绝不静默死等（shell 陈旧条目 = 该会话降级为 5 分钟提醒节奏） | Task 3 |
| 3 | 在飞期间 idle 风暴（长后台任务期间每 ~30s 一个边界） | 每个边界重新武装 → 时钟重置；只有完整 5 分钟静默窗口才触发一次 | Task 2 + 3 |
| 4 | `goal_wait` 静默窗口内遇到在飞边界 | 不武装、不触发（quiet 语义），goal_wait 到期后的路径不受影响 | Task 2 + 3 |
| 5 | 边界武装后、到期前 goal 进入终态/暂停 | tick ghost 规则先清后判：无幽灵进展检查注入 | Task 3 |

---

### Task 1: options + 进展检查文案（纯函数地基）

**Files:**
- Modify: `src/options.ts`（`Options` 接口、`DEFAULT_OPTIONS`、`resolveOptions`）
- Modify: `src/wake.ts`（新增文案 builder；`shellCheckInText` 暂留——Task 3 删）
- Test: `test/options.test.ts`（或现有 options 断言所在文件）、`test/wake.test.ts`

**Interfaces:**
- Produces: `Options.checkInDelaySec: number`（解析自插件 options 键 `checkInDelaySec`，默认 300，秒）；删除 `Options.shellStallMs` / `Options.waitCheckInMs`
- Produces: `export function backgroundCheckInText(goal: GoalRecord, inFlight: number, waitSec: number): string`（wake.ts，供 Task 3 消费）

- [ ] **Step 1: 写失败测试（options）**

`checkInDelaySec` 断言（风格对齐现有 `watchdogTickMs` 断言）：默认 300；`{checkInDelaySec: 60}` → 60；`{checkInDelaySec: 0}` / `{-5}` / `{0.5}` / `{"300"}` → 回退 300。同时把现有对 `shellStallMs` / `waitCheckInMs` 默认值的断言改为**不再存在**（`expect("shellStallMs" in o).toBe(false)` 形式，与现有字段断言同构）。

- [ ] **Step 2: 写失败测试（文案）**

`backgroundCheckInText` byte-pinned 断言（英文、无 CJK——沿用 wake.test 现有 CJK-free 检查）：

```
Background check-in: ${inFlight} background item(s) in flight, no session activity for ${waitSec}s. Check progress: what finished, what is next — advance the goal.
```

（具体串以本行字面为准；两个参数化用例：inFlight=1/waitSec=300 与 inFlight=3/waitSec=90。）

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test`（仅新用例红）。Expected: FAIL（字段不存在 / 函数未导出）。

- [ ] **Step 4: 实现**

`options.ts`：接口加 `checkInDelaySec: number`；`DEFAULT_OPTIONS` 加 `checkInDelaySec: 300`；`resolveOptions` 加 `checkInDelaySec: num("checkInDelaySec", 300)`；**删** `shellStallMs` / `waitCheckInMs` 三处（接口、默认、解析）——删后全局 grep 这两个名字，清掉所有引用（controller.ts:1691、测试、README 留 Task 4）。`wake.ts`：按 Step 2 字面实现 `backgroundCheckInText`（纯函数，风格对齐 `shellCheckInText`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test` + `bun run typecheck`。Expected: 新用例 PASS；typecheck 会因 controller 残留引用 `shellStallMs`/`waitCheckInMs` 报错 → **本任务先只改 options 字段引用处为最小兼容**（若 controller 1691 处引用导致编译红，则将 Task 3 的分支删除步骤提前到本任务 Step 4 一并执行——二选一，以 typecheck 0 为准）。

- [ ] **Step 6: Commit**

```bash
git add src/options.ts src/wake.ts test/
git commit -m "feat: checkInDelaySec option (seconds, default 300) + background check-in text"
```

---

### Task 2: 在飞计数 + 边界门禁 + 活动取消

**Files:**
- Modify: `src/controller.ts`（`handleEvent` switch、`arbitrateBoundary` 快路径 1092-1114、各活动 handler、`inFlightCount` 新增）
- Test: `test/background-gate.test.ts`（新建，harness 驱动；沿用 `test/arbiter.test.ts` 的 `ev()`/`succeeded()` 辅助风格）

**Interfaces:**
- Consumes: `Options.checkInDelaySec`（Task 1）
- Produces: `private readonly activeSessions = new Map<string, number>()`（sessionID → 首次活跃时刻）；`private readonly checkinDue = new Map<string, { due: number; inFlight: number }>()`；`private inFlightCount(goal: GoalRecord, sessionID: string): number`（Task 3 消费）

- [ ] **Step 1: 写失败测试（新建 `test/background-gate.test.ts`）**

用例（全部通过 harness 发事件断言"是否注入了普通唤醒/是否武装了计时器"；计时器内部状态经 harness 暴露的只读视图或经 tick 行为黑盒断言——沿用现有 arbiter/watchdog 测试的观察方式，不新增公共 API）：

1. **在飞=shell → 不立即唤醒**：goal active（cap turns 大），`shell.started`（父会话）→ `idle` 边界 → 断言 0 条普通唤醒（现状快路径已有，改由 inFlight 计数实现后行为不变）。
2. **在飞=子会话活跃 → 不立即唤醒**：子会话 `session.execution.started`（同 project，harness `setSession` 配 projectID）→ 父会话 `idle` 边界 → 断言 0 条普通唤醒（**新行为**）。
3. **在飞=0 → 立即唤醒不变**（回归）：无任何其它活跃会话/shell → 边界 → 1 条立即唤醒。
4. **跨 project 排除**：子会话 `setSession` 配**不同** projectID → 其 started 后父会话边界 → 仍立即唤醒（Review Focus #1）。
5. **活动取消**：子会话活跃 + 在飞边界武装后 → 父会话收到 `session.usage.updated`（或 tool.called）→ 再等到 due 时刻（harness 控时）→ tick → 断言 0 条进展检查（计时器已取消）。
6. **重新武装重置时钟**（Review Focus #3）：在飞窗口内连发两个边界（中间一次完整回合：execution.started → tool.called → idle）→ 第二次边界后时钟从新边界起算；旧 due 提前到点时不触发。
7. **quiet 不武装**（Review Focus #4）：goal.waitUntil 在未来 → 在飞边界 → 断言 checkinDue 未武装（黑盒：due 时刻 tick 后 0 注入，且 waitUntil 路径断言与现有 quiet 测试同构）。
8. **watchdog-wake 例外保留**：上一条 inbox 为本插件看门狗唤醒 + 在飞 > 0 → 边界走正常仲裁（stall 计数语义与现有 §7.1 测试一致，不新增断言，现有用例须继续绿）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test test/background-gate.test.ts`。Expected: 用例 2（新行为）FAIL，其余按现状。

- [ ] **Step 3: 实现**

`handleEvent` switch（sessionBelongs 门禁之后、case 分派内）：
- `"session.execution.started"` → `this.activeSessions.set(sessionID, Date.now())`
- `"session.execution.succeeded" | "session.execution.failed" | "session.idle" | "session.execution.interrupted"` → `this.activeSessions.delete(sessionID)`

`inFlightCount(goal, sessionID)`：`(goal.waitingShells?.length ?? 0) + [...this.activeSessions.keys()].filter((s) => s !== sessionID).length`。

`arbitrateBoundary` 快路径（替换现 1092-1114 的 waitingShells-only 逻辑，保留 (a) 例外）：

```
const inFlight = this.inFlightCount(goal, sessionID);
if (inFlight > 0) {
  const quiet = goal.waitUntil !== undefined && Date.now() < goal.waitUntil;
  const last = this.lastInbox.get(sessionID);
  const lastWatchdog = last !== undefined && last.kind === "wake" && last.watchdog === true;
  if (!quiet && !lastWatchdog) {
    this.checkinDue.set(sessionID, { due: Date.now() + this.options.checkInDelaySec * 1000, inFlight });
    this.ensureWatchdog(sessionID); // 看门狗 tick 兼任计时器心跳（tick 内 no-shell 时改为 checkinDue 存活判据）
  }
  if (lastWatchdog) { /* 落入下方正常仲裁：§7.1 例外不变 */ }
  else {
    if ((goal.waitingShells?.length ?? 0) > 0) this.ensureWatchdog(sessionID);
    this.markTurnInactive(sessionID);
    await this.recordHandled(sessionID, eventID, goal);
    return;
  }
}
```

（`lastWatchdog` 为真时不 return，落入现有归因/stall 段——与现状 (a) 例外同构。）

活动取消：`onExecutionStarted` / `onToolCalled` / `onUsageUpdated` / `onInboxEnqueued` / `onShellStarted` 五个 handler 各加一行 `this.checkinDue.delete(sessionID)`（自身唤醒入队的过度取消无害——在飞路径本就不注入唤醒，最坏下个边界重新武装）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test`。Expected: background-gate 8 用例 PASS；现有 arbiter/arbiter 归因/watchdog 用例全绿（快路径行为在 shell 场景不变）。

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts test/background-gate.test.ts
git commit -m "feat: background in-flight gate on immediate wake (shells + active sessions) with check-in arming"
```

---

### Task 3: 计时器触发 + 移除全部主动检查机制 + 终态守卫

**Files:**
- Modify: `src/controller.ts`（`runWatchdogTick` 1631-1708 整体收缩、ghost 规则 1634-1639、disarm 判据 1641-1644）
- Modify: `src/wake.ts`（删 `shellCheckInText` 及其死参数）
- Modify: `src/types.ts` + `index.ts`（`ControllerDeps.shellProbe` 零调用点后移除，含 fake/harness 侧引用）
- Test: `test/watchdog.test.ts`（删双信号 + probe 相关用例、保留**事件驱动**退出唤醒用例）、`test/background-gate.test.ts`（增触发用例）

**Interfaces:**
- Consumes: `checkinDue`、`inFlightCount`、`Options.checkInDelaySec`（Task 2/1）、`backgroundCheckInText`（Task 1）、`deliverWatchdogWake`（现有）

- [ ] **Step 1: 写失败测试（background-gate 增补 + watchdog 调整）**

background-gate 增补：
9. **到期触发一次**：在飞边界武装 → harness 快进至 due（`checkInDelaySec` 配小值如 1s + 真实等待或注入时钟——harness 现有控时方式）→ tick → 断言恰好 1 条进展检查（文本 = `backgroundCheckInText` 字面，metadata goalControl/watchdog 标记与现有 watchdog 唤醒一致）；再 tick → 0 条（one-shot，未重新武装前不复发）。
10. **子会话终态事件丢失**（Review Focus #2）：子会话只 started 无终态 → 到期照触发（过计数自愈合）。
11. **active 会话不触发**：due 到点但父会话 `execution.started` 未结束（active）→ tick → 0 注入；回合结束（idle）后下一次 tick → 注入（若仍静默）。
12. **quiet 不触发**（Review Focus #4 补）：waitUntil 覆盖 due 时刻 → 0 注入。
13. **终态守卫**（Review Focus #5）：武装后 goal 被 complete/block（任意终态）→ tick → 0 注入且 checkinDue 被清。
14. **shell 事件丢失降级**（Review Focus #2 补）：`shell.started` 后无 `shell.exited`（条目陈旧）→ 边界仍在飞 → 5 分钟提醒照常触发（无自愈、无永久静默）。

watchdog.test：删双信号 check-in 用例（零增长/有增长）+ probe 探测相关用例（退出自愈、lost reconcile、`exitNotified` 竞态）；**保留**事件驱动的 `shell.exited` → idle 退出唤醒用例（必须继续绿）；引用 `shellStallMs`/`waitCheckInMs` 的 boot 配置断言同步删。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test test/background-gate.test.ts test/watchdog.test.ts`。Expected: 9-13 FAIL（触发逻辑未实现）。

- [ ] **Step 3: 实现**

`runWatchdogTick`：
- ghost 规则（1634-1639）扩为：`goal === undefined || goal.status !== "active"` → 除现有 disarm 外加 `this.checkinDue.delete(sessionID)`。
- disarm 判据（1641-1644）：`waiting.length === 0` → 改为 `waiting.length === 0 && !this.checkinDue.has(sessionID)`。
- 循环前（probe 之前，避免无 shell 时白探）加触发段：

```
const due = this.checkinDue.get(sessionID);
if (due !== undefined && now >= due.due && idle && !quiet) {
  this.checkinDue.delete(sessionID); // 先删后注入：重叠 tick 不再复发（one-shot）
  await this.deliverWatchdogWake(goal, backgroundCheckInText(goal, due.inFlight, this.options.checkInDelaySec));
}
```

（`idle`/`quiet` 取现有 1654-1655 的同名局部量。）

- 按裁决 5 **移除全部主动检查**：probe 退出自愈段（1660-1670 `p.state === "exited"` 探测投递）、lost reconcile 路径、`shellWatch` 状态（tail/changed/lastTailAt/checkedIn）、probe 双信号分支（1685-1701）；`runWatchdogTick` 最终形态 = ghost 规则（含 `checkinDue.delete`）→ checkinDue 到期触发段 → disarm 记账，**全程零 probe 调用**。
- `deps.shellProbe` 随之零调用 → 从 `ControllerDeps`（types.ts）与 `index.ts` 装配、harness fake 中移除（生产日志的 "probe.list failed" 噪音同步消失）；grep 全仓确认无残留引用。
- **保留**：纯事件驱动路径——`shell.exited` 事件 → `waitingShells` −1 +（会话 idle → exit wake 投递退出事实）。probe 路径删除后 `exitNotified` 竞态守卫失去意义，一并删。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test` + `bun run typecheck`。Expected: 全绿（expect 总数较基线 930 变化：删双信号用例、增 background-gate 13 用例、options 字段断言变化——记录新基线数字）。

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts src/wake.ts test/
git commit -m "feat: one-shot 5-min background check-in on watchdog tick; retire dual-signal shell check-in"
```

---

### Task 4: 文档 + 全量门禁收口

**Files:**
- Modify: `README.md`（options 表：+`checkInDelaySec`（秒，默认 300，一句话说明在飞时行为），−`shellStallMs`/`waitCheckInMs` 两行）
- Modify: `docs/superpowers/specs/2026-10-15-goal-loop-design.md`（§7 追加一节"Background check-in gate（2026-10-17 裁决）"：裁决原文 + 语义细化 + 被取代机制，不改旧文其余部分）

- [ ] **Step 1: 更新 README + spec 增补节**

- [ ] **Step 2: 全量门禁**

Run: `bun run test` + `bun run typecheck`。Expected: 0 fail；记录新基线（pass 数 / expect 数）写入台账。

- [ ] **Step 3: Commit**

```bash
git add README.md docs/
git commit -m "docs: background check-in gate option + spec section"
```

---

## 执行后（不在本计划任务内，另起）

- 台账 `.superpowers/sdd/2026-10-15-opencode-goal/progress.md` 增段（部署前）。
- 129 本地播种验证（新 seed 目录 + nudge）：现场造"shell 在飞 + idle"场景，观察边界不再立即唤醒、5 分钟（可临时配小值验证触发）后一条进展检查、有活动时取消。
- 版本仍 1.0.5；发布等用户 GO（随 1.0.6 批次一起）。
