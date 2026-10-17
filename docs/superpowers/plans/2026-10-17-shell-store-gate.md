# Shell Store Gate 实施计划（精简版）

> 根因（#12138）：宿主 2.0.32 对**后台工具 shell 不发** `session.shell.*` 事件 → 门禁 in-flight 恒 0 → 边界立即唤醒（129 实机死循环实证）。修复：在飞计数改查宿主 shell store（`shell.list`，location 作用域，条目带 `metadata.sessionID`）。

## 改动（全部）

1. **`index.ts` + `src/types.ts`**：probe 加 `shellList(locationDirectory)` = `callRpc("shell.list", { location: { directory } })` + 归一化（`metadata.sessionID`、`status`；字段缺失容忍，RPC 级失败上抛）。
2. **`src/controller.ts`**：`inFlightCount` 的 shell 部分从 `goal.waitingShells.length` 换成查询结果（`status=="running" && sessionID == 本会话` 计数）+ 既有 `activeSessions`（子任务，不动）。查询失败 → 按在飞（武装进展检查 + warn-once，安全方向）。(a) 例外、stall 阶梯、quiet 窗、byte 文案、事件路径（前台/API shell 的 exit wake 与活动取消）全部不动。`waitingShells` 保留为事实锚，不再是门禁输入。
3. **测试**：fake probe 加 shellStore（事件同步维护，镜像宿主）；新增 3 用例：本会话 running→hold；同目录他会话 shell→不计（立即唤醒）；查询失败→按在飞。
4. **本机一次性宿主验证**（129 不做测试台）：本机第二 opencode 实例（隔离 config 目录 + 端口 + 空白测试目录），小 `checkInDelaySec`，**模型真实后台 shell**（原始 bug 场景）→ 边界 hold → 到期一条进展检查 → 宿主完成通知；无 5 秒死循环。版本对齐：本机 2.0.22 先证模式；2.0.32 本机可得后（用户升级桌面应用/提供二进制）复验同版本。129 仅在用户"发"之后做最终播种 + 日志观察。
5. **收尾**：spec §7.3 一段 + README 限制节两行 + 台账 + 记忆。

## 约束

英文自产文案；TDD（先红后绿）；基线 247 pass / 0 fail / 887 expect，`bun run test` + `bun run typecheck` 全绿才完；版本保持 1.0.6（1.0.7 待用户"发"）；129 远程一律脚本文件。

## 契约（已钉死，2026-10-17 离线取证，零生产变更）

2.0.32 二进制 grep 证据（contract-scan-129.sh）：
- 方法名 `shell.list` 与实机验证过的 `session.inbox.list` 同属 jn 注册族 → 插件进程内通道可 `callRpc("shell.list", {location:{directory}})`，直接参数约定（同 inbox 的 `{sessionID}`，无 params 包裹）。
- HTTP 面 "RPC is unavailable: shell" 是**另一通道**（该面只派发插件注册的 RPC id）——此前误读来源，已澄清。
- 返回 = 条目数组 `{id,status,command,cwd,pid,file,metadata.sessionID,time.started}`；"Exited commands are not included" → 列表本质 running-only，store 自动剔除。
- 门禁语义：`metadata.sessionID == 本会话` 的条目 = 本会话在飞后台 shell。

残留风险：无（通道+方法名+形状三证齐备；查询失败仍保留"按在飞"安全方向）。
