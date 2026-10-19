# Plan — 化繁为简：in-flight 门改查询式 + 删冗余事件机制

Bug: subtask 在飞靠 `activeSessions` 事件缓存发现（`other`），跨宿主/无事件时恒 0 → 无限唤醒
（ch2.AI 现场 56 条 `other:0`）。根因叠加：宿主 `ctx.session.get` 不返回 parentID，`isSubtaskOf`
在真机上永不命中；`toolCalled` 把 stalls 清零放大了循环。

目标（用户裁定）：只在会话 idle 时查一次接口（shell + 子任务在飞）；没有在飞→唤醒；有→武装
一次性延时检查；后台完成→goal 自动恢复→取消计时；到点仍在飞→nudge。删除冗余事件机制。

## 已验证（真实宿主 / 沙箱）
- `GET /api/session`（列表）跨宿主可见子任务，带 `parentID` + `time` + `outcome`（同源页面）。
- 在飞信号：`time.idle` 缺失，或 `time.idle < time.updated`（多回合稳健，无阈值）；完成 = `idle >= updated`。
- `GET /api/shell` 已查询式（own），不变。

## 改动
1. **types.ts**: +`HostSession`；WakeProbe +`sessionList(): Promise<HostSession[]>`。
2. **hostapi.ts**: +`sessionList()` = GET `/api/session` + `normalizeSessions`；加进 interface + return。
3. **index.ts**: probe 装配 +`sessionList`（unwraps hostapi）。
4. **state.ts**: −`waitingShells`。
5. **controller.ts**:
   - `inFlightSignal`: `other` 改 `countSubtasksInFlight`（`sessionList` + parentID 链 + 在飞判定）。
   - −`activeSessions`（field + 3 处）、−`isSubtaskOf`、−`onShellStarted`/`onShellEnded`/`shellExitText`、
     −shell 事件 case（766-785）、−`waitingShells` 用（1845/2418）、gate 注释更新。
   - 保留 checkinDue/watchdog/deliverWatchdogWake（计时骨架）。
6. **harness.ts**: probe +`sessionList`；`setSession` 扩展 `time`/`outcome`。
7. **background-gate.test.ts**: 子任务用例（2c/22/22b）不再依赖 `emit(started)` 发现，改靠 sessionList；
   新增回归用例（子任务在本宿主无事件也应 gate）。
8. **watchdog.test.ts**: shell.ended 不再触发"结果唤醒"（快路径已删）→ 更新 test 1/2。

## 不改动
- stall 阶梯 / provider pause / 预算 / 归因（本次不动；stalls 清零放大器另议）。

## 验证
- `bun test`（322 用例，含改动）全绿；`bun run typecheck` 全绿。
- 发布须用户当轮版本号 + GO。
