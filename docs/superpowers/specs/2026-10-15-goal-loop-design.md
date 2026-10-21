# 设计文档：opencode-goal —— OpenCode v2 目标循环插件

- 日期：2026-10-15
- 目标运行时：opencode v2.0.29（桌面端内置 opencode-cli.exe 2.0.29），npm 包名待定
- 语言/运行时：TypeScript + Bun（与宿主一致），Unlicense 风格公共域（待定）
- 状态：初稿，待评审

## 1. 背景与动机

三个已确认的痛点（用户实际使用中复现）：

1. **静默停滞（主痛点）**：无人值守跑长任务时，模型某轮只输出文本、没有任何工具调用，回合就此结束，会话停在原地，必须人工输入消息才能继续。
2. **压缩失焦**：长会话触发上下文压缩后，"目标还在，但进行到哪、做过什么决定"被摘要掉或模糊掉，模型等于失忆重开，可能重复劳动或跑偏。
3. **回调丢失**：会话结束、模型正等待后台脚本结束来唤醒继续；脚本运行失败，但 OpenCode 没有送达这个失败通知，会话永久卡住。即：**任何"等外部信号"的机制，信号本身都可能丢**。
4. **宿主重启**：极端情况下 opencode service 进程被饿死重启，重启时相关 shell 执行被自动取消——插件内存（看门狗、pending 状态）全丢，被等脚本的回调也永远不来了。即：**等待方自己都可能死掉并重生**。

先例：`wukrit/opencode2-goals`（v1.0.4，2.0.15/2.0.16 时代构建）。它验证了"goal 循环"路线可行（持久状态、续接注入、证据门控、预算上限），但有明确缺陷：

- 默认 `stallLimit=1`：一次无工具调用就判死 goal，把"停滞"变成了默认结局；
- 唤醒消息是无状态的通用文本，压缩后无法帮模型找回进度；
- 完全不知道后台脚本/ shell 是否还在运行（唤醒与回调互相踩踏的风险）；
- 对压缩（compaction）无任何干预能力，方向丢失只能靠每轮注入目标文本兜底。

本项目从零设计一版，把它当先例而不是底座。

## 2. 意图

让 OpenCode 会话可以被**可靠地无人值守**跑向一个明确目标：方向不随压缩丢失；回合静默结束不死锁；完成必须经得起检查；烧钱有界；卡死时有交代（报告），而不是无声或假完成。

## 3. 目标 / 非目标 / 反目标

**目标**
1. 回合静默结束不再死锁：边界上有机械仲裁器决定是否唤醒、何时停。
2. 状态外化：目标 + 待办清单持久化，压缩砸不掉，每轮重新注入。
3. 完成判定可靠：模型的工具动作是唯一主裁决通道，goal_complete 过证据门控。
4. 卡死可诊断：连续唤醒失败后由旁路 LLM 裁判解读停滞原因，给出是否继续唤醒的结构化标志；到顶判死并出报告。
5. 预算有界：turns 默认上限 10；**tokens 默认仅统计不设限**（2026-10-16 裁决：统计与限制分离，token 上限 opt-in——`--tokens` 或 options `defaultCapTokens`）；超 cap 是独立的 `budget_limited` 终态（不是完成）。

**非目标（v1 不做）**
- TUI 侧边栏进度 widget（v2，接口先留 RPC）。
- 语义级证据验证（跑真实测试的评估器）。
- 自动换模型 / 换子代理升级（v2，API 已确认存在，见 §16）。

**反目标（明确认为失败的样子）**
- 模型只说一句话（不调工具）就能终结 goal——不允许。
- 一次空话就判死 goal——不允许。
- 无限空转烧 token——不允许。
- 主循环靠解析模型自然语言输出做决策——不允许（唯一例外是失败后的旁路裁判，见 §8）。

## 4. 运行时约束（2.0.29 已核实）

以下全部来自 `@opencode/plugin@2.0.29` 与 `@opencode/client@2.0.29` 的类型定义（已安装到临时目录逐条核对），不是记忆：

**插件上下文 `ctx`**（`dist/promise/plugin.d.ts` 的 `Context`）：`command`、`tool`、`session`、`event`、`storage`、`permission`、`model`、`generate`、`shell`、`rpc` 等域。

- **唤醒**：`ctx.session.prompt({ sessionID, ..., delivery: "queue" | "steer", resume, metadata })`（`SessionPromptInput`，metadata 可标记 `goalWake` 归属）。
- **控制通知**：`ctx.session.synthetic(...)`（不触发代理循环的会话消息），统一带 `metadata: { goalControl: true }` 标记——由控制通知触发的执行到终态边界时仲裁器只记录、绝不注入新唤醒（参考项目模式，防自触发双唤醒）。
- **等待**：`ctx.session.wait({ sessionID })` → 会话处理完毕时 resolve。
- **历史**：`ctx.session.context({ sessionID })` → 消息数组。
- **旁路模型调用**（本次升级的关键）：
  - `ctx.session.generate({ sessionID, prompt }) → { text }`：会话域内的旁路生成，不往会话 transcript 里塞消息（`SessionRequestKind = "generate"`）。
  - `ctx.generate.text({ prompt, model? }) → { text }`：全局生成，可指定 model。
  - 两者都只返回文本 → **结构化输出 = 提示词约定 JSON + 插件侧解析，解析失败按失败处理**。
- **边界事件**（`V2Event` 联合类型，均已确认存在）：
  - `session.execution.started`（判定 active/idle、清除唤醒 pending）/ `session.execution.{succeeded, failed, interrupted}`：终态回合边界（含 `data.sessionID`、`durable.seq`）；
  - `session.idle`：**2.0.29 的事件集里存在**（旧插件时代不投递）；
  - `session.tool.called`：模型调用了工具——stall 检测的实时信号，**不需要**事后扫描消息历史；
  - `shell.created` / `shell.exited`（`data.info: ShellInfo`）：后台 shell 生命周期——"脚本回调在飞"的机械判据；另有 `session.shell.{started,ended}` 一族，两者的精确语义差需在 live smoke 中确认（见 §13）；
  - `session.usage.updated`：token 预算（累计值）；
  - `session.compaction.{started,ended,failed}`：压缩生命周期；
  - `session.inbox.{enqueued,delivered}`：唤醒消息投递状态。
- **hook 面**：
  - `ctx.session.hook("context")`：每次模型调用前注入 system 内容（目标每轮重注入）；
  - `ctx.session.hook("compaction")`：可检查/改写/直接提供 `result: { summary }` **替换**压缩摘要——压缩失焦的机制级解法；
  - `ctx.tool.transform(editor.add/update/remove)`、`ctx.command.transform`、`ctx.permission.hook("evaluate")`（`effect: allow|ask|deny`、`resources`，与旧插件同面）。
- **持久化**：`ctx.storage.{get,set,remove,scan}`，key 前缀扫描可用。
- **shell 主动查询**：插件上下文的 `ctx.shell` 只有 `create.before` hook（可改写 `command/timeout`），**没有**状态查询；但 client 侧存在完整 `shell.{list,create,get,output,remove}` RPC，插件可经 `ctx.rpc.call` 主动查 shell 记录与输出——看门狗的事实来源（§7.1）。具体 RPC 方法名需在 live smoke 中确认。

## 5. 状态模型

外化状态 = **总体目标 + 待办清单**（用户定的核心结构），持久化在 `ctx.storage`：

```
goal/<sessionID>            → GoalRecord（活动状态机，单条）
goal/<sessionID>/archived/  → 终态 / 被顶替 goal 的追加归档（历史可查）
```

```ts
type GoalRecord = {
  version: 1
  id: string                 // g_xxx，稳定短 id
  sessionID: string
  objective: string          // 总体目标（完成条件）
  status: "active" | "paused" | "completed" | "blocked" |
           "budget_limited" | "stalled" | "cleared"
  cap:   { turns?: number; tokens?: number }
  used:  { turns: number; tokens: number }
  stalls: number             // 连续"无动作唤醒"计数
  continuations: number      // 注入的唤醒总数
  tasks: GoalTask[]          // 待办：{ id, title, status: todo|doing|done, updatedAt }
  waitingShells?: Array<{ id: string; timeoutMs?: number; since: number }>   // 等待回调的 shell——重启对账的事实锚点（timeoutMs = create.before 捕获的宿主超时，缺省 = 无；since = 本停滞段起点）
  waitUntil?: number         // goal_wait 声明的静默截止（期间 check-in 不注入）
  lastHandledEventID?: string
  judgeUsed?: boolean        // 旁路裁判是否已用过（§8）
  evidence?: string
  blocker?: string
  stallReport?: string       // 判死时生成的报告
}
```

- 状态机是纯函数模块（`state.ts`），可脱离宿主单测；
- 终态归档：`completed/blocked/budget_limited/stalled/cleared` 落归档，被新 goal 顶替的非终态记录也归档（历史诚实）；
- 待办**无上限**（2026-10-18 用户裁定撤销原 50 条上限，见 §21）。

## 6. 核心循环：边界仲裁器

订阅 `ctx.event.subscribe()`，在以下事件上做决策（全部机械判断，不调 LLM）：

```
终态边界事件 (execution.succeeded | execution.failed | 有效 session.idle)
  │  去重：eventID 已处理 / lastHandledEventID / 唤醒 pending 未落地 → 忽略
  │  归属：只处理本插件实例 project 拥有的 session（多 location 安全，沿用先例）
  ▼
① 有 active goal？ 无 → 忽略
② 有在跑 shell（created 未 exited）？ 有 → 武装看门狗（§7.1），本边界不注入唤醒；
   注：等待不是无界的——宿主回调是快路径，看门狗是保证，二者至少有一条通
③ 本轮是 interrupt？ → 按 reason：`user`（人工喊停）→ 只记 eventID，不唤醒；`inactivity`（模型没动导致回合结束）→ 当普通边界唤醒——这是静默停滞的机械形态，主痛点绝不能在这里漏；`shutdown` → 只记录
④ 预算已超？ → budget_limited 终态 + synthetic 通知
⑤ 本轮归属判定（记录每会话最后入队的 inbox 项做归属，参考项目已验证模式）：
    由本插件唤醒触发（metadata goalWake + goalID 匹配）且无工具调用 → stalls += 1
    本轮有工具调用（任意归属）→ stalls 归零
    用户消息触发的轮次无工具调用 → stalls 归零（人在场，不是停滞）
    由本插件控制通知（goalControl 标记）触发的执行 → 只记录，永不注入唤醒
         stalls < N(=3) → 注入唤醒
        stalls >= N    → 触发旁路裁判（§8）
```

要点：

- **唤醒注入发生在每个终态边界**（不管本轮有无动作）——这是循环的本体：模型停下 = 回合结束，必须有人把下一回合拉起来。唤醒消息即"继续 + 自我裁决"合一。
- 去重三层（eventID 集合带容量上限、持久化 lastHandledEventID、pending 唤醒集合）沿用先例验证过的模式。
- `session.execution.interrupted` 不无条件唤醒：`user`/`shutdown` 不唤醒，`inactivity` 当普通边界唤醒（见 ③）。

## 7. 唤醒协议

**一种普通唤醒消息，带状态**（用户定：不做循环内审计式升级唤醒；§7.1 的结果/check-in/对账唤醒是各自固定文案的另一类注入，同样不是升级）。模板（措辞可在实现时打磨）：

```
[GOAL <id> | 第 used/cap 轮]
目标: <objective>
进度:
  1. [done] <title>
  2. [doing] <title>
  3. [todo] <title>
请核对以上进度，然后必须用工具调用结束本轮：
- 完成条件已满足 → goal_complete(evidence)，evidence 须是具体可核对的锚点（文件/测试/输出）；
- 确实无法推进 → goal_block(reason)，给出具体原因；
- 否则 → 用下一个具体工具推进：无待办先 goal_add_task(title) 规划，推进中用 goal_update_task(ref, status) 同步更新。
```

- `delivery: "queue"`、`resume: true`、`metadata: { goalWake: true, goalID, goalTurn }`（归属可持久化、可去重）；
- 若上轮唤醒的 instruction 来自裁判（§8），追加一段 `裁判提示: <instruction>`；
- 唤醒 pending 期间到达的边界事件不重复注入。

**双通道状态注入**（防压缩，§10）：
- `session.hook("context")`：每次模型调用前注入 `[GOAL]` 块（目标 + 当前预算 + 规则提醒，含指令式待办维护：goal_add_task 规划 / goal_update_task 更新——A/B 2026-10-16 后新增）；
- `session.hook("compaction")`：压缩发生时把完整状态块（目标 + 待办 + 最近证据 + 已用预算）**并入/重写**压缩摘要——压缩后第一轮的上下文直接从真实状态出发，而不是从有损摘要。

### 7.1 看门狗：脚本等待保证（治痛点 3：回调丢失）

> 注：本节描述的主动检查机制（shell 事实探测、双信号 check-in、重启对账）已于 2026-10-17 裁决全部移除，由 §7.2 后台等待门禁取代；本节保留为设计史。

立场（用户确认）：**脚本的命运不可控、也不预测**——被外部进程杀掉、卡住不动、缓慢输出、**"活着地失败"**（依赖进程故障导致永远无法结束但日志持续增长）都可能发生。关键认知：**输出增长只是"活着"的证据，不是"在推进"的证据**——因此等待不是无界等待，而是带检票点的等待。check-in 由三种信号触发，全部收敛到同一个"状态核查唤醒"动作（理由文案不同）：

| 信号 | 时机 | 说明 |
|---|---|---|
| 宿主超时（有设置） | 宿主在 T 自收尸并照发 `shell.exited`（status `timeout`）；插件只在 T+一个 tick 未收到事件时介入（margin = `watchdogTickMs`） | 事件丢失兜底 |
| 零增长 | `shellStallMs`（5min） | 疑似卡死 |
| 有增长但久等 | `waitCheckInMs`（5min） | "活着地失败"检票点 |

**只在停滞时做**：check-in 是唤醒机制，只对 **idle 会话**（模型在等回调、没有持续动作）注入。会话 active（turn 进行中 / 模型持续有动作）时看门狗照跑事实判定，但**不注入 check-in 唤醒**——下一回合边界自然带走，重复注入只会添乱。**倒计时属于当前停滞段，带显式取消**，任一条件即止表：

- ① 任一被等 shell 结束（`shell.exited` 事件到达，或 probe 查到已退出）→ 结果唤醒复活会话（快路径），提醒不再需要；
- ② 会话恢复活跃（新消息 / 模型动作，不再 idle）；
- ③ goal 进入终态（complete/clear/blocked）→ 看门狗整体解除。

取消后若再次停滞，从新停滞点起全新倒计时。check-in 唤醒文案："你等待的脚本 <id> 已运行 X 分钟，最新输出尾部如下——判断它是否在实质推进：是（`goal_wait(N)` 显式声明继续等 / 用工具核对并给出依据）/ 否（杀掉换路或 goal_block）。" check-in 后的三态：

- **`goal_wait(N)`**（新工具，N≤60 分钟）：模型确认过、显式选择继续等 → 记录 `waitUntil`，期间 check-in 静默、不消耗 stall 预算（审计痕迹 = 工具调用本身）；
- **其他工具动作**（查日志/杀进程/换路）：实质推进；此后**会话再次 idle 时起一段全新的 5min 倒计时**（每段停滞至多一次 check-in，不循环、不后台自转）；
- **只说话无动作** → 进 §8 stall 阶梯。

