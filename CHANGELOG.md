# Changelog · 版本记录

约定（2026-10-20 裁定）：
- 在途版本记 `## [Unreleased]`；发布时（与 version bump 同批提交）把内容移到 `## [X.Y.Z] - YYYY-MM-DD`（日期 = 发布日）。
- 每个版本章节必须有内容——CI 硬门：打 tag 的版本找不到非空章节 = 发布失败（npm publish 之前，fail fast）。
- 章节三段结构：`### 新增`（新功能/新工具/新命令）、`### 修复`（修了什么，含 incident 来源）、`### 优化与设计`（架构/行为变更/设计裁定）；可加 `### 验证`。
- npm publish 成功后，CI 自动创建 GitHub Release：标题 `vX.Y.Z`，正文 = 本章内容（重跑幂等 edit）。

## [Unreleased]

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
