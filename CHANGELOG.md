# Changelog · 版本记录

约定（2026-10-20 裁定）：
- 在途版本记 `## [1.1.8] - 2026-10-24`；发布时（与 version bump 同批提交）把内容移到 `## [X.Y.Z] - YYYY-MM-DD`（日期 = 发布日）。
- 每个版本章节必须有内容——CI 硬门：打 tag 的版本找不到非空章节 = 发布失败（npm publish 之前，fail fast）。
- 章节三段结构：`### 新增`（新功能/新工具/新命令）、`### 修复`（修了什么，含 incident 来源）、`### 优化与设计`（架构/行为变更/设计裁定）；可加 `### 验证`。
- 语言：**英文**（2026-10-22 裁定，适用于此后所有新版本：小节用 `### Added` / `### Fixed` / `### Optimizations & Design` / `### Verification`）；[1.1.7] 及更早章节保留原文。
- npm publish 成功后，CI 自动创建 GitHub Release：标题 `vX.Y.Z`，正文 = 本章内容（重跑幂等 edit）。

## [Unreleased]

### Fixed
- **`goal_wait` storm: during the wait window the loop re-woke the model on every idle boundary (the 129, 2026-10-25 incident: after the model called `goal_wait(3m)` and its turn ended, the goal was woken every 6–15 seconds — 25 continuations in ~2 minutes, each wake a full LLM turn that re-called `goal_wait` and pushed the window back; on top of that, the window's deadline wake fired NEVER: the last `execution.started` had disarmed the watchdog tick that owns the deadline).** Two root causes (spec §59): (1) the waitUntil quiet-window gate only existed in the in-flight branch of the boundary — the gate=0 shape (nothing in flight, exactly what goal_wait produces) fell straight through to a wake; (2) `execution.started` unconditionally stopped the watchdog tick, killing the goal_wait deadline's heartbeat. Now: a gate=0 boundary inside an active wait window is a HOLD (`quiet window (goal_wait until …)` decision line — no wake, no stall accounting, no check-in arm) and the tick keeps running while a deadline is pending, so the one-shot "Goal wait period ended" wake lands exactly at the deadline (verified on an isolated real host: zero session activity inside the window, one expiry, quiet-window hold line in the decision log).

## [1.1.11] - 2026-10-25

### Fixed
- **An armed check-in deadline could be lost forever across a machine sleep or host reload — a goal with in-flight background work could park until the next human message** (local host, 2026-10-25 overnight incident: a one-shot 5-minute check-in armed at 00:26 was never delivered — the machine slept across the deadline — and a host location evict/reboot at 01:03 re-instantiated the plugin, wiping the in-memory deadline and its watchdog; the session was fully idle and shell-lifecycle events are not boundaries, so nothing could wake the loop for hours). The fix (spec §58): the armed check-in deadline is now PERSISTED with the goal record (the boundary arm mirrors it into the record with an explicit save — the host's terminal boundary event is ID-less, so the mirror cannot piggyback on a conditional save; the tick clears it on fire/discard — clear-then-deliver, so a reload never double-fires); `start()` then applies RESTORE-OR-DELIVER (if the in-flight work is still visible the deadline is restored and the tick owns it; if the work died during the downtime — the overnight shape, a background process cannot survive a machine sleep — or is unqueryable, the check-in is delivered immediately, late but the model must find out what happened to what it was waiting on; a bare restore would be fatal, since the loop's ordinary gate-0 boundary wake cancels a pending deadline on `execution.started`); and an ORPHAN SWEEP on the 30-second liveness clock (independent of event flow — its target is exactly the zero-event case) re-arms an immediate check-in for any active goal that has in-flight work but no live watchdog (quiet windows and turns blocked on a foreground shell are excluded — the §57 deadline wake and the §52/§54 machinery own those). Verified on an isolated 2.1.4 host end-to-end (`verify-persist`: arm at an in-flight boundary → hard-kill the whole host process → same-dir restart → the persisted deadline's check-in lands in the successor session, one-shot).

## [1.1.10] - 2026-10-24

### Fixed
- **`goal_wait` deadlines never woke the loop — a goal waiting on something slept past its own deadline forever** (local host, 2026-10-24: the model called `goal_wait` for 4 minutes and told the user it would "automatically re-check at 17:29"; nothing happened for 7+ minutes). Root cause (decision log + host log forensics): `waitUntil` was a record-only quiet window — **nothing owned the deadline** (no wake source, and the only running watchdog timer had been killed six seconds earlier by a host location re-init that re-instantiates the plugin; the host does this ~hourly on the desktop app). The fix (spec §57): the watchdog now fires ONE unconditional **"Goal wait period ended"** wake at `waitUntil` (no idle/quiet gate — a fully-idle session is exactly the parked case it must rescue); the one-shot marker is persisted (a plugin reload neither double-fires nor loses the wake); the `goal_wait` call arms its own tick; and `start()` re-arms persisted pending deadlines after any reload (init re-arm — the removed 2026-10-17 restart reconciliation, re-added in reload form). The tool description and return text now promise the deadline wake honestly.

## [1.1.9] - 2026-10-24

### Fixed
- **Model-launched background shells were misclassified as FOREGROUND — their 5-minute check-ins never fired, and §52 threatened to "auto-background" shells already in the background** (129, 2026-10-24: a background maintenance script ran >5 min with no progress check-in; the decision log showed repeated `hold fg=1` lines). Root cause (upstream source + 129 transcript forensics): the shell store's `metadata.background` is **not a usable fg/bg marker** — the model tool path never writes it (fg or bg launches alike), only server-fired shells carry `background: true`, and Ctrl+B / `session.background` never touch the store entry. The blocking state is now derived the way the host UI does it: **a shell blocks the loop only while the session's own turn is alive (host active map `"running"`) and its entry is not an explicit `background: true`** (spec §56). Consequences: an idle session with a running shell is a background item again (check-ins resume — the 129 symptom); §52 rescues only turns that are actually blocked; §54's silence rules (boundary / liveness recheck / fire-time guard) key off the same blocking signal.

## [1.1.8] - 2026-10-24

### Fixed
- **Every user message re-wake-injected on a resumed goal** (129 sm70 incident, 2026-10-23: one blocked goal was auto-resumed AND immediately re-woken on every user message — 5 times within an hour; the extra wake queued behind the user's own message): the §15-9 user-message resume path no longer injects an immediate wake — the status flips blocked→active (stalls cleared, stale blocker dropped) and the user message's own turn is the stimulus; the loop resumes at the next boundary under ordinary arbitration (spec §55).

### Optimizations & Design
- **Resume eligibility pinned (spec §55)**: a user message auto-resumes ONLY an unfinished goal waiting on the user (`blocked`); terminal goals (`completed` / `cleared` / `budget_limited` / `stalled`) are never auto-resumed — previously true in code, now spec-pinned with a regression test. The resume decision-log line is now `decision:"resume"` (was `wake`) — the log invariant "a line = a message actually in the queue" no longer applied once no message is injected. The explicit `/goal resume` command path is unchanged (its result line is the kick).

## [1.1.7] - 2026-10-22

### 新增
- **前台 shell 超时自动转后台**（§52，2026-10-21 裁定）：goal 会话里**前台（阻塞式）** shell 运行超过 `foregroundShellBackgroundMs`（默认 30min，`0` = 关）→ 插件调宿主 `POST /api/session/:id/background`（TUI Ctrl+B 的服务端动作，2.1.1 活宿主 openapi.json + 源码双重实锤）——工作**保活转后台观察**（不杀），宿主自注入 synthetic 解除被阻塞的 turn。堵住"前台 shell 挂死 = turn 无边界 = 无 check-in = 循环永久失声"盲区（此前 §50 liveness 重查也被 in-flight 门 hold）。
- **转后台立即提醒**（§54，2026-10-22 裁定，129 sm70 截图驱动）：§52 转后台的**同一时刻**由插件注入一条 goalControl 提醒（不等宿主 synthetic + 5min 周期）——哪个 shell（id）、跑的什么（command 压平截断，`foregroundNoticeCommandChars` 默认 300，`0` = 不带）、跑多久、超的哪个阈值，请模型核对 shell 运行是否正常。每 shell 一条（去重），决策日志补 `watchdog / foreground shell auto-backgrounded` 行（此前该动作只有 console.warn，129 侧无从查证）。

### 修复
- **前台 shell 阻塞期间误发"background check-in"**（129 sm70 现场截图实锤：模型被前台阻塞 shell 挂住 >300s，却收到一条 "1 background item(s) in flight"——前台 shell 被误报成 background item，且该提醒只能排队、模型根本收不到）：根因链 = 前台阻塞 → 事件流静默 → §50 liveness recheck 误判"流死了" → 伪造边界（hold 路径清活跃位 + 武装 check-in）→ watchdog 判 idle 照发。现按用户裁定的分层策略修复（spec §54）：**后台 shell/子任务**维持 5min check-in 节奏；**前台 shell** 阻塞期间——边界 hold 不武装（reason `foreground shell blocked`）、liveness recheck 跳过该会话（静默是预期）、check-in 发时防御（到点仍有前台 shell 在跑 = 丢弃不投递）；§52 转后台后自然回到 5min 周期。决策日志 in-flight 信号补 `fg` 字段（前台 shell 计数）。
- **check-in roster 分类标注**（§54）：roster 条目带种类标签——`sh_x (bg, 12m34s)` / `ses_y (subtask)`，不再把一切在飞统称为 "background item"。

### 优化与设计
- **check-in 提醒附带在飞任务名单**（2026-10-21 裁定，129 sm70 现场驱动：模型被 check-in 唤醒后要再查一次 shell store 才知道谁在飞）：check-in 触发时新鲜查询一次，把在飞名单写进提醒——**不封顶、只要 ID + 运行时长、不要 command**（用户裁定；宿主 shell store 条目本就携带 `time.started`，`ShellEntry` 扩类型透传，子任务会话列 `ses_x (subtask)`）。查询失败回退纯计数文案（提醒本身绝不丢）；传统两参调用逐字不变（wake.test 既有断言零回归）。spec §51。
- **全部默认值 option 化**（2026-10-22 用户裁定）：`livenessMs`（§50 自愈静默窗，默认 5min）、`livenessCheckMs`（全局扫描周期，默认 30s）、`foregroundNoticeCommandChars`（默认 300）三个原本硬编码的常量全部升为插件注册 options——README 选项表补全（含每项用途/作用/边界值语义）。

### 验证
- stub 366/0 + typecheck；wake.test 名单形态钉死（含"不封顶/无 command/空名单=旧文案逐字不变"）+ §54 立即提醒文案（截断/压平/0=无 command）；watchdog §51 用例 + background-gate 后台用例显式 `background: true`；新增 `fg-block.test.ts` F1–F3（fg 边界 hold 不武装 / 发时防御丢弃 / liveness recheck 跳过 + 对照组）；shell-bg T5（超 cap → POST + 恰一条立即提醒 + 决策行）；options 三个新 option 解析（含 0 合法值）。
- **隔离真宿主 7/7 全 PASS**（`verify-checkin.ts`，宿主 2.1.1 + lab LLM，`checkInDelaySec` 15s + `sleep 90` 后台 shell）：check-in 注入消息**实带名单行 `sh_… (21s)`**（ID + 运行时长）、无 command 文本（裁定钉死，K4d）。
- **§52 前台 shell 自动转后台**：`test/shell-bg.test.ts` T1–T5（超 cap 恰好一次 POST + 去重 / background shell 不碰 / cap=0 关 / 未超 cap 不动 / §54 立即提醒）+ options 0=valid 解析；真宿主 `verify-shellbg.ts`（cap 注入 5s，模型前台跑 `sleep 120`）**9/9 ALL PASS**（回填见下行）。
- **§54 真宿主**（2026-10-22，宿主 2.1.2 + lab LLM）：`verify-shellbg.ts` **9/9 ALL PASS**（cap 5s：G4b 转后台**同一时刻**插件立即提醒落会话——shell id + command + "moved it to background automatically"；G4c 决策行 `watchdog: foreground shell auto-backgrounded (cap 5s)`；G5 进程保活；G6 循环恢复）+ 新 `verify-fgblock.ts` **8/8 ALL PASS**（`sleep 100` 前台阻塞 + `livenessMs` 注入 30s：F4 阻塞 75s **零 "Background check-in"**〔129 截图 bug 形态〕、F5 **零 "liveness recheck"**、F6 未超 cap 零转后台、F7 阻塞结束后边界节奏恢复）。

## [1.1.6] - 2026-10-21

### 修复
- **`/goal` 查询命令用户不可见**（2026-10-21 裁定，129 + 本机双实锤）：2.1.1 宿主不把 `resume:false` 记录行晋升到 `session_message`（UI 数据源）——§49 之后所有 `/goal` 查询命令变成盲操作。现：**所有用户命令结果行恢复 kick**（模型回一行可见结果，含拒绝/失败/未知子命令路径）；5 条机器终态/暂停通知保持纯记录（§48 不变，不白踢）；kick turn 按 control 语义不链式再唤醒（spec §49-rev）。
- **事件订阅断流永久失聪**（129 sm70 incident：turn 正常结束后插件事件订阅静默断，循环冻 4.5h，7 次热重载无效）：事件循环对"流结束/异常"从不重订阅（done 路径零日志）→ 现大声日志 + 自动重订阅（≥1s 回退）；新增独立全局 liveness 探测（5min 静默 + started turn 无 terminal → 强制重订阅 + 边界重仲裁，in-flight 门防误唤醒）。2.1.1 宿主断流死因未钉（零 ERROR），插件侧自愈不依赖宿主版本（spec §50）。
- **kick 结果行误归类引发误唤醒**（2026-10-21 真宿主首跑实锤：运行中会话的命令被宿主 STEER 吸收，被 steer 的 kick 行以 `type:"user"` 投递，旧判据要求 `itemType==="synthetic"` → `lastInbox` 误翻 user → kick turn 边界白踢一轮、烧掉预算）：`isControl` 判据改为只看 `metadata.goalControl`（宿主投递的 item 类型不可信，metadata 是权威标记）；验证脚本按 2.1.1 busy-steer 契约加 active map idle 门（spec §50 真宿主发现）。

### 优化与设计
- **liveness 探测故意不挂 per-goal watchdog**（spec §50）：watchdog 在 turn 开始时止表，而致命形态正是"started 已见、terminal 丢失"→ 无人重武装；独立全局定时器（30s 扫描）覆盖该形态。误报成本 = 一次 in-flight 门 hold 边界，漏报成本 = 此前的 4.5h 静默。
- **harness 流断模拟 + kick auto-turn 有界 ack**（test 基建）：`killStream()`/`streamSubscribes()` 断流开关与订阅计数；kick turn 的 await ack 加 500ms 界——事件循环被长 await 阻塞（judge pending）时不再死锁 command handler，正常路径仍是微任务级确定性不变。
- **自愈验证探针**（`OPENCODE_GOAL_KILL_STREAM=1`，仅验证用）：插件在首个 turn 开始处自杀一次事件订阅——129 死法的受控复现开关，随包发布（env 未设时零行为），`scripts/verify-heal.ts` 用它做真宿主自愈断言。

### 验证
- stub 350/0 + typecheck；新增 `stream-heal.test.ts` T1–T4（重订阅 / sm70 形态丢 terminal 恢复 / parked 不误唤醒 / view kick 不链式再唤醒）+ `goal-loop` 1g（2.1.1 kick 行 user 型投递仍归 control）。
- **隔离真宿主双批全 PASS**（宿主 2.1.1 + lab LLM，2026-10-21）：`verify-wake.ts` 12/12（set/view 结果行真踢 turn——view = §49-rev 新断言；`budget_limited` 通知零 kick——§48 不回归；resume grace 消耗留痕；grace 一次性，C1 恰好 4 turns、E 恰好 6 turns，无模型干预）+ `verify-heal.ts` 5/5（**§50 自愈真机证据**：探针受控断流 → done 路径重订阅日志实锤 → 新订阅收事件 + 边界注入 wake（决策日志行）→ 循环自治到 `budget_limited`）。stub 350/0 + typecheck。首跑失败暴露 2.1.1 busy-steer 契约（运行中会话的命令被吸收进运行 turn）+ kick 行 user 型投递误归类——插件 isControl 改 metadata 判据、脚本加 active map idle 门，复跑全 PASS（spec §50）。

## [1.1.5] - 2026-10-20

### 修复
- **goal 写失败误报成功**（129 block 状态丢失 incident 取证收口）：`saveGoal` 在 `storageSet` 抛异常时原为 catch→warn→返回成功——`goal_block` 等终态转换若没落盘，仍向模型报"blocked"成功（129 现场：block 确认成功 7 分钟后 `goal_next_step` 读回 active/turn 7）。现写失败返回 false，命令/工具面终态转换统一回 "changed underneath"（不假成功）；loop 内写入保持 best-effort 容错（spec §46）。

### 优化与设计
- **watchdog 唤醒补决策日志**（129 取证："有消息、无日志"——用户所见排队唤醒被删后无任何痕迹可解释）：watchdog 路径（check-in / provider-pause 重试）是唯一不写决策行的注入路径。现每条 watchdog 消息入队后写一行 `decision:"watchdog"`（reason 区分来源），插件注入的每条消息必留痕（spec §46）。
- **主 wake 文案去"安全"强调**（2026-10-20 裁定，129 现场 block 事件驱动）：`take the next safe step` → `take the next step`——"safe" 成了模型的否决判据（不确定 → block 成体面出口）；安全网在记录（goal_next_step）与流程（stall 阶梯 / 用户覆盖）里，不在文案里。`genuinely blocked` 保留；check-in / provider-pause 文案不动（spec §45）。
- **/goal resume 去掉显式 re-wake**（129 双消息，2026-10-20 裁定）：一次 `/goal resume` 原产生两条**都能触发执行**的消息——显式 re-wake（`injectWake`，delivery:queue 排队）+ 命令结果行（`handleCommand` 自动记录的 goalControl synthetic；宿主 `sessions.synthetic` 默认 steer + `execution.wake` 直接踢 turn）。结果行先踢、re-wake 挂队列多触发一轮冗余 turn（用户所见"2 条唤醒消息"，需手动删）。现 resume 只改状态 + 结果行：命令面由结果行 kick、工具面模型本就 mid-turn，边界在下一轮按 active goal 正常唤醒；stale blocker 清除 / stalls 清零不变（spec §47）。
- **终态/暂停通知不再误踢 turn**（129 取证：宿主对每条 synthetic 都 auto-wake，goal 走到终态后模型被白叫一轮读"goal X …"；provider-pause 那条还把注定失败的请求又打一次）：5 条终态/暂停通知（completed / blocked / stalled / budget_limited / provider-pause）改传 `resume:false`——记录照旧落 transcript、宿主不再 auto-wake；命令结果行（set/resume）保留 kick（§47 去 re-wake 后正靠它）。根因是 harness 把 synthetic 建模成 no-op、真宿主偏差只在 129 暴露（spec §48）。
- **命令结果行 kick 完全收口**（spec §48→§49，2026-10-20 裁定）：上一版只压了 5 条终态通知，`/goal` 其余子命令（view/pause/block/clear/complete/history/task）的结果行仍在白踢 model turn。现 kick 只保留给**成功的** `/goal set` / `/goal resume`（§47 正靠结果行触发）；被拒 set（goal 未终结）与失败 resume 的结果行一并改为纯记录（`resume:false`）。
- **从 `budget_limited` resume 不再立刻打回**（post-resume budget grace，spec §49）：`budget_limited` 状态下 `/goal resume`（及 `goal_resume`）成功后，resume 结果行自己的 kick turn 会在下一边界因 cap 仍耗尽**立刻 re-limit**，使 resume 成为无效操作（真宿主行为，stub 曾藏着）。现 resume 从 `budget_limited` 恢复时授予**一次性预算豁免**：首个边界预算重检消耗豁免（决策日志留痕 `decision:"hold"`），之后边界如仍触 cap 照旧 `budget_limited`——语义 = resume 买一次完整工作的机会。
- **用户消息 resume 补决策日志**（spec §47 缺口收口，§49）：用户 inbox 消息复活 blocked goal（§15-9）的 re-wake 原不写决策行（"有消息、无日志"）。现写一行 `decision:"wake"`（reason 标注 §15-9 来源）——插件注入的每条消息必留痕（watchdog 一条 §46 已覆盖，此为最后一条）。

### 验证
- **隔离真宿主全 PASS**（`scripts/verify-wake.ts` + lab LLM，2026-10-20）：§48/§49 真机行为五断言——set 结果行真踢 turn、view 结果行零 kick、`budget_limited` 通知零 kick、resume 自 `budget_limited` 保持 active（grace 消耗，decisions 日志 `decision:"hold"` 实得）、grace 一次性 re-limit（全程恰好 5 turns）。stub 345/0 + typecheck。

## [1.1.4] - 2026-10-20

### 新增
- `goal_next_step` 工具：模型自述下一步计划，随 goal 记录持久化，下次唤醒以 Resume 行回放。
- **Goal 复活**：无活跃 goal 且会话最近 goal 已终结（`completed`/`paused`/`blocked`/`stalled`）时调用 `goal_next_step` → 该 goal 复活为新相位（`used`/`stalls`/`waitUntil` 清零、cap 沿用、旧 `evidence` 归档 `evidenceHistory`、记录的 step = 新相位 turn 0、唤醒文案带复活上下文行）；`cleared`/`budget_limited` 拒绝复活（用户显式清除 / 显式 cap 优先）。
- 全部 12 个 `goal_*` 工具原生注册（`codemode:false`）+ `goal` namespace 单组提交：模型直接调用、会话记录是干净的工具芯片（旧行为 = Code Mode 代码块形态）。

### 修复
- **1.1.3 僵尸锁死**（129 现场：16 个子任务卡死门禁、循环停摆）：在飞门禁按会话 `time.idle/updated` 字段推断子任务活性，死会话的 time 字段停留 → 永久计为在飞。改用宿主 active map（`GET /api/session/active`，`"running"` = 在飞，与宿主 UI 同源信号；僵尸无条目 = idle）。
- **Wake 排队**（129 现场：[GOAL] wake 排在用户消息后面）：用户消息排队未投递时边界仍注入 wake。新增 queued-input 门禁：有未投递 inbox 项绝不同步唤醒（只武装进展检查）；决策日志新增独立 `queued` 字段。
- **复活带出 stale `waitUntil`**：旧相位的 `goal_wait` 静默窗口随复活带入新相位（最长 60 分钟静默，违背"loop resumes"）→ 复活时清除。
- **Watchdog-wake 例外绕过 queued 门禁**（终审 review finding C1）：最后 inbox 项是我们的 check-in wake 时，边界直接走正常仲裁、忽略 `queued`——wake 仍可能排在用户消息后面（129 incident 变体；provider-pause 重试 wake 同形状）。修正：例外让位于 `queued > 0`（hold + 武装进展检查；check-in 仍是 parked 态逃生阀，spec §42）。
- **next_step 的 CAS 丢写误报成功**（review finding I1）：复活 / 记录分支忽略 `saveGoal` 的 compare-and-set 结果，并发写导致丢写时仍回复"the loop resumes"。两分支现在与同族终态转换一致：丢写 → 返回 "changed underneath"。

### 优化与设计
- **默认预算不限**（2026-10-20 裁定）：goal 默认无 turn / token 上限；`budget_limited` 只在显式 cap 时发生；`defaultCapTurns` 保留为显式 opt-in（非法值 = 不限，无回退）。
- **门禁 = 每边界纯查询**：active map ∧ 会话列表 `parentID` 链（子任务归属）∧ shell store ∧ inbox（queued）——无事件缓存、无 shell-exit 快路径；看门狗 = 每 active goal 一个定时器 tick（不再事件驱动）。
- **唤醒文案**（2026-10-20 裁定）：去 goal ID、去 cap 提醒、单一唤醒格式。
- **文档**：README 新增"测试与验证"节（宿主合同 opencode 2.0.32 + 三层验证条件）、工具表 12 行、options 表默认不限、"已知限制"按 2.0.29 / 2.0.32 分版本更新。

### 验证
- stub 337 用例 + typecheck（stub 层）；真宿主 = 本机隔离 opencode 2.0.32 `serve`（`verify-active` 全 PASS，含复活 5m 相位：默认 `cap:{}` → stall → 用户驱动 next_step 复活 → 复活行唤醒）；生产宿主 = 播种构建 + 日志 / 决策日志观察。
