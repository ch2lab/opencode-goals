# Shell Store Gate 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复后台门禁（background-checkin-gate）的在飞盲区：宿主 2.0.32 对**后台工具 shell 不发** `session.shell.started/ended` 事件（仅 API shell 与前台工具 shell 发），导致模型后台工作不可见、in-flight 恒 0、每个边界立即唤醒（129 vllm 会话 5 秒唤醒死循环实证）。把边界仲裁的 shell 在飞计数从"事件驱动的 `goal.waitingShells`"换成"宿主 shell store 查询"（`shell.list`，按 location 查、按 `metadata.sessionID` 过滤）。

**Architecture:** 探测层加一个方法 `shellList(locationDirectory)`（走插件的进程内 RPC 通道，与 `session.inbox.list` 同路）。边界仲裁在决策点现查一次：in-flight = （该 location shell store 中 `status=="running"` 且 `metadata.sessionID == 本会话` 的条数）+（活跃子任务会话数，沿用现有 `activeSessions` 事件机制）。查询失败 → 按在飞处理（安全方向：退化为进展检查节奏，绝不假唤醒，绝不永久静默）。查询无状态 → 跨宿主重载天然自愈（对照：旧事件状态重载即丢）。事件路径（`session.shell.started/ended`）原样保留（前台/API shell 的 exit wake + 活动取消语义）；后台 shell 的退出由宿主自己的 synthetic 完成通知投递给模型，插件不重复唤醒。

**Tech Stack:** TypeScript / bun test / 现有 harness（`test/harness.ts`）+ 现有 live-smoke（`scripts/live-smoke.ts` + `scripts/host.ts`）；无新依赖。

## Spec（用户裁决链，2026-10-17）

1. 根因定性（取证，记忆 #12138）："宿主 2.0.32 只对 API 创建 session shell 与前台工具 shell 发 `session.shell.started/ended` 持久事件；后台工具 shell（`background: true`/自动后台化）不发任何 shell 事件" → 门禁 in-flight 计数（事件驱动）对模型后台工作全盲。
2. 用户线索："UI 上能显示有几个 shell 在执行，说明一定有查询接口" → 实测定位：`GET /api/shell?location[directory]=<dir>`（宿主 client SDK 的 `shell.list`，"List shells for a location. Exited commands are not included."），条目含 `id / status / command / cwd / pid / time.started` 与 **`metadata.sessionID`**（会话归属）。
3. 用户问题（多会话同目录）：查询按 location（目录）返回该目录下**所有会话**的 shell → 按 `metadata.sessionID` 过滤，只数本 goal 会话自己的（+ 活跃子任务会话）；其它会话的 shell 不计入；无归属条目（非会话 `POST /api/shell` 创建）不计入。
4. 用户拍板："D" —— shell store 查询方案（取代 A 转录对账 / B 改宿主 / C 接受限制）。

**语义细化（裁决的直接推论，实施依据）：**
- 查询时机：**边界仲裁时一次**（决策点，零陈旧）。tick 不查（进展检查文案用武装时刻捕获的计数，byte-pinned 语义不变）。
- 查询失败（RPC 不可用/超时/形状异常）→ 按 in-flight>0 处理：武装进展检查 + 一次性 warn 日志。与既有"probe 失败退化为提醒节奏"先例同方向（活存性保持、节奏降级、绝不静默死等）。
- 查询成功且空 = 真 0 → 正常仲裁（立即唤醒照旧，含 (a) 例外、stall 阶梯——均不动）。
- `goal.waitingShells` 降级为**持久化事实锚**（事件路径继续维护它），不再是门禁输入。
- 后台（查询可见但无事件）shell 的退出：**不发插件 exit wake**——宿主自动向会话投递 synthetic 完成通知（实机证据：vllm 会话 msg 156 `metadata.source=shell, state=completed`）；模型被宿主通知唤醒后自查。事件路径的 exit wake 只对发事件的 shell（前台/API）保留。
- 子任务会话部分不变：`activeSessions`（execution 事件驱动）继续计数；子任务即使其 shell 在别的 location 也能被数到（会话级计数，不依赖 shell 查询）。