"继续等"必须是一等动作（`goal_wait`）或产生实质工具调用——纯文本"看着正常"不是有效回应。任何等待有界。

- **快路径**：`shell.exited` 事件到达 → 正常唤醒（宿主通知没丢的情况）。**源码核实**：超时终结走与普通退出同一条 `finish` 路径，status 置 `"timeout"` 且照发 `shell.exited` 事件——即"设置了超时的脚本"在宿主存活时必然产生事件，看门狗真正兜的是"没设超时"与"宿主崩溃事件丢失"两种情况。
- **超时感知**：`ShellInfo` 不含 timeout 字段（且运行中可被动态修改，读回会失真），但 `shell.hook("create.before")` 在 spawn 前交出 `timeout`（0=无超时，payload 可变）。插件在 goal 激活的会话记录 `(command, cwd) → timeout`，用随后的 `shell.created` 事件按 command+cwd 关联 shell id（关联失败退回保守阈值，方向安全）。每个 shell 的"零增长→状态核查"阈值因此是：**有超时 T → `max(shellStallMs, T + watchdogTickMs)`（宿主会在 T 自收，超时前静默不是卡死证据，我们最多迟一个 tick 兜底）；无超时 → `shellStallMs` 基准**。
- **看门狗**（边界发现有在跑 shell 时武装，插件进程内计时，goal 重载后可从状态重建）：到点经 `ctx.rpc.call` 主动查 shell 记录与输出：
  1. **已退出**（成功/失败/超时/被杀，不管事件丢没丢）→ 插件合成唤醒，携带退出码（status `timeout`/`killed` 单独文案）与输出尾部："你等待的脚本已退出——决定下一步，用工具调用结束本轮。"
  2. **活着且未触发 check-in 条件**（有增长且未到 `waitCheckInMs`）→ 继续等（零成本，不消耗回合）。
  3. **触发 check-in**（零增长超 `shellStallMs` / 有增长但等待超 `waitCheckInMs`，且 `waitUntil` 未生效）→ **会话 idle 时**注入"状态核查"唤醒（文案含具体理由与输出尾部）；active 会话不注入（下一边界自然带走）。此唤醒若模型仅以纯文本回应，按 §8 stall 阶梯计数；`goal_wait(N)` 视为有效动作（静默至 `waitUntil`）。
- **timeout 包装**（`create.before` 钩子改写命令，如 `<cmd>; echo "goal-shell-exit:$?"` 或套 timeout）：降级为**可 option 开关，默认关闭**——脚本形态太多，插件不替用户强制管超时。
- **不变量**：任何"等外部信号"的状态，最多"迟到"一个看门狗周期，不会"失踪"。

**重启对账（治痛点 4）**：插件 `setup()` 时（宿主重启 / location 重载），对每个 active goal 执行对账——不信任任何内存，全部从事实重建。**宿主的原生恢复逻辑已从 2.0.29 源码核实**（`packages/core/src/session/execution/restart.ts`，启动清扫 `resumeSuspendedSessions`）：

1. 先结清 pending 后台作业：崩溃时还在跑的 shell 标记 cancelled，向拥有会话投递合成通知"Command cancelled because the server restarted"（已跑完的投递真实结果）——**但投递带 `resume: false`，故意不唤醒 idle 会话**（防长 shell 的空通知反复吵醒会话）；
2. 再续跑"挂起会话"（持有未释放执行声明的 top-level 会话，即 turn 进行中）：注入合成消息 *"The server restarted while you were working. Continue from where you left off…"*（metadata `notice: "restart"`）并重跑该 turn；每 turn 持久化预算 10 次（`resume_attempts`），超预算不再恢复、以 `Execution.Failed` 终结。

**因此宿主快路径的精确边界是"turn 进行中（含阻塞等 shell）→ 自愈；真 idle（turn 已结束等回调）→ 只收通知、不唤醒"**。无人值守 goal 在"等脚本"时最常见的恰是后者——插件对账就是它的保证，且不得与宿主行为叠加成双重唤醒：

1. 从持久化的 `waitingShells` 知道它原本在等谁（武装看门狗时写入 storage，重启不丢）；
2. **先辨宿主是否已接手**：该会话此刻是否 active（宿主 sweep 已在续跑）/ 上下文中是否出现 `notice: "restart"` 合成消息 → 是则本轮不注入新唤醒，只重新武装看门狗（看门狗负责"宿主也没管"的死角）；同时经 `session.inbox.list` 检查有无本插件的 pending 唤醒，若有且会话 idle → `session.inbox.cancel` 收掉再注入新唤醒（防旧唤醒日后被投递造成双份）；
3. 若会话 idle 且 `waitingShells` 对应脚本已丢失/取消（宿主已投递 cancelled 通知）→ 注入合成唤醒："宿主已重启，你等待的脚本 <id> 已随重启丢失/取消（见会话中的取消通知）——决定下一步（重跑/改路/放弃），用工具调用结束本轮。"
4. 宿主续跑耗尽预算产生的 `session.execution.failed` 走正常边界处理（当作一次普通终态边界，带失败上下文唤醒）；
5. 重新武装所有看门狗；持久化的 `lastHandledEventID` + inbox 关联 + `notice: "restart"` 识别，保证宿主 sweep、旧 pending 唤醒、插件合成唤醒三者不产生双重续接。
6. **原则**：宿主的自动恢复是快路径（免费，管"turn 进行中"），插件的对账是保证（管"真 idle"）。两者边界由"会话是否 active / 宿主 restart 通知是否已出现"机械判定。

### 7.2 后台等待门禁（2026-10-17 裁决，取代 §7.1 的主动检查机制）

**裁决原文**（用户三条消息 + 两条补充，2026-10-17）：

1. "主任务结束立马唤醒的前提是，没有任何 shell 或者子任务在运行。一旦有任何后台任务在运行，就不能立即唤醒，因为会话本来就是在等待。这种情况只做一件事情，就是开始计时5分钟。"
2. "如果5分钟内，会话还没有活动，只是触发一下进展检查而已，如果在这期间有任何活动，都立即停止计时并等待下一个idle触发。"
3. "这个等待时间，默认值5分钟，可以作为插件的配置参数来修改。以秒为单位。"
4. 补充："拿不到子任务或者shell名称不重要，我们只需要全程跟踪，当前有无正在执行的 shell 或子任务数量 > 0。"
5. 补充："插件也不用主动去替会话检查任务是否死掉了——只是在会话 idle 了一定时间后提醒会话自己检查。"

**设计**：

- **门禁武装**：终态边界（`execution.succeeded/failed/idle`）到达时，若在飞后台工作 = 本 goal 的 `waitingShells.length` + 同 project 内其它在飞会话数（子任务会话，纯事件跟踪、goal 无关、不认名称/父子关系）之和 > 0 → **不立即唤醒**。边界的全部动作：武装一次性进展检查 `checkinDue = { due: now + checkInDelaySec×1000, inFlight }`（option `checkInDelaySec`，秒，默认 300）。
- **时钟只在静默期走动**：任何会话活动（`started` / `tool.called` / `usage.updated` / `inbox.enqueued` / `shell.started` / `shell.ended`）取消计时；下一个在飞边界重新武装（全新倒计时）。
- **触发**：看门狗 tick（周期 `watchdogTickMs`）见 deadline 到 + 会话 idle + 非 `goal_wait` 静默窗 → 一次性注入进展检查文案（英文 byte-pinned）："Background check-in: N background item(s) in flight, no session activity for Xs. Check progress: what finished, what is next — advance the goal." one-shot：fire 即删 deadline；到点但会话 active 或处于静默窗 → 不消费，下个合格 tick 再试（事件丢失的 belt）。
- **两个例外保持正常仲裁**（§7.1 语义不变）：(a) 最后一条 inbox 是本插件看门狗唤醒 → 模型对进展检查的回复按 §8 stall 阶梯正常计数；(b) `goal_wait` 的 `waitUntil` 窗**只静默 check-in**（不武装、不触发，待存者出窗后触发）；边界唤醒、shell 退出唤醒与 stall 计数照常（窗内纯文本回应按 §7.2 计 stall——窗不是 stall 豁免，2026-10-18 裁定窄口径，见附录 §38）。
- **shell 状态机纯事件驱动**：`session.shell.started` → `waitingShells` +1；`session.shell.ended` → −1，最后一个结束时投递结果唤醒（status 文案 + 输出尾部）。`waitingShells` 成员关系即 once-only 守卫。
- **删除清单**（主动检查机制全部出码）：shell 事实探测（`shell.list` RPC + 防御解析 + fail-safe）、双信号 check-in（零增长 / 有增长久等）、tail 状态、重启对账、`exitNotified` 竞态守卫、options `shellStallMs`/`waitCheckInMs`；`timeoutWrap` 的 wrap 值改为 `checkInDelaySec × 1000`。
- **失败方向**（事件丢失不死锁）：子任务终态事件丢失 → 计数永远偏高 → 退化为进展检查节奏，永不"永不唤醒"；shell 终态事件丢失 → 僵尸 `waitingShells` 条目同样退化。任何方向都不产生假唤醒。
- **重启**：不做对账（已删）。僵尸 `waitingShells` 保留为持久事实、退化为进展检查节奏；宿主自身的重启清扫（§7.1 所述 `resumeSuspendedSessions`）恢复会话，下一个边界重新武装门禁。

## 8. Stall 阶梯与旁路裁判

**阶梯**（N=3 是我定的默认值，可经插件 option 调整）：

1. 无动作唤醒 ×3（普通唤醒，内容相同）；
2. 第 3 次失败 → **旁路裁判**（本节，用户定的升级）；
3. 裁判说继续 → 重置计数，再给一轮普通唤醒；再 3 次失败且裁判已用过 → **stalled 判死 + 报告**。
   裁判说别的 → 直接走对应终态。

**裁判**：

- **通道**：`ctx.session.generate({ sessionID, prompt })`（旁路，不污染会话 transcript）。
- **输入**（提示词构造，需斟酌——用户明确点名）：
  - 目标 + 待办清单（外化状态，压缩免疫）；
  - 最近 3 次"无动作响应"的**原文**（assistant 文本）；
  - 已用预算；
  - 任务指令：解读这些响应到底是什么意思，输出严格 JSON。
- **输出契约**（插件侧解析，fail-closed）：

```json
{
  "verdict": "continue" | "complete" | "needs_human" | "give_up",
  "reason": "1-2 句：这些响应为什么是这个意思",
  "evidence": "仅 complete：具体锚点",
  "instruction": "仅 continue：下一步的具体指令，将带入下一次唤醒"
}
```

- **处置**：
  - JSON 解析失败 / verdict 不合法 → 按 `give_up` 处理（无依据就不延长自主性）；
  - `complete` → evidence 必须过 §9 证据门控，不过则降级为 `continue`；
  - `needs_human` → `blocked`，blocker 记录裁判 reason。**唤醒条件（用户拍板）：本会话的任意用户消息即 resume**（订阅 `session.inbox.enqueued` 的用户消息事件，status 回 `active`、stalls 清零、注入唤醒），`/goal resume` 显式命令保留作为第二入口。
  - `give_up` → `stalled`，报告含裁判 reason + 最后三轮原文 + 待办状态；
  - `continue` → stalls 归零、`judgeUsed=true`，下次唤醒携带 instruction。
- **频率**：每个 goal 裁判至多一次（我的决定，防止裁判-唤醒互踢死循环）；
- **成本**：只在连续 3 次失败后发生一次，非常规路径，不计入主预算。

**报告**（stalled 时生成，synthetic 通知 + 存入 `stallReport`）：目标、待办快照、最后三轮模型原文、裁判解读（若用过）、建议的下一步。

## 9. 完成与证据门控

- 主裁决通道是**工具动作**，不是自然语言解析：`goal_complete`（完成）、`goal_block`（等人/卡死）、普通工具（有进度）、无动作（stall 计数）。
- `goal_complete` 门控（沿用先例验证过的启发式，非语义验证）：
  1. 长度 ≥ 24 字符；
  2. 含具体锚点（路径、数字、扩展名，或 test/passed/commit/verified 等关键词）；
  3. transcript 接地：证据中至少一个实质词元出现在本会话消息中（防凭空捏造）；
  4. 失败 → 返回拒绝原因，goal 保持 active，下一轮唤醒会带反馈。
- `goal_clear`：必须引用用户原话，且对照**非 assistant** 消息接地；无 transcript 时 fail-closed 拒绝（破坏性操作永不宽松）。
- `goal_set`：存在非终态 goal 时拒绝（不能覆盖）；默认 cap 10 turns（tokens 默认仅统计、不设限；token 上限 opt-in：`--tokens N` 或 options `defaultCapTokens`），`unbounded` 需显式声明。

## 10. 压缩防护小结

三道防线：
1. 状态本体在 storage（压缩根本碰不到）；
2. `context` hook 每轮注入目标块（短、稳定）；
3. `compaction` hook 把完整状态块写进压缩摘要（压缩后的第一现场就是真实状态）。

## 11. 预算

- `used.tokens` 取自 `session.usage.updated`（累计，直接赋值不累加）——**仅作统计**（view/上下文/报告展示），默认不参与限制（2026-10-16 裁决：统计与限制分离；会话累计语义在长会话下会秒杀 goal，且宿主 `cache` 字段当前恒 0，provider 不报命中量）；
- `used.turns` 每次唤醒注入 +1；
- token 上限 opt-in（`--tokens N` 或 options `defaultCapTokens`），未设则 token 维度不参与比较（`isCapReached` 缺维不比）；
- 超 cap → `budget_limited`（独立终态，可 resume 续跑，可 clear 移除）。

## 12. 权限沙箱（无人值守安全面）

沿用先例的 fail-closed 设计（我的决定：v1 保留，无人值守场景它是安全底线）：

- 仅当 goal `active` 时介入 `permission.hook("evaluate")`；
- 会话工作目录内的绝对路径 → 自动 allow；目录外 → 自动 deny，消息引导模型走 `goal_block`；
- 已配置的 `deny` 永不放宽；非路径资源（URL、命令）一律不表态（leave）。

**控制面自授（用户拍板）**：8 个 goal_* 工具（含 `goal_wait`）注册时声明专属权限动作 `permission: "goal.control"`（`@opencode/schema/tool` 的 `Info.permission` 字段，已核实）。permission hook 见 `action == "goal.control"` 且该会话有 active goal 且会话归属本实例 → allow。豁免严格圈定在这 8 个动作（日志可审计），没有 active goal 时不自授（工具内部逻辑自会拒）。理由：控制面（让循环能自己终结自己）与数据面（路径/命令）分权——不声明则默认 `ask`，无人值守时模型一调 goal_complete 就卡在人工会话上，核心功能失效；全量放行则与"deny 永不放宽"矛盾。

## 13. 命令与工具面

**命令**（`/goal`，`command.transform` 注册）：
`set [objective] [--turns N] [--tokens N] [--unbounded]` / `view` / `pause` / `resume` / `complete <evidence>` / `block <reason>` / `clear` / `task add <t>` / `task <n> todo|doing|done` / `history`（别名沿用先例，细节实现时定）。

**工具**（`tool.transform` 注册）：
`goal_set / goal_complete / goal_block / goal_clear / goal_history / goal_add_task / goal_update_task / goal_wait`（`goal_wait(minutes≤60)`：active goal 必需，声明继续等待、静默 check-in、不消耗 stall 预算），行为与 §8-§9 一致，description 里写明门控规则。

