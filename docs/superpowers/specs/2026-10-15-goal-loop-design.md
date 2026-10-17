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
- 待办上限 50 条（与先例一致）。

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
- **两个例外保持正常仲裁**（§7.1 语义不变）：(a) 最后一条 inbox 是本插件看门狗唤醒 → 模型对进展检查的回复按 §8 stall 阶梯正常计数；(b) `goal_wait` 的 `waitUntil` 窗内一切静默（不唤醒、不武装、不数 stall）。
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
