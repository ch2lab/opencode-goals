# Changelog · 版本记录

约定（2026-10-20 裁定）：
- 在途版本记 `## [Unreleased]`；发布时（与 version bump 同批提交）把内容移到 `## [X.Y.Z] - YYYY-MM-DD`（日期 = 发布日）。
- 每个版本章节必须有内容——CI 硬门：打 tag 的版本找不到非空章节 = 发布失败（npm publish 之前，fail fast）。
- 章节三段结构：`### 新增`（新功能/新工具/新命令）、`### 修复`（修了什么，含 incident 来源）、`### 优化与设计`（架构/行为变更/设计裁定）；可加 `### 验证`。
- npm publish 成功后，CI 自动创建 GitHub Release：标题 `vX.Y.Z`，正文 = 本章内容（重跑幂等 edit）。

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