## 14. 模块布局与测试

```
index.ts              # 插件入口 { id, setup } + goals RPC（widget 预留）
src/state.ts          # GoalRecord + 纯状态转换 + 归档键
src/controller.ts     # 事件仲裁器、唤醒注入、命令、工具
src/wake.ts           # 唤醒/状态块消息构造
src/judge.ts          # 旁路裁判：session.generate 封装 + JSON 契约 + fail-closed 解析（策略可注入，便于测试）
src/evidence.ts       # 证据门控 + clear 请求门控
src/permission.ts     # 路径沙箱
src/compact.ts        # compaction hook（状态入摘要）
src/options.ts        # 插件 option：stallLimit(=3)、默认 cap、唤醒文案、裁判开关
src/types.ts
test/
  harness.ts          # mock ctx + 确定性事件总线（沿用先例模式）
  goal-loop.test.ts   # 走真实 setup() 的集成测试
  judge.test.ts       # 裁判契约与 fail-closed 路径（注入假裁判）
  tasks.test.ts
scripts/live-smoke.ts # 起隔离宿主：/goal 注册、唤醒触发一次、确认 shell 事件语义
tests/diagnostics/  # 回调丢失诊断实验：后台跑必然失败的脚本，记录 shell.exited 是否发出、是否变成 inbox 消息、会话是否被唤醒——定位丢在事件层还是投递层（决定要修唤醒链路还是只靠看门狗兜底）
                         # 宿主重启实验：杀 service 进程重启，观察 shell 记录去向（取消?退出码?）、active goal 对账后是否正确唤醒
                         # 宿主原生恢复验证（2.0.29 桌面端）：源码已确认 core 存在 resumeSuspendedSessions 清扫（续跑挂起会话 + 投递 shell 取消通知），但"服务惰性、需宿主主动调用"——桌面端是否调用、何时调用未确认。实验：① turn 进行中杀进程重启 → 是否出现 "server restarted…continue" 合成消息并重跑；② idle 等 shell 杀进程重启 → 是否只收到取消通知不唤醒；③ 有 pending 队列唤醒消息的 idle 会话重启后是否会被投递（决定对账第 2 步的 cancel 策略是否必要）
```

测试策略：
1. 单测：纯状态机、证据门控、裁判解析器（无宿主依赖）；
2. 集成：mock 上下文 + 确定性事件总线，覆盖唤醒去重、stall 阶梯、裁判分支、预算、归档；
3. live smoke：起真实宿主（可无模型调用断言注册；有条件时跑一个微型长任务），**顺带确认 `shell.created/exited` 与 `session.shell.*` 的语义差异**（§4 遗留项）；
4. A/B 对照（可选，用户已降级）：同一长任务分别用本插件与 opencode2-goals 跑；验收主标准是场景复现测试（隔离宿主复现静默停滞/回调丢失/重启三痛点，见 §14 诊断实验）。

## 15. 决策归属清单

**用户拍板**：
1. 状态 = 总体目标 + 待办清单（外化持久）；
2. 唤醒消息一种（普通、带状态），不做循环内审计式升级；
3. 连续唤醒失败 → 旁路 LLM 裁判解读停滞原因，结构化输出决定是否继续唤醒；
4. 完成判定 = 工具动作 + 证据门控（启发式）；
5. 脚本回调在飞时不唤醒；
6. 目标版本 2.0.29，从零设计（opencode2-goals 仅作先例）。
7. 脚本等待策略：不预测脚本命运，只查事实——看门狗主动查 shell 状态/输出："退出→合成唤醒 / check-in 条件未满足→继续等 / check-in 条件满足（零增长超 `shellStallMs` 或有增长但超 `waitCheckInMs`）→ 状态核查唤醒，仅 idle 会话注入"；timeout 包装不强制（opt-in option，默认关）。
8. goal_* 工具声明专属 `goal.control` 权限动作，沙箱精确自授（仅 active goal + 归属本实例）；无 active goal 不自授。
9. blocked 唤醒条件：任意用户消息即 resume（保留 `/goal resume` 显式入口）。

**我的决定（评审时请重点看这几条）**：
1. N=3（stall 阈值），option 可调；
2. 每个 goal 裁判至多一次；裁判解析失败 = give_up（fail-closed）；
3. v1 保留权限沙箱（沿用先例 fail-closed 设计）；
4. 默认预算 10 turns（tokens 仅统计不设限，token 上限 opt-in）；
5. 压缩双保险：context hook + compaction hook；
6. TUI widget、语义验证、换模型/子代理升级全部划到 v2；
7. 裁判用 `session.generate`（会话域旁路）而非 `ctx.generate.text`（全局）——理由：共享会话 hook 身份、审计归属更清晰。
8. 看门狗默认值（option 可调，已定死）：tick 30s / 零增长 5min / 久等 check-in 5min；check-in 仅 idle 会话注入，停滞段语义（每段至多一次，会话活跃/goal 终态即取消）；模型可用 `goal_wait(≤60min)` 显式声明静默。

## 16. v2 候选（已确认 API 存在，暂不做）

- 独立裁判升级：裁判 `continue` 后仍停滞 → 换干净上下文/子代理（prompt 的 `agents` mention 机制已存在）；
- 语义证据验证（裁判带 shell 执行权跑真实检查）；
- TUI 侧边栏 widget（`rpc` 域预留；参考项目 issue #3 教训：宿主 JSX transform 不处理 node_modules 下 `.tsx`，widget 必须预编译成 `dist/*.js` 随包发布）；
- 裁判可用 `ctx.generate.text({ model })` 指定更便宜的模型。

## 17. 2026-10-17 修订（数据面通道变更）

§77（门禁 shell 查询走 `ctx.rpc.call`，见 §7 与上文）在 2.0.32 **不成立**：进程内 `ctx.rpc` 是**宿主→插件**的注册面通道，插件侧查询不可用（2.0.32 全链自测 19 个候选域全 "RPC is unavailable"）——§77 的初选错误。数据面改为宿主自身的 **HTTP client 面**（实施计划与契约钉死：`docs/superpowers/plans/2026-10-17-http-data-plane.md`）：

- **发现**：`%USERPROFILE%\.local\state\opencode\service.json`（XDG_STATE_HOME 可重定向）`{id, version, url, pid, password}`；Basic 鉴权（username 固定 `opencode`）；注册文件 `pid` 自识别（mismatch = 查询失败）。
- **端点**：`GET /api/shell`（位置经 `x-opencode-directory` 请求头 / `location[directory]` 方括号查询指定；点记法 `location.directory=` 对服务端不可见 → 回退服务 cwd = home） / `GET /api/session/:id/inbox` / `DELETE /api/session/:id/inbox/:inboxID`（404 `SessionNotFoundError` → 空列表 / 已完成语义）。
- **裁定（2026-10-17）**：查询失败 = 宿主上下文死亡 → 边界 **skip**（不唤醒、不武装 check-in、不消耗 stall 预算）+ 决策日志一行（`<tempdir>/opencode-goal/decisions-<hostpid>.jsonl`，wake/hold/skip 各一行）+ 每会话一次 warn；**复活会话不是插件的活**。权限沙箱：**读放行、只限写**（`WRITE_ACTIONS = [fs.write]`，不可区分的 action 一律不表态）。
- **实机验证（2026-10-17，2.0.32 一次性隔离宿主，13/13 全绿）**：`scripts/verify-hostapi.ts`——注册文件落点 / pid 契约 / 受管端口 / 本地源码插件加载（`/goal` 注册）/ hold 真计数（`own=1, ownKnown=true`）/ 无即时唤醒 / check-in 真计数 / 界外读无 plugin deny / 活 `service.json` mtime 不变 / 数据目录隔离（`XDG_DATA_HOME`）。

宿主侧发现（2.0.32，无头 `serve --service`，实证）：

1. shell 列表是**每位置一份的内存表**（仅 `status=running`；`POST /api/shell` 等创建路径进表）。位置路由可用：服务端 `requestRef`（`packages/server/src/location.ts`）只认 `x-opencode-directory` 请求头或 `location[directory]` 方括号查询参数，回退 `process.cwd()`（`serve --service` 启动时 chdir 到 home → 无参恒落 home）。早期"查询参数不路由、全落 home"的结论系探针误发点记法 `location.directory=`（对服务端不可见）所致，2026-10-17 对照公开源码（anomalyco/opencode v2.0.32）+ 隔离宿主实机 5/5 验证后撤销；非默认位置在飞的 shell 用正确编码即可见。
2. `XDG_CONFIG_HOME` 对**主配置不生效**（该处配置文件只被 watcher 订阅、不被读取——模型会静默回退内置默认）；显式配置源 env `OPENCODE_CONFIG_CONTENT` 生效（隔离验证宿主依赖它）；受管服务端口文件 `<XDG_CONFIG_HOME>/opencode/service.json` 有效。
3. 2.0.32 的 command 端点 body 为 `{ name, text }`（2.0.29 协议为 `{ text }`）。
4. **模型会自行终止 goal**（model-side completion）：goal 终态后所有边界静默 no-op、check-in 被 ghost 规则 disarm——长跑场景的 goal 文案须显式禁止模型自行 complete（验证脚本 `HOLD-FOREVER` 文案即此用途）。

## 18. 2026-10-17 修订（迟到事件误杀 check-in）

§7.2 的"任何会话活动取消 check-in 计时"在 2.0.32 实机上被一条**迟到事件**打破：宿主在该回合的**终态边界事件之后**才发出该回合的 `session.usage.updated`（token 用量上报）。`onUsageUpdated` 无条件 `checkinDue.delete` 把刚武装的一次性 check-in 取消——goal 静默 150s+（verify 实机两次稳定复现：A7 超时、决策日志仅 hold 一行、仪表显示 `checkinDue cancelled by usage.updated` 后 tick 见 `due=none`）。

- **修复（`src/controller.ts`）**：`usage.updated` / `tool.called` 的取消**仅在该会话回合确实进行中**（`turns[sid].active === true`）时生效——迟到的记账事件不是活动；`execution.started` / `inbox.enqueued` / `shell.started|ended` 保持无条件取消（真实活动）。
- **测试**：`test/background-gate.test.ts` test 5 改为"真活动（新回合）取消"；新增 test 21"终态边界后的迟到 usage/tool 事件不取消已武装的 check-in"（先 RED 后 GREEN）。
- **实机复验（2.0.32 隔离宿主）**：13/13 全绿——A7 check-in 携真计数落入 inbox 并被消费。
- 同一轮顺带修正 `scripts/verify-hostapi.ts` 收尾：临时目录删除包 best-effort（Windows 子进程句柄残留导致 `rmSync` 抛错、污染退出码）。

## 19. 2026-10-17 修订（窗口失锚：丢一个事件让 goal 永久休眠）

129 现场事故（用户报障"几次都是我手动唤醒的，插件都没见动作"）：wake 发出后，宿主事件流**丢失了唤醒回合的 `session.execution.started`**（单条事件级丢失，其余事件正常——goal 记录持续在写）。`continuationPending` 窗口因此不关闭 → 唤醒回合真正的终态边界落进窗口被"至多跳一个"静默跳过 → 会话休眠期间**没有任何回合在跑 → 永远不会有第二个边界** → "第二个不同边界关窗"的兜底等不到 → **goal 永久休眠，且零日志行**（skip 路径不写决策日志，事故对外不可见）。设计假设"边界流不断"，休眠恰恰断掉了边界流。

- **修复（`src/controller.ts`）**：窗口改**时间限界**（默认 10s，`deps.contWindowMs` 可注入）——同一回合终态的兄弟事件（`execution.succeeded` → `session.idle`）毫秒级到达；超出窗口才到的边界必是唤醒回合自己的终态 → 关窗、正常仲裁。单条事件丢失不再能把 goal 推出循环。skip 路径同时补**决策日志行**（`decision:"skip"`, `reason:"continuationPending window (sibling boundary)"`）——跳过从此可见。
- **测试**：`test/single-instance.test.ts` test 4（RED：旧逻辑下 `wakeCount` 停在 1 = 现场签名"goal 死循环"；GREEN：窗口过期后边界被正常仲裁，`wakeCount` 2）。
- 129 重播种（新构建）待用户 GO，机制同 §18 部署（缓存目录播种 + options nudge）。

## 20. 2026-10-17 修订（provider 失败暂停：模型跑不起来时别再空转唤醒）

129 现场事故（截图 + 决策日志实证）：provider 断供（`Upstream request failed: Insufficient account funds`）时，**每个失败回合都产生终态边界 → 插件判 in-flight 0 → 照常发 wake → 下个回合又失败 → 再 wake**（turn 51/52/53 连发）。stall 阶梯没兜住：用户期间发的"加油。"使 `lastInbox=user` → 按设计"有人在场不算 stall"→ `stalls` 反复归零 → 无限循环。同时 `used.turns` 被失败回合消耗（"turn 51"里大部分是失败请求）。根因：插件把"模型停止没进展"（该 wake——循环的本义）和"模型根本没跑起来（provider 挂了）"（wake 纯属空转，余额/路由问题不会因再 prompt 一次自己好）当成同一种零进展处理。

**用户裁定（2026-10-17）**：`goal_block` 不可行——这是模型问题，不是对话流程业务限制 → **静默暂停 + 退避自动重试**（恢复后无人值守继续跑）。

**契约钉（129 实机消息流取证，2026-10-17）**：失败回合的 assistant 消息带 `error = { type: "provider.quota", message: "Upstream request failed: Insufficient account funds" }`（宿主 schema `Session.Message.Assistant.error` = `Session.StructuredError { type, message, status? }`）。provider 级错误类型形如 `provider.quota` / `provider.error` / `provider.auth` / `provider.no-route` / `provider.content-filter`；`ToolError` / `Interrupted` / `ExecutionInterrupted` / `unknown` 属正常运行，**永不**触发暂停。

- **修复（`src/state.ts` / `src/options.ts` / `src/wake.ts` / `src/controller.ts`）**：
  - `GoalRecord.providerPause?: { until, noticeSent }`；新选项 `providerFailLimit`（默认 2——单次瞬断仍给一次唤醒机会）、`providerPauseMs`（默认 30min）。
  - 边界仲裁新增前置分支：`lastAssistantProviderError`（最后一个 assistant 消息的 `error.type` 含 `provider`；context 查询失败 = fail-open 按正常处理，永不假暂停）。errored 边界 → 连击计数；**连击 ≥ 上限（或暂停已过期）→ 进入/续期暂停**：不发 wake、不计 stall、不计 `used.turns`、**一条** synthetic 通知（每次事故一次，`noticeSent` 持久化在 goal 记录上——续期不重复通知）、写决策行 `skip: provider failure streak N — paused 30m`、看门狗 re-arm 作为重试心跳。
  - **干净边界（模型又跑起来了）→ 清连击 + 清暂停 → 正常仲裁恢复循环**（用户换模型/充值后自动续跑）。
  - 连击 1（未达上限）→ 照常 wake 但**不计 `used.turns`**（`injectWake(goal, countTurn=false)`）——失败回合不烧预算、不污染 "turn N" 计数。
  - 暂停期间：in-flight 门按 quiet 处理（不武装 check-in）、tick 不投递 check-in（失败投递 = 又一个 doomed 回合）。
  - **到期**：watchdog tick 发**一条** retry wake（goalControl，watchdog 文案族，`providerPauseRetryText`）；该 retry 的边界解决暂停——errored → 续期（不重复通知）、clean → 清除。disarm 条件放宽：未过期的暂停存在时 tick 保持运行（否则 30min 后无人点火重试）。