## Global Constraints

- 插件自产文本一律英文（i18n 裁决）；用户内容原样。
- 对 system part 零写入（前缀缓存裁决）。
- TDD：先红测试 → 最小实现 → 绿 → commit。
- 门禁：`bun run test` + `bun run typecheck`（当前基线 247 pass / 0 fail，887 expect；本计划新增 expect 属预期）。
- 版本保持 1.0.6（发布前不递增，用户规则；下一发布批次 1.0.7 待用户"发"）。
- 远程 129 操作一律脚本文件（本地写 sh → scp → `sed -i 's/\r$//'` → bash）；PowerShell 不做内联远程命令。

## Review Focus

| # | 失败模式 | 期望行为 | 钉在 |
|---|---|---|---|
| 1 | **同目录多会话**：同 location 内其它会话有 running shell | 按 `metadata.sessionID` 过滤 → 本会话 in-flight=0 → 立即唤醒照旧，不替别人等 | Task 3 |
| 2 | 查询通道故障（RPC 不可用 / 方法名错 / 超时） | 按在飞处理：武装进展检查、不抛错、warn；目标绝不死等（300s 提醒照发） | Task 1 + 3 |
| 3 | 条目缺 `metadata.sessionID`（非会话 shell） | 不计入任何 goal 的在飞数 | Task 3 |
| 4 | 宿主重载（takeover / 热载）后，重载前启动的后台 shell | 首个边界现查即可见（查询无状态）→ 门禁正常 hold；对照旧事件状态重载即丢 | Task 3 |
| 5 | 边界风暴（长后台期间频繁边界） | 每边界一次进程内查询（O(1) 本地调用）；无查询放大、无状态累积 | Task 3 |
| 6 | `shell.list` 返回形状漂移（宿主版本升级） | 解析容错：字段缺失按 0 计 + warn，不按在飞（形状完整度可判时）；方法级失败才按在飞 | Task 3 |

---

### Task 1: 实证 `shell.list` 进程内 RPC 可达性（live smoke，最高风险项先行）

**Files:**
- Modify: `scripts/live-smoke.ts`（加一个 probe 段）

**Interfaces:**
- Consumes: 现有 `startHost`（`scripts/host.ts`）+ live-smoke 既有的插件播种/会话驱动流程。
- Produces: live-smoke 的新断言 "shell list probe PASS"：(a) 进程内 `rpcCall("shell.list", { location: { directory } })` 可达（若宿主返回 "RPC is unavailable: shell" 类错误，按错误信息驱动迭代方法名——本任务交付的就是**被实机钉死的正确方法名**）；(b) API 创建（`POST /api/session/:id/shell`）的 sleep 30 出现在列表中且 `status=="running"`、`metadata.sessionID` 归属正确；(c) 根 location（directory `""`）查询不炸。

- [ ] **Step 1: 写 probe 段（先失败运行，确认错误形状）**

在 live-smoke 的现有流程尾部（会话仍存活、有 API shell 在跑处）加：经插件进程内通道调 `shell.list`（经 probe 的 `rpcCall` 或直连 `callRpc`——视 live-smoke 现有装配取同路），打印原始返回；断言三条（a/b/c）。先跑，预期 (a) 可能 FAIL（方法名未钉死）——把宿主错误原文（含 "RPC is unavailable: <name>" 的命名线索）留在输出里。

- [ ] **Step 2: 按错误信息迭代方法名直到 (a) PASS**

候选命名（错误驱动，不盲试）：`shell.list` → 若不可用，从错误的 "RPC is unavailable: X" 与宿主 client SDK 命名（`domain.method`）推导下一个候选。每轮只改一个名字。

- [ ] **Step 3: (b)(c) 全绿后 commit**

Run: live-smoke 全量（`bun run scripts/live-smoke.ts`，本机隔离宿主）。
Expected: 全部 PASS 含新 "shell list probe" 段。
```bash
git add scripts/live-smoke.ts
git commit -m "test: live-smoke probe — pin shell.list in-process RPC method + entry shape"
```

**Finding 记录点**：若方法名最终与 `shell.list` 不同，把"实机钉死名 + 宿主版本 2.0.32"写进本计划台账（执行时记）。