- **测试**：`test/arbiter.test.ts` test 15-19（RED → GREEN）：15 首次 errored 边界唤醒一次且不计数、二连触发暂停（一通知、不计 stall）；16 三犯续期不重复通知、干净边界清除并恢复计数；17 到期看门狗恰好发一条 retry、失败重试续期不重发通知、下个期限再发；18 非 provider 错误（ToolError）不暂停；19 暂停期间 in-flight 边界静默（check-in 不武装不投递）。`test/options.test.ts` 默认值断言同步补两新字段。
- 129 重播种（含本修复的新构建）已执行（2026-10-17 16:29Z，目录 1792254554427，entrypoint 切换实证 + /api/plugin 报 1.0.7）。

## 21. 2026-10-18 修订（撤销 50 条待办上限）

§5 原设"待办上限 50 条（与先例一致）"。129 现场（10 天 vllm sm70 战役，单 goal 53+ 轮）ledger 打满 50 后模型只能转"用文档管理状态"——长战役的账本天然超过 50 行，硬上限逼模型把活索引外溢到文档，与"ledger = 在飞索引、档案在文档"的定位自相矛盾（上限拦的是活项，不是结算项）。

**用户裁定（2026-10-18）**：不应有这个限制 → **撤销**。

- **修改**：删 `GOAL_TASK_LIMIT` 常量与 `TaskLimitError`（`src/state.ts`）；`addTask` 不再抛错；`goal_add_task` 工具描述去掉"at most 50"；`taskAdd` 的 TaskLimitError 分支删除（`src/controller.ts`）。
- **定位不变**：ledger 是**在飞索引**，结算历史归项目文档（模型自律，如 `sm70_docs/`）——上限撤了，外溢纪律仍由模型按 objective 里的纪律行执行，不靠硬错误。
- **测试**：`test/state.test.ts` 原"51st throws TaskLimitError"改为"100 条 add 全成功"；`test/goal-loop.test.ts` test 6 改为"51st add 成功（无上限）"（RED → GREEN）。

## 22. 2026-10-18 修订（唤醒文案：授权式 goal 模式，非命令式逼迫）

原 slim 唤醒第二行是命令式菜单："End this turn with a tool call: goal_complete / goal_block / advance the goal."。129 现场（模型刚问"推 ② 还是 ④？"后紧跟这条蓝色注入）观感突兀——像是喝令打断，且没有"等待"分支。

**用户裁定（2026-10-18）**：goal 模式要给 LLM 自主权——提醒它"在 goal 模式下工作、按纪律按流程推进、不要问问题"，而不是逼迫它；合法停止只有两个：**goal_complete（完成）与 goal_block（阻止）**。

- **修改**（`src/wake.ts` 两个模板）：第二行改为授权式——"Goal mode: you advance this goal unattended. Don't ask the user questions and wait — follow the goal's discipline and take the next safe step. The only stops are goal_complete(…) / goal_block(…)。A user message always overrides this reminder."；`full` 模式同步改写末段（done / genuinely blocked / otherwise advance 三分支 + 用户消息优先条款）。
- **语义护栏**：① `goal_block` 保留为"需要用户决策"的合法等待出口（02:01 那次 block 等立项裁决是正确行为，不得误杀）；② "用户消息永远优先"条款防止自主权越过真人。
- **强制力不变**：文案只是框架——既不 stop（complete/block）也不推进的空转回合仍由 stall 阶梯兜底，机制不动。
- **测试**：`test/wake.test.ts` 两处模板钉改 + slim 新增 `not.toContain("End this turn")` 断言（RED → GREEN）。
- **同批审查（用户下令"充分审查后再修改"）**：全部 8 个注入渠道逐一过审——
  - `backgroundCheckInText`（后台静默一次性提醒）：尾句 "advance the goal" 命令式 → 改授权式（"check what finished, then take the next safe step per the goal's discipline…don't stall on a question to the user. A user message always overrides this reminder."）——check-in 时刻恰是"后台在跑、想干等/问人"场景，正是裁定要覆盖的。
  - `shellExitText`（后台 shell 退出唤醒，controller 私有）：尾句 "Decide the next step; end this turn with a tool call" → "Goal mode: take the next safe step per the goal's discipline (act on this result, or make independent progress). A user message always overrides this reminder."
  - `providerPauseRetryText`（断供暂停到期重试）：尾句 "say so and end this turn with a goal tool call" → 报告并停（"If a request still fails, note it in your reply — the loop auto-pauses and retries at the next deadline; a clean turn resumes."）——机制不变（边界解决暂停：errored 重新武装 / clean 清除），模型永不被逼重锤死 provider。
  - 保留不动（各有理由）：`providerPauseNoticeText`（面向人的事故告警，非对模型逼迫）；goal 状态通知（纯事实，零命令）；judge instruction（judge LLM 自产自由文本）；compaction 提示词/摘要（非会话注入，摘要任务的指令式合理）。
  - **测试**：`test/wake.test.ts` check-in 两钉改 + `providerPauseRetryText` 新钉 + `not.toContain("end this turn")`；`test/watchdog.test.ts` shell 退出断言补 "Goal mode:"/"next safe step"/无 "end this turn"（RED ×3 → GREEN）。

## 23. 2026-10-18 修订（blocked resume 清陈 blocker——129 "激活没保持住" 排查副产物）

129 现场：goal `g_mvdan48x_2s` 被模型 `goal_block`（A/B/C/D 决策菜单）后由用户消息 resume 回 active，但记录里 **`blocker` 长文残留**（`/goal view` 与模型上下文里读起来像"仍然 blocked"），用户误判为"激活状态没保持住"。排查同时确认：该 goal 当时实际 active 且健康推进（8+ 回合），"只有我输入才保持"是模型**设计内**的等待行为（block 等决策 + `goal_wait` 声明等待），非循环故障。

- **修改**（`src/controller.ts` §15-9 resume 路径）：resume 时 `goal.blocker = undefined`——blocker 的历史留在线合（block 合成消息）里，活记录不再携带终态字段。
- **测试**：`test/arbiter.test.ts` test 8 补 `expect(after.blocker).toBeUndefined()`（RED → GREEN）。

## 24. 2026-10-18 修订（在飞门禁：other 按 host parentID 链归属——先裁定"不混"，再裁定"子任务要认得"）

129 现场：campaign goal 的边界被 `other:2` 反复 hold。取证发现 `other` 数的不是 shell，是**其他正在跑模型回合的会话数**（2026-10-17 引入的 subtask 代理计数，无任何会话归属）——用户的交互会话把 campaign 的循环一直按住，check-in 文案还把忙碌会话数谎报成"background items in flight"。

**用户裁定（两轮）**：① "两个独立会话是不同的任务，不能混的" → 外来的活跃会话不得门禁；② "子任务不能区分是哪个会话的子任务？" → 查宿主 2.0.32 schema 实证：`Session.Info.parentID`（`packages/schema/src/session.ts` L33）**存在**——当年"no parent links, COUNT ONLY"的判断是错的。

- **修改**（`src/controller.ts`）：`inFlightSignal` 的 `other` 从"全部其他活跃会话"改为**父链归属**——新 `isSubtaskOf(sid, root)`：沿宿主 `sessionGet(sid).parentID` 链上溯（上限 8 跳，子代理深度有限），命中本会话才计 1；查询失败 fail-open 计 0（陌生会话永不 hold 循环）。门禁 `inFlight = own + other`（other 现在只含真子任务）；决策日志字段语义随之收窄（`other` = 归属子任务数）。
- **效果**：用户的交互会话（无父链）对 campaign 完全不可见；模型自己派生的 subtask 会话（parentID 链连到本会话）仍按原设计意图计为在飞背景。
- **测试**：`test/background-gate.test.ts` 全面改造——test 2 改"外来会话（无 parentID）不门禁→wake"；新增 2c（`setSession(CHILD,{parentID:S})` → 子任务门禁 hold）；新增 22（外来会话 wake 且 other=0）与 22b（子任务 hold 且 other=1）；原 5/6/7/9/11/12/13/21 的 CHILD 代理全部换成 own shell（`setShells`）；test 10 删除（"child 永不下线"前提随 blanket 计数一起消失）；`test/harness.ts` `setSession` 扩展 `parentID` 字段（RED → GREEN）。
- 教训：探针看 `other` 字段时先假设它是 shell 数是错的——先读计数器实现再下结论；"当年不可得"的宿主能力要拿当前版本 schema 复核。

## 25. 2026-10-18 修订（goal 级决策统计：终态归档自带"机制健康"摘要，不做决策日志长期保留）

129 巡检裁定：决策日志（`/tmp/decisions-<pid>.jsonl`）**不需要长期保留**——健康时段 90%+ 是同一条 `boundary (in-flight 0)`，信息密度低；插件 bug 的发现路径是本地 stub/实宿主测试，不是生产遥测考古。真正缺的是"goal 终态记录里看不到循环机制在它生命周期内干了什么"。

- **裁定**：不做日志持久化/轮转；改为 `GoalRecord.decisions = { wake, hold, skip, paused }` 四桶计数，每个边界决策点计数 +1（与决策日志行一一对应，`paused` = provider 暂停事故，日志里是带专属 reason 的 skip），随记录持久化 → **终态归档（`archived/<goalID>`）天生携带**：看一份归档就能回答"这个 goal 活着期间循环是否健康"（skip>0 = 宿主上下文死过；paused>0 = 断供过；wake 量级 = 唤醒节奏）。
- **修改**：`src/state.ts`（`GoalDecisions` 类型 + `bumpGoalDecision` 懒初始化——旧记录无字段也安全）；`src/controller.ts` 五个决策点各一行（continuationPending skip / provider-pause→paused / host-dead skip / hold / wake）。`/goal view`（模型面）不加此字段——模型上下文不背审计数据。
- **测试**：`test/goal-decisions.test.ts` 新增（单元：createGoal 零值 / 增量 / 旧记录懒初始化；控制器：四桶各一条路径 + complete 后归档键携带计数）。

## 26. 2026-10-18 修订（补记 2026-10-17 裁定：旁路裁判默认关闭 + README 同步）

§8（停滞阶梯 → 裁判仲裁）在 2026-10-17 已被裁定**默认关闭**（`options.ts` 注释留痕：`judgeEnabled: false`——裁判的唯一排他价值是救回停滞 goal，其失败模式退化为无裁判行为，129 场数据从未触发过（stalls=0）；停滞 goal 浮出给人是**预期的控制点**；`judgeEnabled: true` 可重新开启），但修订附录一直没记，README（npm 包文档）至今按"默认开启"描述。2026-10-18 用户指出后同步：

- **README 修正**（5 处）：机制表"停滞仲裁"行改为"默认直接 stalled，裁判为 opt-in"；`/goal view` 描述改与实际输出一致（状态/目标/预算，不含"停滞与裁判记录"——`viewGoal` 只输出这四段）；`stallLimit` 说明改默认停滞语义；`judgeEnabled` 默认值 `true` → `false`；典型流程"卡住时"句改默认 stalled 路径。
- **语义**：默认行为 = 停滞上限到达 → `stallGoal`（停滞报告 + 归档，浮出给人）；`judgeEnabled: true` 时行为回到 §8（每 goal 至多 1 次仲裁，输出不可解析 = give up）。代码未变，纯文档对齐。

## 32. 2026-10-16 修订（旁路生成通道：ctx.generate.text + model option，会话模型透传）

主体 §8/§15-7 的"裁判走 `ctx.session.generate`（共享会话身份）"被替换：裁判与压缩摘要统一走**全局生成** `ctx.generate.text`（不挂在会话上，天然零污染）；模型选择三层 = option `model`（`"providerID/modelID"` 严格两段）> **会话自身模型**（`ctx.session.get` 回读，含会话内切换）> 宿主默认。`model` option 主体 §14 未列，属本修订引入。
- **修改**：`index.ts` 适配器（generate 注入）、`src/options.ts`（`model` 解析 + `selectJudgeModel`）、`src/judge.ts` 通道改全局生成。
- 主体 §8"通道：ctx.session.generate"、§15 决定 #7 的表述以本条为准（历史保留）。

## 33. 2026-10-17 修订（尾部通道接地簇：context hook 移除 + wakeDetail slim + CJK 证据）

主体 §7 的"双通道注入"（context hook 每轮注入 `[GOAL]` system part + 唤醒消息）与 §10 防线 2 不成立：**context hook 已整体移除**——插件不写任何 system part（防 LLM 前缀缓存失效），goal 接地全量迁到**尾部通道**（唤醒消息 + goal 创建消息 + compaction `[GOAL STATE]` 块）；`start()` 只注册 compaction hook。同簇裁定：
- **wakeDetail option（`full`/`slim`，默认 `slim`）**：slim = 标题 + 一行自主提醒（唤醒不再重述预算/目标/任务——主体 §7 模板的"完整块"作废）；`full` = 完整 re-grounding。
- **唤醒 prompt 不再携带 `resume: true`**（仅 `delivery: "queue"` + metadata 归属）；`PromptInput.resume` 字段保留恒 undefined。
- **证据/clear 门控 CJK 扩展**（主体 §9 锚点清单超集）：锚点层 OR 入 CJK 关键词（测试|通过|完成|验证…）、clear 关键词正则加 CJK、接地分词对 CJK 连字串滑窗 bigram。原拉丁判据全保留。
- **修改**：`src/wake.ts`（双模板 + slim 默认）、`src/options.ts`（wakeDetail 严格解析）、`src/evidence.ts`（CJK 层）、controller `start()`（hook 注册面收窄）。

## 34. 2026-10-17/18 修订（控制器容错机制：单实例守卫 + CAS 写守卫 + project 归属关闭）

主体无记录的三个 2026-10-17/18 现场事故驱动机制：
- **单实例守卫**（热重载事故：宿主重跑 `setup()` 不 dispose 旧实例 → N 个消费者重复唤醒、turn 计数膨胀 2–3×）：`globalThis` Symbol 槽，`start()` 第一行（任何 await 之前）认领，接管前先停前任（10s 上限），被顶替者中止武装。
- **goal 记录 CAS 写守卫**（Task 14 Fix 1）：`saveGoal` 写前探测 storage，`stored.updatedAt` 严格更新于 load 基线 → 丢弃写、返回 false；`finishGoal` 因此跳过归档、抑制终态声明（不 archive、不声称终态，UI 回报 "changed underneath"）。附带 `GoalRecord` 新增 `createdAt/updatedAt`（主体 §5 未列）。
- **project 归属关闭**（主体 §6 ②"多 location 安全"作废）：适配器 `probe.projectID = undefined` → `sessionBelongs` 恒 true，全 session 可见；正当性 = 单实例前提（一进程一条事件流 + 一份 storage）。

## 35. 2026-10-17/18 修订（仲裁顺序与面：预算前置、细粒度子命令、stallReport 定稿、permission 契约）

- **仲裁顺序**：主体 §6 序列 ②（在飞门禁）与 ④（预算）互换——实际顺序 = 去重/续接窗 → active goal → **预算（isCapReached → budget_limited 终态 + 归档）** → provider 暂停（§20）→ 在飞门禁（hold/check-in）→ 归属。后果：在飞 shell 的边界上预算超顶直接判 budget_limited，而非 hold 住等下一边界。
- **细粒度子命令**（2026-10-17 用户裁定，主体 §13 只记了单一 `/goal` 面）：`goal-set / goal-view / goal-pause / goal-resume / goal-complete / goal-block / goal-clear` 各注册独立命令（/ 菜单一行一条，逐行参数帮助），路由回同一 dispatchCommand。
- **stallReport 结构定稿**：四段（objective / 任务快照 / 最后无动作原文 ≤3 轮 / Judge 段），**无"建议的下一步"段**（主体 §8 该句作废）。
- **permission evaluate 契约**（2.0.32 实证，主体 §4"同旧插件同面"不成立）：宿主回调签名 `(input) => Promise<void>` **无返回通道**，决策靠原地改写 payload（`p.effect` / `p.message`）；task13 实机终审 2026-10-20 完成（生产 2.0.32 桌面 + 隔离 serve 宿主端到端：模型的 `goal_*` 调用经此钩子自授权后派发进插件）。
- **shell 退出唤醒**（主体 §7.2 措辞校准）：实际是**每个**曾入 waitingShells 的 shell 结束各投递一条结果唤醒（逐 shell 的 status/退出词/输出尾部），非"最后一个结束时投递一条"；测试 `test/watchdog.test.ts` 钉 per-shell 行为。

## 36. 2026-10-18 修订（provider 暂停重试 one-shot 守卫：retrySent）

§20 的"每个 deadline 恰发一条 retry wake"在实机有洞：retry 的边界事件丢失（§19 已实证的单条事件丢失模式）且有待存 check-in 阻止 disarm 时，看门狗存活、**每个 tick（30s）对同一过期窗口重复发 retry**——正是 §20 反对的"空转"。本地 2026-10-18 巡检审计发现（RED 测试实证：1 条 vs 实际 6 条）。
- **修改**（`src/state.ts` / `src/controller.ts`）：`providerPause` 增 `retrySent?` 标志——tick 触发条件加 `retrySent !== true`，发后置位并持久化；暂停 re-arm 构造**全新**记录（新窗口重置 `retrySent`），clean 清除路径不变。
- **测试**：`test/arbiter.test.ts` test 20（存活 check-in + 过期 pause + 多 tick → 恰 1 条 retry；RED 6→GREEN 1）。

## 37. 2026-10-18 修订（/goal resume 覆盖扩展：blocked 与 budget_limited 可恢复，按主体 §15-9/§11 裁定）

主体的两条可恢复裁定在实现中缺失：§15 决定 #9（resume 是 blocked 的第二入口）实际只实现了用户消息入口（`resumeGoal` 只认 paused）；§11"budget_limited 可 resume 续跑"未实现（超 cap 立即归档且 resume 拒绝）。2026-10-18 用户裁定：两者改代码对齐 spec。
- **修改**（`src/controller.ts` `resumeGoal`）：可恢复集 = `paused`（原有，行为不变、不唤醒）/ **`blocked`**（对齐 §15-9 用户消息恢复语义：active + stalls 0 + 清 blocker（2026-10-18 129 stale-blocker 裁定同样适用）+ 注入一条唤醒）/ **`budget_limited`**（active + stalls 0 + 一条唤醒）。`completed` / `stalled` / `cleared` 仍为硬终态（拒绝文案改为 "not resumable"）。
- **语义备注**：budget_limited resume 后 cap 照常强制——cap 未放宽时（当前无上调既有 goal cap 的命令）下一个边界会再次判 budget_limited（synthetic 通知写明 used/cap，自解释）。
- **测试**：`test/goal-loop.test.ts` 16–18（blocked 恢复清 stale blocker + 唤醒；budget_limited 恢复唤醒；completed 硬终态不可恢复）。
- **README**：`/goal resume` 与 `/goal block` 两行同步可恢复集。

## 38. 2026-10-18 修订（goal_wait 静默窗裁定为窄口径：只静默 check-in，L233(b) 措辞修正）

§7.2 的 `waitUntil` 窗三处表述自相矛盾（§5 字段注释与 §7.2 均为"check-in 不注入"窄口径，L233(b) 为"窗内一切静默（不唤醒、不武装、不数 stall）"宽口径）。2026-10-18 用户裁定**窄口径为准、代码零改动**：窗只静默 check-in（不武装、不触发、待存者出窗后触发）；边界唤醒、shell 退出唤醒（`onShellEnded` 逐 shell 结果唤醒本就不受 quiet 门控）与 stall 计数照常。理由：① spec 自身 2:1 偏窄；② 宽口径与 §7.2"纯文本'看着正常'不是有效回应"契约打架（窗内纯文本回应按 L193 语义就该计 stall）；③ 宽口径会让模型在窗内脚本早已结束时白睡到窗满，且窗到期无任何唤醒机制。L233(b) 已改写为窄口径表述。

## 39. 2026-10-18 修订（工具面补全：goal_pause / goal_resume / goal_view —— 所有功能都可对话调用；控制面自授扩至"goal 存在"）

用户裁定（2026-10-18）：**通过对话管理 goal 是更常用的路径，让命令面的每个能力都有工具面**——用户在对话里口头要求时，模型调用对应 `goal_*` 工具（与命令面完全等价）。核代码后缺口为 3（非 2）：`pause` / `resume` 无工具面，`view` 同样只有命令面。
- **新增 3 个工具**（`src/controller.ts`）：`goal_pause` / `goal_resume` / `goal_view`——全部复用命令侧同一实现核心（`pauseGoal` / `resumeGoal` / `viewGoal`），延续既有"工具/命令等价"模式（test 8），行为零分叉；工具描述写明门控规则 + "用户在对话中要求暂停/恢复/查看时调用"。
- **`goal.control` 自授条件放宽**（本次唯一的安全边界变化，用户已当轮确认）：控制面自授从"会话有 **active** goal"扩到**"goal 记录存在（任意状态）"**——否则 paused / blocked / budget_limited 的 goal 调不动 `goal_resume`（权限卡死），终态 goal 也调不动 `goal_view`。所有变更类工具的 status 自门控（工具层守卫）不变，放宽无副作用。**数据面不变**：路径沙箱仍仅 active 介入（2026-10-17 裁定保持）。
- **修改**（`src/permission.ts` / `src/controller.ts` / `src/types.ts`）：`PermissionInput.goalActive: boolean` → `goalStatus?: string`（undefined = 无 goal 记录）；规则 2 = goal 记录存在（任意状态）即 allow，规则 4 = 仅 `"active"` 介入路径包含检查；controller 权限 hook 传 `goal?.status`。
- **测试**（TDD，322 用例）：`test/goal-loop.test.ts` 19–21（pause 行为 / resume 三可恢复态 + active 与终态拒绝 / view 无副作用；test 10 改 11 工具）；`test/permission.test.ts`（控制面：各状态 allow + 无 goal leave；数据面：paused 对外部路径 write 不表态）；`test/permission-integration.test.ts` 12（paused：控制面 allow + 数据面 silent 同钩子实证）。
- **README**：工具表 8→11；新增"典型对话场景"节（口头请求 → 工具对应）；控制面/数据面设计 bullet 与已知限制"8 个工具"同步。

## 40. 2026-10-19 修订（在飞门改查询式发现：子任务经宿主会话列表 parentID + time 发现；删除事件缓存 + shell 退出快路径 —— 化繁为简）

**现场**：ch2.AI 129 现场 56 条 `other:0` 无限唤醒——运行中的子任务从未被计入在飞（门禁误判 `in-flight = own + other = 0` → 立即唤醒 → `toolCalled` 清零 stalls → 再唤醒……无界）。

**根因（叠加）**：① `other`（子任务）靠 `activeSessions` 事件缓存发现，跨宿主/子任务事件到不了本宿主 → 恒 0；② 即便命中缓存，`isSubtaskOf` 走宿主 `ctx.session.get`，而该接口**不返回 `parentID`**（只映射 location/projectID）→ 真机永不命中。`other` 的"发现"与"归属"两半都是事件驱动，`own`（shell）早已是查询式——不对称即 bug。

**裁定（用户 2026-10-19）**：化繁为简，不要实时在飞跟踪、不要事件快路径——**只在会话 idle 边界查一次接口**（shell + 子任务在飞）：没有在飞 → 正常唤醒；有 → 武装一次性延时检查（`checkInDelaySec`）；后台完成 → goal 自动恢复（新回合 `execution.started`）→ 取消计时，不重复提醒；到点仍在飞 → nudge（防卡死）。

**在飞信号（沙箱实证，真实宿主 `/api/session` 列表项）**：`time.idle` 缺失，或 `time.idle < time.updated` = 在飞；`time.idle >= time.updated`（+ 终态 `outcome`）= 完成。`updated > idle` 比较（而非"idle 缺失"）对多回合稳健、无阈值。

**改动**：
- **数据面**（`src/hostapi.ts` + `src/types.ts`）：新增 `GET /api/session` 查询 `sessionList()`（返回每会话 `parentID` + `time`，同源 UI 读的那份；`ctx.session.get` 不返回 parentID）；`WakeProbe` 加 `sessionList()`；新增 `HostSession` 类型。
- **`controller.ts`**：`inFlightSignal` 的 `other` 改为 `countSubtasksInFlight`（会话列表建 id→parentID 映射，8 跳内上溯到本会话即子任务，按在飞信号计数；查询失败 fail-open 计 0）。
- **删除（"多余的存在"）**：`activeSessions` 事件缓存、`isSubtaskOf`（per-candidate sessionGet 上溯，真机因无 parentID 恒 false）、`onShellStarted`/`onShellEnded`/`shellExitText` + shell 事件 case（事件驱动的 shell 退出快路径——#12138：模型发起的后台 shell 根本不发 `session.shell.*` 事件，快路径对主场景是死代码）、`waitingShells` 持久字段（state.ts）、`rememberShellTimeout`/`shellTimeouts`/`shellTimeoutOrder`（快路径 arm 的超时关联，失去唯一读者）。shell 完成现由"一次性延时检查 nudge"或"goal 恢复"承担，不再有即时"结果唤醒"。
- **不变**：一次性 `checkinDue` 武装/触发/取消骨架、看门狗 tick、stall 阶梯、provider pause、预算、归因；shell `own` 计数本就是查询式（不动）；`timeoutWrap`（create.before 改写 input.timeout）保留。

**测试**（323 用例，全绿）：`test/harness.ts`（probe 加 `sessionList`；`setSession` 扩展 `time`/`outcome`）；`test/background-gate.test.ts`（子任务用例 2c/22/22b 改靠会话列表发现、不再靠 `emit(started)`；新增 23/24 钉在飞信号：`idle >= updated` 完成不计 / `updated > idle` 在飞计数）；`test/watchdog.test.ts`（test 1 改写：shell 在飞 → 边界武装检查、`shell.ended` **不再**快路径唤醒、检查到点 nudge；test 2〔快路径去重守卫〕删除；test 5 去 `shellTimeouts` 断言、留 `timeoutWrap` 改写断言）。

**129 边界**：本机沙箱实证（mock LLM，无外网凭据）；发布须用户当轮版本号 + GO。

## 41. 2026-10-20 修订（参考UI 在飞判据：子任务在飞 = 宿主 active map 的 "running"；修 1.1.3 僵尸锁死）

**现场**：1.1.3 上 129 生产——vllm sm70 dev goal 的门禁永久锁死：每个边界 `other:16` 全 hold（"in-flight (check-in armed)"），无边界唤醒，check-in 文案谎报 16 个后台项。16 = 该会话名下的僵尸 subagent 会话（数天前结束；/data/src/vllm-v2 + /data/vllm-origin 各 8，宿主 API + DB + shell store 三源核对无一生还）。

**根因（1.1.3 回归）**：在飞 = `time.idle` 缺失或 `time.idle < time.updated`（§40 信号）。僵尸会话的 time 字段陈旧 / 有迟到写入（updated 08:01 > idle 04:59，根会话同型）→ 谓词恒真 → 门禁永不开。§40 选该信号基于"idle >= updated + 终态 outcome = 完成"的假设；真机数据上完成侧会被迟到写打破，失效方向 = 永久锁死（§7.2 禁止的方向）。

**裁定（用户 2026-10-20）**：插件侧一切"时间窗 / 事件流猜活性"方案不接受（那是猜）——判据**参考 UI**：用 opencode UI 判定会话 active 的同一信号。

**宿主合同（2.0.32，二进制取证 + 129 活探 + 本机隔离宿主实证）**：宿主内存维护 `sessionID→status` 映射（`session.status(sid) = map[sid] ?? "idle"`；取值 idle/running/question）；UI 的 busy = `status === "running"` ∨ pending 非空；宿主自带 "N subagents running" 计数 = 其他会话中 `status === "running"` 的个数；HTTP 面 `GET /api/session/active`（location-scoped，x-opencode-directory 同 /api/session）→ `{data: Map<sessionID,{type:status}>}`——条目值是**对象**（隔离宿主实证 2026-10-20：回合中值 = `{type:"running"}`，回合后无条目；129 活探：僵尸子任务无条目，UI 正因此不显示它们 running）。

**改动**：
- **数据面**（`src/hostapi.ts` + `src/types.ts`）：新增 `activeSessions(locationDirectory)` → GET /api/session/active（sessionID→status；查询失败 = unavailable，同数据面其余）。
- **`controller.ts`**：`countSubtasksInFlight` = parentID 链归属（保留）∧ active map `status === "running"`（唯一活性判据：活 subagent——LLM 回合中或等长 shell/工具——其回合在执行中 = running；僵尸无条目 = idle 不计）。删除 time.idle/updated 推断。查询失败：sessionList/activeSessions 任一失败 = fail-open(0)（不变）。
- **口径（裁定）**：只数 "running"——"question"（等用户回答）/排队不计：子任务卡等用户不是后台进展，不锁门禁；与宿主自带 subagent 计数一致。
- **失效方向**：宿主真卡死 running → UI 同显，恢复 = 用户 UI 中断会话（宿主有 session.interrupt）→ 门禁与 UI 完全一致；无时间窗、无静默自动过期（那又是猜）。
- **不变**：own 侧（本会话 shell store 运行中 shell）、check-in 武装/触发/取消骨架、看门狗 tick、stall 阶梯、provider pause、预算、归属；`HostSession.time` 字段保留（兼容，不再做门禁判据）。

**测试**：`test/harness.ts`（probe 加 `activeSessions`；`setActiveSessions` / `failActiveSessions` 后端）；`test/background-gate.test.ts`（2c/22b 改 active running；23 改写为僵尸用例——parent 链 + `updated>idle`（1.1.3 在飞形态）+ 无 active 条目 → wake other=0，直接钉死 1.1.3 回归；24 改 running → hold other=1；新增 25 question 不计 / 26 active 查询失败 fail-open 是 wake 不是 skip；test 2 补 running 外部会话不门禁）。

**验证边界**：stub 套件 + typecheck = stub 层；实机 = `scripts/verify-active.ts`（本机隔离宿主，mock LLM）：/api/session/active 真实数据——idle 空 map、回合中 `{type:"running"}`、回合后无条目（钉非空形态——129 只活探过空 map）；**宿主杀进程重启**（同 env dir 二次拉起）——goal 记录 kv 存活、插件重载、新进程 active map 为空（僵尸锁跨重启不可能存活——1.1.3 数 DB time 字段则相反）、重启后第一个真实边界在**新 pid 决策日志**里真 wake（ownKnown:true、in-flight 0）。环境缺口（本次实测钉住）：隔离框架起的是 plain `serve`，**不写** service.json 注册文件（生产 `serve --service` 才写）→ 插件数据面 no-registry skip；verify 脚本 boot 后补写 `{url,pid,password}` 对齐生产（hostapi 按查询重读）。整循环实机证明（真子任务）= 发布后 129/208 重播 + nudge 日志观察。**边界（2026-10-20 复查确认）**：子任务发现与 active map 均 location-scoped（`x-opencode-directory` = goal 会话目录）——不同目录（如 worktree）的子 agent 会话对门禁不可见（归属语义 = 同 location，不变）。