---

### Task 2: 探测层 `shellList` + 类型

**Files:**
- Modify: `src/types.ts`（`ShellEntry` + `WakeProbe.shellList`）
- Modify: `src/probe.ts`（若 probe 接口不在 types.ts，按现状）
- Modify: `index.ts`（实现 `shellList`）

**Interfaces:**
- Consumes: Task 1 钉死的方法名；`callRpc(method, input)`（index.ts 既有）；宿主条目形状（Task 1 钉死：`{ id, status, command?, cwd?, pid?, time: { started }, metadata: { sessionID? } }`）。
- Produces: `type ShellEntry = { id: string; status: string; command?: string; cwd?: string; sessionID?: string; started?: number }`；`WakeProbe.shellList: (locationDirectory: string) => Promise<ShellEntry[]>`——归一化：`metadata.sessionID`（string 才取，否则 undefined）、`time.started`（number 才取）、缺字段容忍；**RPC 级失败向上抛**（由 Task 3 的调用方决定安全方向），**单条字段缺失不抛**（按可用字段归一）。

- [ ] **Step 1: 类型 + 接口签名**

`src/types.ts` 加 `ShellEntry`；probe 接口加 `shellList`（JSDoc 注明：宿主 shell store 查询，location 作用域，条目含会话归属；失败语义见调用方）。tsc 此时对 index.ts 实现缺失报错（红）。

- [ ] **Step 2: index.ts 实现**

`shellList: async (dir) => { const raw = await callRpc(<Task 1 方法名>, { location: { directory: dir } }); ... 归一化 ... }`。`callRpc` 抛错 → 原样上抛。

- [ ] **Step 3: 绿 + commit**

Run: `bun run typecheck`（0 错）；harness 测试中的 fake probe 需补 `shellList`（默认 `Promise.resolve([])`）——一并提交（测试基建跟随接口）。
```bash
git add src/types.ts index.ts test/harness.ts
git commit -m "feat: probe.shellList — host shell store query (location-scoped, session-attributed)"
```

---

### Task 3: 门禁计数切到查询（TDD 主体）

**Files:**
- Modify: `src/controller.ts`（`inFlightCount` 输入源；`arbitrateBoundary` 无结构变化）
- Test: `test/background-gate.test.ts`（既有 13 用例的 fake probe 改造 + 新用例 6 条）

**Interfaces:**
- Consumes: Task 2 `probe.shellList`；既有 `probe.sessionGet(sessionID).location.directory`（查询用会话自己的 location）；既有 `activeSessions` 计数（子任务，不动）；既有 (a) 例外 / quiet 窗 / checkinDue（全不动）。
- Produces: `inFlightCount(sessionID)` = `shellCount`（查询，本会话 running 条目数）+ `activeOtherSessions`；查询失败 → 返回 `undefined`（"未知"）→ 边界仲裁把未知当在飞（武装 + warn）。

- [ ] **Step 1: 红测试（6 条新用例，先写后跑，确认按预期失败）**

`test/background-gate.test.ts`（fake probe 增加 `shellStore: Map<sessionID, ShellEntry[]>`；`shellList(dir)` 返回该 store 全量；事件驱动的 fake 在 `shell.started/ended` 时同步维护 store——镜像宿主行为）：
1. **查询在飞 → hold**：store 有本会话 1 条 running → 边界 → 无立即唤醒、`checkinDue` 武装。
2. **同目录他会话 shell 不计**（Review Focus #1）：store 有他会话 running 1 条（同 location）→ 本会话 in-flight=0 → 立即唤醒照旧。
3. **查询失败 → 按在飞**：`shellList` 抛错 → 边界不炸、武装进展检查、warn 日志一次。
4. **无归属条目不计**：store 条目 `sessionID: undefined` → in-flight=0 → 立即唤醒。
5. **子任务共存**：本会话 0 shell + 1 个活跃子任务会话 → in-flight=1 → hold（查询与 activeSessions 两输入并存）。
6. **重载自愈**：`shellStore` 预置（模拟重载前已启动的 shell）、新建 controller 实例（无任何事件历史）→ 首个边界 → hold（证明查询无状态）。

Run: `bun test test/background-gate.test.ts` → 新 6 条 FAIL（计数仍读 `waitingShells`）。

- [ ] **Step 2: 实现**

`inFlightCount`：`const loc = await this.probe.sessionGet(sessionID); const list = await this.probe.shellList(loc.location.directory); n = list.filter(e => e.sessionID === sessionID && e.status === "running").length`；catch → `return undefined` + `console.warn`（一次性文案英文，钉死：`shell store query failed for <sessionID>; treating as in-flight: <err.message>`）。仲裁侧：`n === undefined` 视同在飞（武装 + 不计 stall）；`n + activeOther > 0` 武装；`= 0` 正常仲裁（(a) 例外照旧在前）。

- [ ] **Step 3: 既有 13 用例回归**

fake probe 的 store 由事件维护后，原"事件武装"场景行为不变（store 同步更新 → 计数同值）；`waitingShells` 字段保留（事件路径继续写，退出唤醒/取消语义不变）但不再被 `inFlightCount` 读取。

- [ ] **Step 4: 全量绿 + commit**

Run: `bun run test`（247 + 6 新增，0 fail）+ `bun run typecheck`（0 错）。
```bash
git add src/controller.ts test/background-gate.test.ts
git commit -m "fix: gate in-flight count from live shell store query (covers model background shells)"
```

---

### Task 4: spec §7.3 + README + 台账 + 129 实机复验（收尾任务）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-goal-loop-design.md`（§7.3 新章；§7.2 加指引注记）
- Modify: `README.md`（options 表不变；已知限制节改写：门禁现覆盖模型后台工作；注明边界时一次 location shell 查询）
- Create: `.superpowers/sdd/2026-10-17-shell-store-gate/progress.md`（本计划台账）
- Modify: `.superpowers/sdd/2026-10-15-opencode-goal/progress.md`（总台账第 8 轮段）

**Interfaces:**
- Consumes: Task 1–3 全部成果 + 129 实证记录（根因 #12138、A/B 探针、shell.list 实机 JSON）。
- Produces: 规格/文档与实现一致；129 复验证据（**用真实模型后台 shell**——原始 bug 场景：模型 `shell` 工具 `background: true` 起 `sleep`，边界 hold → 到期一条进展检查 → 宿主完成通知退出，无死循环）。

- [ ] **Step 1: spec §7.3（D 裁决原文 + 设计 + 语义推论 + 删除/保留清单）+ README + 台账，commit**

```bash
git add docs/superpowers/specs/2026-10-15-goal-loop-design.md README.md
git commit -m "docs: spec §7.3 shell-store gate (ruling D) + README limits rewrite"
```

- [ ] **Step 2: 129 实机复验（新 seed + 小 checkInDelaySec，模型真后台 shell）**

新缓存目录播种（`date +%s%3N` + nudge 热载）；`checkInDelaySec: 8` / `watchdogTickMs: 1000` 临时 nudge；新会话 `/goal set`（目标含"起一个后台 sleep 然后结束回合"）→ 实证：边界**不**立即唤醒（hold）→ +8s 一条进展检查（byte 文案）→ 模型回复回合 → 宿主完成通知投递后目标正常推进；清理（`/goal clear` 带用户原话接地 + 配置恢复 + 会话清）。配置恢复 = 回原 options。
Evidence 标准：时间线（idle → 无 wake → 8s check-in → 完成通知）+ goal 状态 + 无 "5 秒死循环" 复现。

- [ ] **Step 3: 记忆 + 台账完结 + 向用户报告（含 1.0.7 发布待 GO、vllm goal resume/clear 待用户定）**

---

## 执行顺序与依赖

T1 → T2 → T3 → T4 严格串行（T2 需 T1 钉死方法名；T3 需 T2 接口；T4 需全部）。T1 是唯一可能"宿主内部不符预期"的任务——若 `shell.list` 进程内不可达且错误信息无命名线索，STOP 上报（备选：宿主 HTTP 自查询需 port+auth 信息源，属新设计，需用户再裁决）。