## §42 队列输入门禁（2026-10-20 裁定；129 现场 incident 驱动）

**Incident（129 现场）**：用户消息在回合执行中发出 → 宿主把它排队（未投递）→ 回合结束的边界到达 → 门禁 in-flight 0（shell/子任务都不看 inbox）→ 注入 wake → **wake 排到用户消息后面进了队列**（UI 里 [GOAL] 出现在排队区，模型还没回用户的话）。违反不变式：**wake 绝不可能出现在排队中**（wake 只在空闲且无后台任务时注入）。根因：归因 ⑤ 把"回合中入队、尚未投递"的 user 条目当作 `last.kind === "user"` → "人在" → 立即 wake；门禁三查询（shell store / sessionList / active map）没有任何一个看 inbox。

**裁定（用户 2026-10-20）**：边界时还有排队的待发送消息 → 不唤醒（和在飞同方向）。

**宿主合同（v2.0.32 源码 + 实宿主 field 实证）**：`GET /api/session/:sessionID/inbox` → `{data: Item[]}`——全部 "durable enqueued session work **not yet delivered**"（user/synthetic/compaction/move 任意 kind，按 enqueue 序；投递后移除，空 = 无排队）。数据面 `hostapi.inboxList` 本就存在（原为 inboxCancel 配套），只是门禁从未调用。

**投递时序（field 实证：隔离真宿主 + 事件捕获 + /inbox 采样器 + mock 请求日志，6 轮）**：宿主把排队条目**消费进运行回合的下一个模型调用**（消费时刻与调用发起对齐——条目在该调用的消息快照里，从 /inbox 列表在发起时刻消失）。因此回合终边界处列表里通常只剩"该回合最后一次模型调用之后才入队"的条目——**final window**（宽度 = 最后一次调用的响应时长；mock LLM = 12s，真 LLM 通常更宽）。每回合调用数（mock 环境 2–14+ 次）与回合长度（24–168s）不可预测。`POST /interrupt?resume=true` **不** park 排队 user 消息：下一个 execution 按 FIFO 投递队首（实证：入队 8ms 后即 interrupt 的条目成为后继 execution 的 prompt；"queued prompts remain parked" 仅对 steer-scoped resume drain 生效）。推论：129 型 incident 要求用户消息恰在边界时刻仍未被消费（单模型调用回合的最后一段）——门禁正 hold 于此。

**改动**：
- `controller.ts` `inFlightSignal` 加 `queued` = `inboxList(sessionID).length`（任意 kind——任一未投递条目都意味着下一个 execution 即将开始）；查询与 shell store 同一 try：失败 = 宿主上下文死 → ownKnown=false → skip，**fail-closed**（看不见的队列不得打开 wake 路径；区别于子任务查询的 fail-open）。
- 门禁 = own + other + queued；决策日志加独立 `queued` 字段（hold/wake 都记）；hold reason 区分 `queued input (check-in armed)`（仅 queued 非零时）；check-in 计数/文案仍 background-only（own+other，排队消息不是"后台任务"）。
- 安全论证：任一未投递条目都会作为下一个 execution 被投递（更快：回合中间就被消费进模型调用，见上）→ 下一边界**保证**到达 → 此处 hold 不可能把循环弄静默；field 实证未观察到排队 user 消息"parked 不投递"（interrupt-resume 不 park，见上）——若未来宿主版本引入 parked 态，逃生阀 = check-in（armed 后 300s 静默必触发，语义不变）。
- **复查修正（2026-10-20，review finding C1）**：§7.1 (a) 例外（check-in 回复 → 正常仲裁）原先忽略 `queued`——最后 inbox 项是我们的 check-in wake 且用户消息落在 final window（echo 丢失、`lastInbox` stale）时，边界会 WAKE with `queued > 0`（129 incident 变体；provider-pause 重试 wake 同形状）。修正：例外让位于 `queued > 0`——hold + 武装 check-in（check-in 仍是 parked 态的逃生阀，上条语义不变）。stub = `background-gate.test.ts` 31；真宿主 lab 仍结构性不可达（final window 对 12s mock 过窄，见上）→ 生产 `queued` 字段观察。

**测试**：`test/background-gate.test.ts` 27（user 排队 → hold queued=1）/ 28（队列空 → wake queued=0）/ 29（synthetic 也门禁）/ 30（inbox 查询失败 → skip fail-closed）；`test/harness.ts` 加 `failInboxList` 脚本化失败口。

**验证边界**：stub 层 = 上述四用例（正向 hold + fail-closed 全覆盖）；实机 = `scripts/verify-active.ts` 第 5 相（重启后）：
- 5i：/inbox 真实形态钉死（raw fetch + 连续采样器，`{data: Item[]}`，queued 条目实时可见）。
- 5j：**129 不变式跨真实边界全程验证**——第 5 相的每条决策行都必须带 `queued`（number）+ `ownKnown:true`（= 门禁在**每个**真实边界都真查了 inbox），且**无任何 `wake` 行 `queued>0`**（wake 绝不可能落在队列里——129 incident 的不变式本身）。
- 5k：循环在连续边界上持续 wake（队列排干、无静默）。
- **正向 hold 在 lab 不可构造（field 实证，非代码缺陷）**：宿主循环语义 = "step 边界处 inbox 非空 → 继续发模型调用并消费条目"（纯回合 = 1×12s 单次调用；持续喂条目的回合实测 600s+/50+ 次调用不结束；`interrupt?resume=true` 也不 park——后继 execution 按 FIFO 投递，实证见上节）。因此 lab 里**任何**排队条目都会在终边界前被消费，"终边界处 inbox 非空"（129 形态）结构性不可达。该形态要求条目落在"最后一次模型调用之后"——生产真 LLM 回合的最后一次调用耗时秒至分钟、之后无调用（final window 宽），用户/模型消息落入其中是常态 → **129 生产重播 1.1.4 后观察 `decisions-<pid>.jsonl` 的 `queued` 字段与 hold 行 = 正向实机证明**。

## 43. 2026-10-20 裁定 — goal_next_step 下一步恢复（派发简报结构移植进 goal 循环）

**裁决来源（129 现场观察 → 源码取证）**：129 子任务会话出现自动"续派"消息（## 要做什么 / ## 判据 / ## 交付），子任务自我延续 45 分钟。源码取证（sst/opencode v2.0.32 `packages/core/src/tool/plugin/subagent.ts`）：宿主侧**无**自动机制——续派 = 主会话模型**自己**再次调用 `subagent` 工具（传 `sessionID` 续接 + 新 `prompt`）；宿主只做投递（`sessions.prompt`：idle → 启动 execution，running → steering 排队），完成汇报经 synthetic 消息反向回父会话（`subagent-completion.ts`）。简报内容 **100% 来自主模型在 dispatch 时刻的 LLM 输出**（上下文峰值时刻的当下综合：什么变了 → 下一步做什么 → 判据 → 交付）。用户裁定：主会话的唤醒也按这个形态来。

**关键洞察**：派发简报的可靠性来自**结构**——内容骑在**保证发生的动作**上（模型决定派活那一刻必带简报），而非可选仪式。我们的规则唤醒无法保证"回合末"有模型动作（回合结束形态多样：回完用户问题就停 / 派活去等 / 报错截断），但唤醒自身保证"回合首"有模型动作——所以综合步骤锚在**被唤醒回合的第一步**（由唤醒提示词指令），不靠模型自觉。

**设计（两分支 + 陈旧守卫）**：
- 新工具 `goal_next_step(text)`：模型记录"现状 → 唯一的下一步 → 怎么判"。同族门禁（goal.control 权限 + 非 terminal goal）；写入 `GoalRecord.nextStep {text, turn, ts}` 随记录 kv 持久化——**跨压缩、跨宿主重启存活**；terminal goal 拒写（值只在 goal 活着时移动）。
- 唤醒两分支（slim/full 都有，插在正文后、judge/wakeText 通道前）：
  - **情况 1（已记录且新鲜——`used.turns − nextStep.turn < 2`）**：回放 `Resume — your last recorded next step (turn N): <原文>` + "核对仍成立（变了就更新），然后执行"。
  - **情况 2（未记录 / 陈旧）**：`No recorded next step yet — first record one: goal_next_step(<现状 → 下一步 → 判据>), then execute it.`——一句同时完成"提醒生成 + 让它继续工作"：模型执行后下一边界自然进入情况 1（自愈闭环）。
- 陈旧守卫：记录落后当前 usage ≥2 turn = 上一轮没更新（典型：run 中重启丢了唤醒）→ 旧计划不可信，按情况 2 逼新综合。
- i18n 裁定沿用：模板英文；记录文本是用户内容，原样回放（任意语言）。

**改动**：`state.ts`（`GoalNextStep` + `GoalRecord.nextStep?` 可选字段——旧记录自然无该行）；`controller.ts`（工具注册 + `toolNextStep` + `nextStepUpdate`）；`wake.ts`（`buildWakeMessage` 两分支 + 陈旧守卫）；`scripts/verify-active.ts`（5l 相：mock 脚本化发一次 `goal_next_step` 工具调用——由唤醒文本的 record-first 行自身触发、自同步无竞态；5l-a = 真宿主把模型的工具调用派发给插件工具并持久化，5l-b = 下一边界唤醒文本真含 Resume 回放行）。

**测试（stub）**：`test/wake.test.ts`（回放分支 / record-first 分支 / 陈旧分支 / 行序 / CJK 边界 + 两个 pinned 模板更新）+ `test/goal-loop.test.ts` 8b（写入带 turn+ts、last-write-wins、坏输入、terminal 拒写、无 goal 拒绝）+ 10（12 个工具注册）/ 11（坏输入表）。

**验证边界**：实机 = `verify-active.ts` 5l（工具派发 + 持久化 + 回放全链路）；"模型自觉在回合末调用 goal_next_step"是 lab mock 不可控行为（mock 只回固定文本）——留 129 生产观察（重播 1.1.4 后：goal 会话是否自发维护记录、唤醒是否走 Resume 分支）。

**追加裁定（同日，唤醒头行三步裁定，最终形态）**：
1. **去帽**：头行 `[GOAL id | turn 3/10]` 的**分母（上限）删除**，只留裸计数器；full 档的 `Budget: 10 turns / unbounded tokens` 行同步删除（`buildWakeMessage` 的 caps 参数整个移除）。理由：可见的**使用率分数**（加上唤醒历史里 1/M..N/M 的递增序列）会被模型读成"额度快用完/上下文快耗尽"→ 终局行为（输出缩水、过早弱证据 goal_complete、不敢派新工作）。插件才是预算权威（cap → budget_limited 归档），模型不需要看见自己的倒计时。
2. **去 ID**：goal id 一并删除——模型的 goal 工具是**会话绑定**的（插件按 session 解析 goal，ID 不是工具输入），归因全部走文本外通道：消息 metadata `goalID`、决策日志、`goal_view` 输出。
3. **发言人标签 + 单一唤醒形态**（用户提议与裁定："内容不用重渲染——next_step 的内容是要的"）：头行 = 发言人标签 `[goal] turn-N:`（小写、连字符计数器，与自主条款行同段）；`wakeDetail` 选项删除，`buildWakeMessage` 不再接受 detail 参数。唤醒 = `[goal] turn-N: <自主条款行>` + next-step 段（record-first / Resume 回放，**保留——用户点名要**）+ 可选 judge/wakeText 通道。full 的 Objective/Progress/强制工具菜单重渲染整体作废：那些是**模型自己调工具生成的数据**（goal_set/goal_add_task），本来就在会话上下文里；compaction 后由摘要的 `[GOAL STATE]` 块携带。用户内容（objective/任务标题/记录文本）**逐字保留、不压平**——字段（`Progress:`、`  N. `、`Resume —`）本身是"新行 + 标记"，边界天然不混。spec §33 的 wakeDetail 历史保留，以本条为准。

作用域限定：**只动唤醒文本**——judge/compaction 通道（独立的模型调用，不同目的）、`[GOAL STATE]` compaction 锚、goal_set/goal_view 的展示（含 `goal_view` 输出里的 ID）保持原样。

**追加裁定（同日，暴露通道）：全部 goal_* 工具原生暴露（`codemode: false`）+ `goal` namespace 组注册（MCP-server 式），工具调用设计本身不变**
- 裁定来源（宿主源码深查）：`subagent.ts` L104 `options: { codemode: false }` 解释了子任务派发的"干净形态"——subagent 注册为**原生**工具（进模型请求的 OpenAI `tools` 数组，模型直接调用，会话记录是干净的工具芯片）；宿主 2.0.32 的 `@opencode/schema/tool` `Options` 带 `codemode` 字段。我们此前的 12 个 goal_* 工具注册未传该字段 → 默认 Code Mode 通道（模型只能经 `execute` 代码块触达，记录里是 execute 代码块形态）。用户裁定：既然 opencode 自己全是工具调用，**保持原工具调用设计**（两分支 next-step section、服务端 turn/ts 盖章全部不变），只把 `goal_next_step` 的注册改为 `codemode: false`（同日两度扩权：① 全部 12 个原生 ② namespace 分组 + 单组 transform 注册）。
- 设计：裁定两度扩权（同日）——① **全部 12 个 goal_* 工具都 flip 为 `codemode: false`**（最初裁"只 flip goal_next_step"被用户否决：一致性与记录洁净优先）。`registerTool` 透传 `codemode` 进 `options`+ ② **`goal` namespace 组注册（MCP-server 式）**：宿主 `Options` 带 `namespace`，工具 `effectiveName` = `namespace_name`（host `tool/runtime.ts` L278-281）→ namespace `goal` + 注册名去前缀（set/complete/.../next_step/...）= **模型可见名零变化**（展平后仍是 goal_set/goal_next_step/...），会话记录、wake 文本、129 生产数据无需迁移；共享 `GOAL_TOOL_OPTIONS`（gate + codemode + namespace）单一来源；**一个 transform 提交全组**（`registerToolGroup` = 一次 `ctx.tool.transform` 内多个 `e.add` = 一个 Registration：整组原子装卸、一次目录提交、坏条目只进宿主 registration errors 不连累同组）。`registerTool`/`registerNamespace`/`registerToolGroup` 透传进 `options`（types.ts spec 扩 `codemode?`/`namespace?`）。旧宿主兼容：字段被忽略（插件 ctx 是进程内工具编辑器，无编解码边界）→ 工具降级回 Code Mode-only，不丢失。接受代价：每个会话的模型请求 tools 数组多 ~1K token 工具描述（含非 goal 会话）；非 goal 会话误调用只得到 "no active goal"，无副作用。
- 效果：模型请求 tools 数组 12→24（12 内置 + 12 个 goal_* 展平名；goal 与非 goal 会话都可见；非 goal 会话调用即 "no active goal"，无害）；记录里是 `goal_next_step` 等芯片（part 存 namespace=goal + name=next_step，展示层展平；Code Mode 目录路径 `goal.<name>`）。
- 验证：stub = `goal-loop.test.ts` 10（**全部 12 个** `codemode:false` + `namespace:"goal"` + namespace 已声明）；实机 = `verify-active.ts` **5l-0**（宿主模型请求 tools 数组含全部 12 个 goal_*）+ 5l mock 脚本化原生 tool_call + 5l-a/b 不变（派发 + 持久化 + Resume 回放）；真 LLM 沙箱 `verify-nextstep-llm.ts`（模型直接原生调用，通过判据 A/B 不变）。129 生产种子（2026-10-20 04:27Z 起 seed 1792470397562）已验证重载与 tools 数组；单组 transform 版真宿主验证通过后再重播种（新 ts + nudge）。

## 44. 2026-10-20 裁定 — goal_next_step 复活终态 goal（新相位语义）+ 默认不限预算

**裁决来源（129 现场 → 用户裁定链）**：会话 `ses_ed179b5deffdcXDIjX3reJ1R8J` 的 goal `g_mvg7azbm_0`（四环收口，cap 250）05:09:30Z 正常 `goal_complete`（evidence 硬：1.068ms/72.2GB/s ×3 复核）并归档；用户随后给出新方向（"逮 NCCL 源码、赶上 1.39×"），模型惯性调用 `goal_next_step`（记录"虚拟通道"计划）→ 被拒 "no active goal"。用户裁定：**调 `goal_next_step` 时若会话最近一个 goal 处于非激活态，就重新激活它**；追问两轮后边界收敛为——**只有 `cleared` 不可复活**（用户的显式清除，模型不得推翻）；随后追加"默认情况下应该不限"，裁定为**默认不限轮次、不限预算**。

**复活状态矩阵**（`nextStepUpdate` 查本会话最近一个 goal 记录——active slot 恒为最新 goal）：

| 当前状态 | 行为 |
|---|---|
| `active` | 不变：照旧记录（turn = 当前 used.turns） |
| `completed` / `paused` / `blocked` / `stalled` | **复活**为新相位（见下） |
| `cleared` | 拒绝："was explicitly cleared — it stays terminal; … call goal_set with a new objective" |
| `budget_limited` | 拒绝："is budget_limited (used …; cap: …) — it stays terminal; … call goal_set with a larger budget" |
| 无记录 | "no active goal for this session — call goal_set first (only when the user explicitly asks for a goal)" |

**复活记账（新相位语义）**：`used` 清零 + `stalls` 清零（新相位拿满额 cap 预算，cap 本身不变）、`waitUntil` 清除（旧相位的 goal_wait 静默窗口不得随新相位走——否则"loop resumes"最长要等 60 分钟才兑现）、`providerPause` **保留**（provider 故障保护仍有效且自清除：到期 watchdog 重试唤醒）、旧 `evidence` 移入 `evidenceHistory`（追加，不清——后续再次 complete 不抹掉前段证据）、`blocker` 丢弃（stale blocker 不随新相位走，同 resume 纪律）、`reactivation = {from, at}` 盖章（供唤醒文案）、`decisions`/`continuations` 计数器**不清**（账要全）、刚记录的 next_step = 新相位 turn 0（turn = 记录时的 used.turns，沿用既有约定）。回复模型 "goal g_x reactivated (was <from>); next step recorded (turn 0) — the loop resumes"。

**安全性依据（用户追问"其余为什么都行"的回答，写入设计）**：终端 goal 永不被 wake——终态后模型回合只能由**外部事件**（用户消息 / subagent 回调）驱动，所以每次复活都被一次外部动作 gating，不是循环自驱；cap 仍约束每段相位的用量。`cleared` 与 `budget_limited` 例外：前者是用户对目标本身的否定，后者是**用户显式设的上限**被触了——两者都是"你的决定"，模型一个 next_step 不该推翻（`budget_limited` 的正确路径 = `goal_set` 更大 cap 的新 goal）。`goal_resume` 语义不动（paused/blocked/budget_limited 可 resume，completed/stalled/cleared 硬终端）。

**唤醒文案**：`buildWakeMessage` 在头行后插入**一行**复活上下文（仅当 `reactivation` 字段存在）：有前段 evidence → `Reactivated from <from> — prior phase ended: "<evidence>". That work is already done; pick up where it left off, don't redo it.`；无（从 paused/blocked/stalled 复活）→ `Reactivated from <from> — pick up where the goal left off.`。

**默认不限预算（配套裁定）**：`goal_set`/`/goal set` 不带 `--turns` 时不再落默认 10 turns——`cap = {}`（turns/tokens 均无上限，`isCapReached` 对缺失维度不比较）。`budget_limited` 从此只在**显式设限**的 goal 上触发；默认 goal 的寿命终结点 = completed / stalled（3 连停，judge 默认关）/ 用户 clear。`defaultCapTurns` 插件选项**保留**为显式 opt-in（正整数；非法值 = 不限，不再回落 10）；`defaultCapTokens`、`--turns/--tokens/--unbounded` 行为不变。渲染层无需改（`capText`/`budgetText`/`turnsUsage` 原本就有 unbounded 分支）。

**改动**：`state.ts`（`GoalRecord.evidenceHistory?` + `reactivation?`）；`options.ts`（`defaultCapTurns` 变可选、无默认、`numOpt` 解析）；`controller.ts`（`nextStepUpdate` 复活分支 + 三条文案 + goal_set/goal_next_step 工具描述 + USAGE 行）；`wake.ts`（复活上下文行）。`/goal resume`、judge、compaction、decision log 均不动。

**测试（stub，TDD 先红后绿）**：`options.test.ts`（默认 undefined / 显式 20 生效 / 非法 10.5 → undefined）；`goal-loop.test.ts` 1（cap `{}` + view "unbounded turns / unbounded tokens"）、8（cap `{}`）、8b（terminal 拒写改用 cleared 场景）、**8c**（completed/paused/blocked/stalled 四态复活：计数清零、evidence→history、reactivation 盖章、blocker 丢弃、nextStep turn 0）、**8d**（cleared/budget_limited 拒绝且记录不动）；`wake.test.ts`（复活行有/无两态 + 回放共存）；`compact.test.ts`（unbounded 渲染措辞 `0/(unbounded)`）。

**验证边界**：实机 = `verify-active.ts` 扩展相（真宿主：complete → 原生 `goal_next_step` → 断言复活记录 + 下一边界唤醒文本含复活行 + 默认 goal 的 view 显示 unbounded）；留 129 生产观察（重播后：129 会话里 completed goal 的 next_step 调用是否走复活分支、新相位 wake 是否带复活行）。

## 45. 2026-10-20 裁定 — 主 wake 文案去"安全"强调（129 现场 block 事件驱动）

**裁定来源（129 现场 → 用户裁定）**：goal `g_mvgb55bo_0`（会话 `ses_ed179b5deffdcXDIjX3reJ1R8J`，AR push 环复刻）在 6 个 wake 周期真实推进后，模型自行调用 `goal_block`（理由：context exhausted；state documented；next step recorded）。对模型自述"My context is essentially nil (~0.1%)"取证：**全程无 compact**（`time_compacting`/`summary_*` 全 null）、该轮 cache read ~896K——上下文不是"空"而是**近满**。耗竭信号真实，机制表述失真。用户裁定：既然已有**记录**（`goal_next_step`）与**流程**（stall 阶梯 / 用户消息覆盖 / 终态归档），wake 文案不用强调"安全推进"——"the next SAFE step"给了模型一个否决判据（不确定 → "不够安全" → `goal_block` 成为体面出口）。安全网在记录与流程里，不在提示词的字里。

**改动**（`buildWakeMessage` 唯一文本点）：`take the next safe step` → `take the next step`。`genuinely blocked` 保留——那是"真停"的 bar，不是逃生门；两个唯一点 + 用户覆盖条款不变。

**范围（有意不动）**：`backgroundCheckInText` 文案不改——其 "safe step" 绑定两个具体安全动作（核后台结果 / 独立推进），是动作菜单而非否决词，且该通道无 `goal_block` 菜单；provider-pause 重试文案不含 "safe step"。

**测试（TDD）**：`wake.test.ts` 主 wake 全文断言 ×2 改新文本（RED → GREEN）；check-in 断言不动，充当范围钉。全量 339/0 + typecheck。

**验证边界**：纯字符串常量——stub 层齐；真宿主上以**下个版本种子**生效（129 现种子仍旧文案）。观察点：模型在低置信状态（上下文近满、无 compact）是否仍找"安全理由" block。诚实注记：本次 129 案例本身是 6 轮推进后的正当终态（block 理由成立），本裁定是**预防性**的，不是已证因果事件的修复。

## 46. 2026-10-20 裁定 — 129 block 状态丢失 incident 的插件侧收口：fail-closed 写入 + watchdog 唤醒日志（取证驱动）

**裁定来源（129 现场取证）**：同会话上 `g_mvgb55bo_0` 的 06:49:22 `goal_block` 被插件确认成功后，06:56:58 `goal_next_step` 读回 **active/turn 7**（普通分支而非复活分支）——block 状态在插件读取的存储层丢失。用户随后观察到一条"挂在发送队列"的自动唤醒消息（已随手删除，物证灭失）。代码审计三结论：① 边界仲裁 wake/hold/skip 全部必留 decisions 行、且日志停在 06:49:15 → 该消息**不是**边界唤醒；② 边界遇终态 goal 静默 return（by design，不写行）；③ **watchdog 路径（check-in / provider-pause 重试）不写任何决策行**——唯一"有消息、无日志"的注入路径。check-in 于 06:34:31 武装（due 06:39:31，错过后 pending），其触发条件 = goal 读回 active → **check-in 能发出本身就是状态翻转的直接证据**（大概率即用户所见消息）。

**改动**：
1. **`saveGoal` fail-closed**（`controller.saveGoal`）：原实现 `storageSet` 抛异常时 catch→warn→**`return true`**（写失败当成功）——正是"block 报成功但没落盘"这一缺陷类别的温床。现写失败返回 `false`；命令/工具面的终态转换（block/complete/clear/next_step）一律回 "changed underneath"（绝不假成功）。loop 内路径（wake/check-in）保持 best-effort 容错不变（写失败不毁循环）。
2. **watchdog 唤醒补决策日志**（`deliverWatchdogWake`）：新增 `reason` 参数（`watchdog check-in (in-flight N)` / `watchdog provider-pause retry`），入队成功后写一行 `decision:"watchdog"`。此后**插件注入的每条消息必留一行 decisions**。
   - 次序约束（回归教训）：日志写必须放在 `saveGoal` **之后**——fs 写插在 tick 的 load→save 之间会拓宽 CAS 竞态窗口，边界方的 stalls 增量会输掉丢写（`watchdog.test.ts` 3 实证回归后修正）。

**测试（TDD）**：`goal-loop.test.ts` 14f（storageSet 脚本化失败 → goal_block 回 "changed underneath"、存储原样不动，RED→GREEN）；`background-gate.test.ts` 32（check-in 触发后决策日志末行 `decision:"watchdog"`、reason 含 check-in，RED→GREEN）。全量 341/0 + typecheck。

**边界（未解）**：状态翻转的根因在宿主 `ctx.storage` 层——磁盘 kv 停在 10-17、活 goal 记录不在盘上、插件当天热重载多次——持久化时机 / 热重载多实例命名空间待宿主存储合同取证（todo #253）。本节两项是独立的插件侧缺陷与可观测性收口，不是根因修复；根因定位前不得汇报"129 incident 已修"。

## 47. 2026-10-20 裁定 — /goal resume 去掉显式 re-wake（"命令已 resume，还 re-wake 干嘛"；129 双消息驱动）

**裁定来源（用户 2026-10-20 当轮）**：129 重启后用户一次 `/goal resume` 产生两条"唤醒"消息（"2 条唤醒消息到了队列"），用户裁定："我都调用命令去 resume 了，还产生什么 re-wake 之类的东西干嘛？"——resume 不应再注入显式 re-wake。

**取证**：`/goal resume` 一次操作产生两条**都能触发执行**的消息——
1. **显式 re-wake**（`resumeGoal` 的 `injectWake`，delivery:queue 排队）。kv 证明全程只注入这一条（`continuations` 只 +1）。
2. **命令结果行**（`handleCommand` 自动记录的 goalControl synthetic "goal ... resumed (active)"）。宿主 `sessions.synthetic` 默认 delivery=steer 且无条件 `execution.wake`（2.0.32 / 2.1.0 一致）→ 结果行本身即踢起模型 turn。

结果行先踢掉 turn（模型首句"goal is resumed/active, now I can run the post-reboot script"即对着结果行说的），显式 re-wake 挂在队列等下一轮 → 用户看到"2 条唤醒"、手动删掉多余那条（否则多触发一轮冗余 turn）。`/goal set` 无此问题（`setGoal` 不注入显式 wake，只靠结果行那一条）。

**改动**（`resumeGoal`，`controller.ts`）：去掉 `await this.injectWake(goal)`。命令面 = 状态变更 + 结果行（宿主 steer+wake 即 kick）；工具面 = 模型本就 mid-turn，边界在下一轮 end 时按 active goal 正常唤醒。stale blocker 清除 / stalls 清零逻辑不变。

**关联（129 "block 状态丢失" incident 重新诊断，memory #12320）**：更早的 14:49 incident 根因**非宿主存储层**——是 §15-9 user-inbox auto-resume（14:55:42 用户消息触发 blocked→active + re-wake，设计行为）+ 该路径 re-wake 无 decisions 日志（用户所见"幽灵唤醒"即此）。宿主存储层取证（kv 即时 upsert / 单 db / live-slot 守卫）均正常 → §46 的"根因在宿主 ctx.storage"暂定被取代，根因已定位（插件设计行为 + 可观测性缺口）。

**测试（TDD）**：`goal-loop.test.ts` 16/17/20 改断言 resume **不产生**任何 prompt（RED→GREEN）。全量 341/0 + typecheck。

**边界（未解）**：(B) user-inbox resume 路径（`controller.ts:841`）的 re-wake **无** decisions 日志——"有消息、无日志"缺口仍在（watchdog 那条已由 §46 覆盖）；(C) §15-9 "任意用户消息复活 blocked goal" 语义（14:49 incident 源头）是否过激进、是否收紧为显式 resume——待用户裁定。

## 48. 2026-10-20 裁定 — 终态/暂停通知改为纯记录（`resume:false`），不再触发宿主 auto-wake

**裁定来源（用户 2026-10-20 当轮）**：全面梳理"触发唤醒的场景"时发现 5 条终态/暂停通知（completed / blocked / stalled / budget_limited / provider-pause）是 `probe.synthetic`（goalControl 记录），而**宿主对每条 synthetic 都 auto-wake**（默认 delivery=steer + 无条件 `execution.wake`，2.0.32/2.1.0 一致）→ 每次 goal 走到终态都**额外踢一轮**让模型读"goal X …"。用户裁定"这个有什么意义？？？"——记录有意义、kick 无意义（provider-pause 那条还把注定失败的请求又打一次），改。

**根因（为何活过"简化"）**：设计上这些就是纯记录——`test/arbiter.test.ts` 4c 明确钉"goalControl synthetic → record only, no wake"。但 **harness 把 `synthetic` 建模成 no-op**（`test/harness.ts` 只 push、不 wake），真宿主却 auto-wake → 偏差在 stub 里不可见、只在 129 真宿主上爆（resume 双消息是它第一次咬人，本节 5 条是同一条潜在路径）。`probe.synthetic` 适配器（index.ts）也原本没转发 `resume`（宿主明明支持）。

**改动**：
1. `SyntheticInput` 加 `resume?: boolean | null`（对齐宿主 `SessionSyntheticInput.resume`），`index.ts` 的 synthetic 适配器转发 `resume`。
2. 5 条终态/暂停通知传 `resume: false`——`notify`（judge complete / judge blocked / stalled 三条）+ `budget_limited`（boundary cap）+ `provider-pause`（每 incident 一次）。记录照旧落 transcript，宿主不再 kick turn。
3. **命令结果行（handleCommand）不传 resume（保留 kick）**——`/goal set` / `/goal resume` 的结果行 kick 是有意的触发（§47 去掉显式 re-wake 后正靠它）。

**测试（TDD）**：`arbiter.test.ts`（budget_limited / provider-pause）+ `judge-integration.test.ts`（complete / blocked / stalled）断言对应 synthetic `resume === false`（RED→GREEN）。全量 341/0 + typecheck。

**边界（未解）**：
- **stub 层无法真验证**：harness 的 synthetic 是 no-op，"改后不再 kick"只能在**真宿主**确认（改前终态通知真会起 turn、改后不起）——纳入发布前真宿主验证批（与 §45/§46/§47 同批）。
- **harness 硬化（建议）**：把 `synthetic` 改成真宿主语义（steer + 无条件 wake，除非 resume:false），否则这类"记录被宿主 kick"的偏差 stub 永远抓不到。
- **B1 残留（待裁）**：`/goal view` / `pause` / `block` / `clear` 命令的结果行也在 auto-wake（白踢一轮）；set/resume 的 kick 是有意的——是否把非 set/resume 的结果行也压成纯记录，用户未定。

## 49. 2026-10-20 裁定 — harness 硬化落地（A+B）+ kick 归属精化 + post-resume budget grace + §15-9 resume 日志

**裁定来源（用户 2026-10-20 当轮，依次）**：§48 残留项（harness 硬化 / B1 残留）收口——用户先委托"插件侧四项优化"全部（harness 保真 / 结果行 kick 归属 / §15-9 日志 / 收紧 §15-9），随后撤销第 4 项（"用户发消息就触发 resume 这个不用改，保持"）；harness 保真先裁定 A+B 双管（A=唤醒记账、B=事件流保真）；实现暴露 B 的副作用后（见下），三选一裁定**"保持 A+B 且修 plugin"**（A only / 保持 A+B / 保持 A+B + plugin 修复）。

**§49-A harness 硬化（A+B，兑现 §48"harness 硬化（建议）"）**：
- **A 记账**：`h.wakes`（`resume !== false` 的 synthetic 列表）——"一条记录即将踢 model turn"的唯一断言面：终态场景 `h.wakes` 应为空。
- **B 事件保真**：harness `synthetic` 对每条非 `resume:false` 记录真驱动一个 `started+succeeded` turn，走完控制器完整边界仲裁——忠实建模宿主无条件 `execution.wake`。
  - 必须 **awaited** 而非 fire-and-forget：FG 版实证挂死 `stop()`（turn 的边界在飞，loop 调 next() 后等到已被 stop 移除的 consumer）。
  - 依赖不变量：非 `resume:false` 的 synthetic **只来自 external command context**（set/resume 结果行——宿主 command dispatch / 测试 commandExecutor）；事件循环内的路径（终态通知 / budget / provider-pause）全传 `resume:false` 不触发。将来若有 wake 路径 synthetic 从 loop 内发出，此处会死锁（注释已钉）。
  - 次序推论（`handleCommand`）：`lastInbox=control` 必须先于 synthetic 设——awaited 自动 turn 的边界在 `probe.synthetic` 之内运行，归因晚设会让边界看到非 control lastInbox、错误 stall/wake（实证 57 失败，前置后归零）。
  - 自动 turn **不是** no-op：它的边界真跑（re-budget / recordHandled / saveGoal）——这正是 B 的目的（忠实），也暴露了 stub 一直藏住的不一致（见下）。
- **B1 残留收口**：非 set/resume 命令的结果行（view/pause/complete/block/clear/history/task + 全部失败路径）传 `resume:false`——纯记录，不再白踢。

**kick 归属精化（kick-on-success）**：`cmdSet` / `setGoal` / `resumeGoal` 改报 `{text, ok}`——
- 被拒 set（R7：goal 仍非终态）/ set 参数错误 / 失败 resume（无 goal / already active / 硬终态）→ `resume:false` 纯记录：拒绝没有可干的事，不该白踢；R7"拒绝后 goal 精确不变"原样保住。
- 成功 set / 成功 resume → kick（§47 机制）。
- 工具面（goal_set / goal_resume）不动（模型本就 mid-turn，无 kick）。

**plugin 新行为 — post-resume budget grace（B 副作用收口）**：
- **暴露（test 17，stub 藏住的不一致）**：`budget_limited` + `/goal resume` → resume 成功 active，但 resume 结果行自己的 kick turn 跑一次边界 → cap 仍耗尽 → **立刻 re-limit 回 `budget_limited`**——resume 变成无效操作。真宿主会**真实地**这么发生（结果行真踢 turn）：§11 裁定（budget_limited 可 resume 且 resume 后 active）在真机上兑现不了，该不一致一直被 harness 的 no-op 建模藏着。
- **修复**：`GoalRecord.budgetGrace?: boolean`——`resumeGoal` 从 `budget_limited` 恢复时授予一次性豁免；边界预算重检 cap 命中且有豁免 → 消耗豁免（decisions 日志 `decision:"hold"`，reason `post-resume budget grace consumed …`）、继续正常仲裁；无豁免 → 现状 `budget_limited`。语义 = "resume 买一次完整工作的机会；下一轮仍触 cap 照旧 limit"。
- 工具面（goal_resume mid-turn）同路径：豁免在自然 turn 边界被消耗，无特殊处理；工具描述同步更新。

**§15-9 用户消息 resume 日志（收口 §47 未解项 (B)）**："用户 inbox 消息复活 blocked goal"（`controller.ts` §15-9 块）的 re-wake 原无 decisions 日志（"有消息、无日志"）。现 `injectWake` 前写一行 `decision:"wake"`（reason `user message resumed blocked goal (§15-9)`），与 §46 watchdog 行同构。**§15-9 任意用户消息复活 blocked goal 的语义本身保持**（用户撤销了收紧项）。

**测试（TDD 全程先红后绿）**：
- `goal-loop.test.ts`：**1d**（kick 归属：set/resume kick，view/pause/history/complete 纯记录）、**1e**（A+B：set 结果行 `h.wakes` +1 且自动 turn 真被处理——`lastHandledEventID` = `awake_N_e`；终态通知不加 wake）、**1f**（kick-on-success：被拒 set / already-active resume → `resume:false`）、**19**（grace：resume 后保持 active，下一个 over-cap 边界照旧 re-limit——一次性）
- `arbiter.test.ts` **5b**：`lastHandledEventID` 期望由 `undefined` 改为自动 turn 的 ID（`/^awake_\d+_e$/`）——无 ID 边界不记自己的 ID，残留的是 kick turn 的 ID（§49 前为 undefined）。
- `judge-integration.test.ts` **4**：§15-9 resume 后 decisions 日志有 §15-9 标记的 wake 行。
- 全量 345/0 + typecheck。

**验证边界（2026-10-20 已验）**：隔离真宿主（`scripts/verify-wake.ts`，lab LLM `Qwen3.8-27B`）五断言全 PASS：① set 结果行真踢 turn（事件流 `session.execution.started` +1，§47 机制真机存活）；② view 结果行 25s 窗口零新 turn（§48/§49 B1 收口）；③ `budget_limited` 终态通知零 kick（§48 核心主张——修复前宿主必白踢一轮）；④ resume 自 `budget_limited` 保持 active，其 kick turn 的边界消耗 grace，decisions 日志实得 `decision:"hold"` 行（§49，修复前真宿主必被立刻打回）；⑤ grace 一次性，下一个 over-cap 边界照旧 re-limit（全程恰好 5 turns，无模型干预）。§45 纯字符串常量（stub 层齐）；§46/§47 的 129 生产观察项属发布后动作，不受本批影响。实证注记：宿主 command 端点返回 **204**（非 200）；lab 模型对模糊目标会自发 `goal_complete`（模型合规性，验证脚本用"永不完成的倒计时"目标 + 禁 tool 提示规避）。

## 50. 2026-10-21 裁定 — §49-rev（用户命令结果行恢复 kick）+ 事件循环自愈（129 sm70 incident 根治）

**裁定来源（用户 2026-10-21）**：129 "vllm sm70 dev" 会话 goal 停摆 ~4.5h（19:14Z turn 正常结束后插件事件订阅静默断流，宿主 2.1.1 零 ERROR；7 次热重载因 `subscribe()` 从 live head 起而全部无效）。用户用 `/goal view` 试图查看状态——**无任何 UI 显示**。排查链（全只读取证 + 2.1.1 上游源码）：① 宿主 `resume:false` 的 synthetic 只进 `session_inbox`，**永不晋升 `session_message`**（UI 时间线数据源）→ §49 的"记录行留在 transcript"对用户不可见（2.0.x→2.1.x 渲染/晋升行为变化）；② 插件 `runLoop` 对迭代器 `done` **静默永久退出**（零日志）、对 `throw` 退出且**从不重订阅**→ 任何一次瞬断 = 永久失聪（宿主断流只是引信，插件无自愈才是 4.5h 冻结核因）。用户裁定："可以"——两件都做。

**§49-rev（用户命令结果行恢复 kick）**：所有用户 `/goal` 命令结果行（set/view/pause/complete/block/clear/history/task + 拒绝/失败/未知子命令/usage/异常路径）恢复 kick——**模型的可见回复是唯一用户可见输出**（2.1.1 下记录行不可渲染）。§48 的 5 条机器发起的终态/暂停通知保持 `resume:false` 纯记录不变（无人在等，不白踢）。kick turn 的边界按 control 语义不链式再唤醒（parked 循环不被命令重启，stub T4 钉死）。

**§50-A 事件循环自愈**：
- **重订阅**：`runLoop` 迭代器 `done`/`throw` → 大声日志（done 路径原为零日志）+ 新订阅（≥1s 回退防 hot-loop；**循环内迭代器变量替换**——首版 bug：resubscribe 新建了订阅但循环仍轮询死迭代器，空转风暴，TDD 抓到）。
- **全局 liveness 定时器**（30s 扫描，默认静默窗 5min，deps 可注入）：**故意不挂 per-goal watchdog**——watchdog 在 `execution.started` 时止表，而致命形态（sm70）正是"started 已见、terminal 丢失"→ 无人重武装。规则：`lastEventAt` 静默 > livenessMs 且某会话 `turns.active=true`（我们看到的 started 没有对应 terminal）→ 强制重订阅 + 按 `session.idle` 重跑边界仲裁（arbitration 自带 in-flight 门：真在跑的 turn 只会 hold，不会误 wake；误报成本 = 一次 hold 边界，漏报成本 = 此前的 4.5h 静默）。

**宿主侧待办（插件无法自修，另行跟进）**：① 2.1.1 事件流在长 turn 窗口内静默终止的死因未钉（无 ERROR 日志；候选：desktop-ssh 隧道/bus scope 生命周期）；② `resume:false` 记录行不渲染（若宿主修复，§49-rev 的 kick 可再收紧，但当前保留——可见性优先）。

**测试（TDD 全程先红后绿）**：
- 新增 `stream-heal.test.ts`：T1 流死→重订阅→新管道收事件（`lastHandledEventID` 推进实证）；T2 **sm70 形态**——turn started 后 terminal 丢失 → liveness 重查 → 补发被丢的 wake；T3 parked goal 不被 liveness 误唤醒（零新 wake/check-in）；T4 `/goal view` kick 可见回复 turn 且不链式再唤醒。
- `goal-loop.test.ts`：**1d/1f 翻转**（所有命令结果行 kick，含拒绝/失败）；**2**（R7 断言放宽：拒绝 kick turn 的边界可推进 `lastHandledEventID`——传输记账，非 goal 变更）。
- harness：kick auto-turn 的 await ack 加 500ms 界（事件循环被长 await 阻塞时——judge pending——不再死锁 command handler；正常路径仍是微任务级，确定性不变）。
- 全量 349/0 + typecheck。

**真宿主发现（2026-10-21 verify-wake 首跑失败，decisions-2420 实锤，两修后全 PASS）**：
- **busy-steer**：2.1.1 对运行中会话的 command/synthetic/prompt 做 STEER（吸收进运行中 turn，不产生新 `started`、不排队成独立 turn）。首跑中 B（view kick）撞上运行中的 set-kick turn，被 steer 的项以 `type:"user"` 投递且未命中 isControl 原判据（要求 `itemType==="synthetic"`）→ `lastInbox` 误翻 user → set-kick turn 边界**误 wake**（决策行 `00:14:02Z decision:"wake"` 实锤），白烧掉 goal 唯一预算 turn → C 阶段 prompt 又被 steer 吸收 → 计数全线错位（C0/C1/E 三 FAIL，goal 状态推进本身正常）。
- **修复 A（插件）**：`isControl` 判据改为**只看 `metadata.goalControl`**（宿主投递的 item 类型不可信——record 行 `type:"synthetic"`、被 steer 的 kick 行观测到 `type:"user"`）；stub 1g 钉死（user 型 + goalControl → control，边界零 wake）。
- **修复 B（验证脚本）**：busy-steer 是宿主契约，验证批每个阶段先用 active map（`GET /api/session/active`，`host.ts` 新增 `sessionActive()`）等会话非 running 再发命令/prompt（A2/B2 idle 门）——turn 计数断言因此确定性成立。
- **投递形态取证（保留现场 event 流，正则统计）**：命令结果行 synthetic 一律 `type:"synthetic"` + `metadata:{goalControl:true}`（5 条）；注入 wake 与用户 prompt 为 `type:"user"`（wake 带 `goalWake` metadata，3 条）。

**验证边界（2026-10-21 已验）**：隔离真宿主（宿主 2.1.1，lab LLM `Qwen3.8-27B`）两条批全 PASS：
- `verify-wake.ts` 12/12：① set 结果行真踢 turn；② **view 结果行真踢可见回复 turn（§49-rev 核心断言）**；③ `budget_limited` 终态通知零 kick（§48 不回归）；④ resume 自 `budget_limited` 保持 active、grace 消耗留痕 `decision:"hold"`（§49）；⑤ grace 一次性 re-limit（**C1 恰好 4 turns**：set kick + view kick + prompt + wake；**E 恰好 6 turns**：+ resume kick + prompt——view kick 计入 ladder，全程无模型干预）。
- `verify-heal.ts` 5/5（**§50 自愈真宿主证据**，探针 `OPENCODE_GOAL_KILL_STREAM=1` 在首个 turn 开始处自杀一次订阅 = 129 死法的受控复现）：H1b 断流 + done 路径 `event stream ended — re-subscribing` 日志实锤（宿主 stdout）；H2 新订阅收到后续事件（prompt turn 启动）；H3 新订阅上的边界注入 wake（决策日志 `decision:"wake"` 行——129 症状"零决策行"的反例）；H4 循环自治到 `budget_limited`（3 turns）。liveness 重查（5min 静默窗）为 stub 层验证（stream-heal T2 的 sm70 形态），真宿主 5min 窗口不适配脚本时长，不硬凑。

