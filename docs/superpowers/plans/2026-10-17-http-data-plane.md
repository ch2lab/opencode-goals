# HTTP 数据面 + 权限拆分 实施计划（精简版）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans 或 subagent-driven-development，逐任务执行，checkbox 跟踪。

**Goal:** 在 2.0.32 宿主上，把门禁/inbox 数据面从死的进程内 RPC 通道迁到 HTTP client 面（页面版本同路：`service.json` 注册文件发现 + Basic 鉴权），权限沙箱改"读放行、只限写"，决策日志文件化，假计数清零。

**Architecture:** in-process ctx 保留 event/prompt/generate/storage/permission/command 面；新 `src/hostapi.ts` 提供 shell store + inbox 查询（每次查询重读本地服务注册文件、`pid === process.pid` 自识别、失败降级为三态信号 `ok/unavailable`）。controller 消费三态信号写决策日志。`ctx.rpc` 只留出站（`goals.get` widget 预留，本次不动），`callRpc` 死通道整条删除。

**Tech Stack:** TypeScript（bun 测试/运行），零新依赖（`node:fs`/`node:os` + 全局 `fetch`），TDD。

**Spec / 依据：**
- `docs/superpowers/specs/2026-10-15-goal-loop-design.md` §7（看门狗/门禁语义不变）
- 2026-10-17 本会话裁定：通道划分、HTTP 数据面、pid 自识别、三态信号、读放行/只限写、**区分不了就不限**、失败不再假报"1 在飞"、**查询失败=会话上下文死亡：写日志+skip（不唤醒、不武装 check-in），复活会话不是插件的活；"接口正常时查询必成"由 T2（Task 5）实机兜底**
- 契约（全部本机 2.0.32 实证）：注册文件 `%USERPROFILE%\.local\state\opencode\service.json` = `{id,version,url,pid,password}`（XDG_STATE_HOME 可覆盖，二进制 `h()` 函数证实）；鉴权 = `Basic base64("opencode:"+password)`（client dist 实证）；`GET /api/shell` 200 真数据；`GET /api/session/:id/inbox` 路由通（假 ID → 结构化 `SessionNotFoundError`）；in-process `ctx.rpc` 是"宿主调插件注册域"通道（日志实证 `/api/rpc/experimental.browser/attach`），宿主服务不在其注册表 → `callRpc` 恒死

## 全局约束

- 版本保持 1.0.5；不发布、不 bump、不碰 registry；129 不碰；用户活配置（`opencode.jsonc`）与插件缓存不碰
- 插件自产文案（含告警/日志文案）一律英文
- TDD 红→绿；基线 250 pass / 0 fail / 892 expect，`bun run test` + `bun run typecheck` 全绿才完
- 容错纪律：注册文件读 / HTTP / 决策日志写 全部 catch + swallow，永不炸宿主事件循环
- 一次性宿主完全隔离：`XDG_STATE_HOME` + `XDG_CONFIG_HOME` 指 temp（注册文件写隔离目录，桌面活 `service.json` 零覆盖风险）

## Review Focus（测试不覆盖、用户会撞的）

1. **陈旧注册文件**（桌面重启、pid 已死）→ `pid !== process.pid` → `unavailable`，绝不跨服务器查询（Task 2 单测）
2. **一台机器两个 opencode 服务**（本机：4096 老服务 + 45278 桌面）→ pid 自识别是唯一判别（Task 2 单测）
3. **会话中途 server 重启**（url/password 换新）→ 每次查询重读注册文件，天然拿到新值（Task 2 注入测试）
4. **inbox 查询时会话已消失**（404 `SessionNotFoundError`）→ 按空列表（ok），不是 unavailable（Task 2 fake-fetch 测试）
5. **宿主 fs action 名漂移**（未来改名）→ 默认放行（区分不了就不限），绝不反向 deny-all（Task 1 单测）

---

### Task 1: 权限拆分——读放行、只限写（最高优先，解用户当前卡死）

**Files:**
- Modify: `src/permission.ts`（rule 7 全域 deny → 仅写 action 沙箱）
- Modify: `test/permission.test.ts`（新增读/未知 action 放行组）
- Modify: `test/permission-integration.test.ts`（test 3 改预期；新增 fs.write 出界 deny）
- Modify: `README.md`（Path sandbox 节改新语义）

**Interfaces:**
- Produces: 导出常量 `WRITE_ACTIONS: readonly string[] = ["fs.write"]`（已知写 action 名单，可扩展）；`decidePermission` 对外契约（PermissionInput/PermissionDecision）不变

步骤：

- [ ] **Step 1: 写失败测试**
  - `test/permission.test.ts` 新增组"读/未知 action 放行"：`fs.read` 出界绝对路径（unix + windows 各一）→ `{effect:"leave"}`；未知 action（`"bash"`）出界路径 → leave；目录内 `fs.read` 也 leave（plugin 无意见，宿主自有配置接管）
  - `test/permission-integration.test.ts`：test 2/3/9（`fs.read`，无论界内界外）预期由 `allow`/`deny` 统一改为 `undefined`（读 = 无意见）；新增 test 11：`fs.write` 出界 → deny，message 含路径 + `goal_block` + session 目录
- [ ] **Step 2: 跑测试确认红**（`bun test test/permission.test.ts test/permission-integration.test.ts`）
- [ ] **Step 3: 实现**——`src/permission.ts`：`goal.control` 规则之后插入 `if (!WRITE_ACTIONS.includes(input.action)) return { effect: "leave" };`；头注释规则表更新（新规则序：1 deny 不放宽 → 2 goal.control → 3 非写 action 放行 → 4..8 原路径规则只对写 action 生效）
- [ ] **Step 4: 跑测试确认绿 + 全量 `bun run test`**
- [ ] **Step 5: 提交** `fix: permission sandbox read-open; only fs.write path-contained (user ruling 2026-10-17)`

注：目录内读也改无意见——不是"允许"，是"不说话"，宿主配置/用户确认照常生效，插件只不再 deny。

### Task 2: `src/hostapi.ts`——HTTP 数据面（shell store + inbox）

**Files:**
- Create: `src/hostapi.ts`
- Create: `test/hostapi.test.ts`

**Interfaces:**
- Produces（Task 3/4 消费）：

```ts
export type HostApiState = "ok" | "unavailable";
export interface HostApiResult<T> { state: HostApiState; value?: T; reason?: string; }
export interface HostApi {
  shellList(locationDirectory: string): Promise<HostApiResult<ShellEntry[]>>;
  inboxList(sessionID: string): Promise<HostApiResult<InboxItem[]>>;
  inboxCancel(sessionID: string, inboxID: string): Promise<HostApiResult<undefined>>;
}
export interface HostApiDeps {
  fetch?: typeof fetch;                        // 注入 fake
  readRegistration?: () => Promise<string | undefined>; // 注入（文件内容或 undefined）
  myPID?: number;                              // 默认 process.pid
  timeoutMs?: number;                           // 默认 3000
}
export function createHostApi(deps?: HostApiDeps): HostApi;
// 纯函数（直接单测）：
export function resolveRegistrationFile(env: Record<string, string | undefined>, home: string): string;
export function parseRegistration(raw: string): { url: string; pid: number; password?: string; version?: string; id?: string } | undefined;
export function serviceUrl(url: string): string;          // host 0.0.0.0 / :: → 127.0.0.1，保留 scheme/port
export function basicAuthHeader(password: string): string; // "Basic " + b64("opencode:" + password)
```

- Consumes: `ShellEntry` / `InboxItem`（`src/types.ts` 既有）

行为细则（实现必须遵守）：
- `resolveRegistrationFile`：`env.XDG_STATE_HOME ?? join(home, ".local", "state")` + `/opencode/service.json`（与宿主二进制 `h()` 同规则）
- 注册文件**每次查询重读、不缓存**（Review Focus #3）；读不到 → `unavailable("no-registry")`
- `parseRegistration` 容错：坏 JSON / 缺 url / pid 非数 → `undefined` → `unavailable("bad-registry")`
- **pid 自识别**：`reg.pid !== myPID` → `unavailable("pid-mismatch")`（Review Focus #1/#2）
- password 缺失 → 不带鉴权头（服务器无密码 = 无鉴权）
- `shellList`：`GET /api/shell`（**先不带 location 参数**——其精确语义未钉死，T2/T5 两头可控时定；接口保留 `locationDirectory` 参数备用）
- `inboxList`：`GET /api/session/:sessionID/inbox`；响应体 `_tag === "SessionNotFoundError"` → `ok` + `[]`（Review Focus #4）
- `inboxCancel`：`POST` 路由**先读 `node_modules/@opencode/protocol/dist/groups/session.d.ts` 钉死**（client 面 `session.inbox.cancel` 对应端点）再写
- 其余非 2xx / 超时 / 网络错 → `unavailable(reason)`；shell 条目归一化 `{id, status, sessionID: metadata?.sessionID}` 字段缺失容忍（现有 ShellEntry 契约）

测试策略：纯函数直接测；端点行为用注入 fake fetch 覆盖（200 / 401 / 404-SessionNotFound / 网络错 / 超时 / pid 不符 / 坏注册 / 文件缺失 / 注册文件中途换值）。零真实网络、零真实文件读。

- [ ] **Step 1: 写失败测试**（`test/hostapi.test.ts`，上述矩阵）
- [ ] **Step 2: 跑测试确认红**
- [ ] **Step 3: 实现 `src/hostapi.ts`**
- [ ] **Step 4: 跑测试确认绿**
- [ ] **Step 5: 提交** `feat: hostapi — HTTP data plane (service.json discovery + Basic auth + pid self-ident + ok/unavailable signal)`

### Task 3: probe 接线——callRpc 下线，hostapi 接上

**Files:**
- Modify: `index.ts`（删 lines 45–62 `rpcGeneric`/`callRpc` + TODO(task13) 注释；shellList/inboxList/inboxCancel 改接 hostapi）
- Modify: `src/types.ts`（WakeProbe：删 `rpcCall`；`shellList/inboxList/inboxCancel` 签名不变，注释改 HTTP 通道）
- Modify: `test/harness.ts`（删 `rpcCall` 脚本面；`shellStore` 维护与 `shellList` 假实现保留）

接线细则：
- `const hostApi = createHostApi()`（默认 deps：真 fs/fetch/process.pid）
- 适配器转换：`ok` → resolve `value`；`unavailable` → **throw**（controller 既有 catch 接住，Task 4 改为信号 unavailable 而非假计数）
- `inboxCancel` 的 inboxID→sessionID 映射（R6 `inboxSessions`）不动
- 顺带修复（同一死通道）：`inboxList` 支撑仲裁器 lastInbox 归属（spec §6 ⑤），此前同样死——本任务随通道一起复活
- index.ts 其余面（command/tool/hook 注册）零改动

- [ ] **Step 1: 先改 `src/types.ts` + `test/harness.ts`（面契约）**
- [ ] **Step 2: 接线 `index.ts`**
- [ ] **Step 3: `bun run test` + `bun run typecheck` 全绿（行为无变化，既有测试应原样通过）**
- [ ] **Step 4: 提交** `refactor: probe data plane from dead ctx.rpc.call to hostapi (HTTP); drop callRpc`

### Task 4: controller 信号三态 + 决策日志（查询失败 = 上下文死亡：日志 + skip）

**Files:**
- Modify: `src/controller.ts`（`inFlightCount` 三态化；unavailable → 边界决策 skip）
- Create: `src/decisionlog.ts`
- Modify: `test/background-gate.test.ts`、`test/goal-loop.test.ts`（断言更新/新增）
- 不动：`src/wake.ts`（check-in 只在查询成功且真有在飞时武装 → 原文案/原测试字节不变）

**裁定（2026-10-17，用户）：** 查询失败 = 该会话上下文已死 → 写日志 + 边界 `skip`（**不唤醒、不武装 check-in**）——复活会话不是插件的活，人看日志处理。正常会话的正常唤醒仍是插件本职。"接口正常时查询必成"由 Task 5 实机兜底，失败路径不做任何救场逻辑（无重试、无连续计数、无降级假计数）。

Interfaces：
- `inFlightCount(sessionID): Promise<{ count: number; ownKnown: boolean }>`（`count = own + other`；查询失败时 `own = 0`、`ownKnown = false`，**不再假报 1**）
- `src/decisionlog.ts`：
```ts
export function decisionLogPath(pid: number): string; // <tempdir>/opencode-goal/decisions-<pid>.jsonl
export async function appendDecision(entry: { ts: string; sessionID: string; goalID?: string; own?: number; other?: number; ownKnown: boolean; decision: "wake" | "hold" | "skip"; reason: string }): Promise<void>; // appendFile，catch + swallow
```

行为（边界决策矩阵）：
- `ownKnown=true, count=0` → wake（既有逻辑）
- `ownKnown=true, count>0` → hold + 武装 check-in（既有逻辑）
- `ownKnown=false` → **skip**：无唤醒、无 check-in 武装；决策日志 `decision=skip, ownKnown=false, reason=<查询错误摘要>`；console warn 每会话一次（沿用既有 warn-once 模式）
- 每次边界决策（wake/hold/skip）都写一条决策日志

测试新增/改写：
- `inFlightCount`：`probe.shellList` 抛错 → `{ count: 0, ownKnown: false }`（回归断言：旧行为假报 1）；成功 → `ownKnown: true`
- 边界仲裁：unavailable → skip（无 prompt 调用、无 check-in 武装、决策日志含 skip 行、warn-once 恰一次）
- **既有"查询失败 → 按在飞"用例**（shell-store-gate 计划新增 3 用例之一）预期改为 skip
- decisionlog：`appendDecision` 真实写一行（temp 目录，测后清理）；append 失败不抛

- [ ] **Step 1: 写失败测试（上述断言）**
- [ ] **Step 2: 跑测试确认红**
- [ ] **Step 3: 实现（decisionlog.ts → controller.ts）**
- [ ] **Step 4: 全量 `bun run test` + `bun run typecheck` 绿（wake.ts 零改动，其测试原样绿）**
- [ ] **Step 5: 提交** `fix: gate signal 3-state (query failure = context dead: log + skip), decision log jsonl`

### Task 5: 一次性宿主实机验证（T2，隔离配方）

**Files:**
- Create: `scripts/verify-hostapi.ts`（隔离宿主配方，参照 `scripts/live-smoke.ts` 的成熟段）

配方（全在 temp，用户活环境零触碰）：
1. `temp = %TEMP%/opencode/hostapi-verify-<ts>/`；子目录 `state/`、`config/`、`workspace/`（空）
2. `config/opencode.jsonc`：`{"providers": <从用户全局配置只读拷贝 providers 段>, "plugins": ["D:\\dev\\opencode-goal"]}`（目录条目 = 本地源码加载，已实证；不读用户全局配置 → 无重复插件）
3. 环境 `XDG_STATE_HOME=temp/state` + `XDG_CONFIG_HOME=temp/config`；`opencode-cli.exe serve --service --print-logs`，cwd = workspace
4. 轮询 `temp/state/opencode/service.json`（≤30s）→ url/pid/password；**断言 pid == serve 进程 pid**（Task 2 pid 契约首验）
5. `POST /api/location/reload`（service.json 凭据）`{location:{directory: temp/workspace}}` → 轮询 stderr "loading plugin"（entrypoint = `D:/dev/opencode-goal/index.ts`）
6. 真实场景（消耗少量 ch2lab 调用）：
   - 建会话 → `/goal set <简单目标>`（command 面，不耗模型）
   - 真实模型回合：提示词要求**起一个 30–60s 的后台 shell 后结束回合**（#12138 原始场景）
   - 等边界：**决策日志**出现 `decision=hold, own=1, ownKnown=true`（真实计数，非假 1）；**无**立即唤醒（无 5 秒死循环）
   - `checkInDelaySec` 设小（15）→ check-in 到达，文案含真实计数
   - **读权限验证**：隔离 config 加 `"permission": {"fs.read": "allow"}`；active goal 下让模型读 cwd 外文件（如 `%WINDIR%\win.ini`）→ 成功、**无 plugin deny 消息**（Task 1 裁定实机闭环：旧代码下 plugin deny 会硬拒，新代码 plugin 无意见 → 放行）
7. **断言用户活 `service.json` 全程 mtime 不变**（隔离证明，收尾对照）
8. 清理：kill serve、删 temp

验收（全绿才完）：T2 断言 4/5/6 三条全过 + `bun run test` + `bun run typecheck` + `package.json` version 仍 1.0.5。

### Task 6: 收尾

- README：Path sandbox 节 → 读放行/只限 `fs.write`；新增 Data plane 节（service.json 发现 / Basic 鉴权 / pid 自识别 / 三态信号 / 决策日志路径 `<tempdir>/opencode-goal/decisions-<pid>.jsonl`）；删 callRpc 相关表述
- Spec 附录一段（不重写历史）：`2026-10-15-goal-loop-design.md` 加"2026-10-17 修订：§77 'ctx.rpc.call' 通道在 2.0.32 不成立（in-process RPC 仅宿主→插件注册域）；数据面 = HTTP client 面，见 plan"
- 台账 + 记忆：一条完成记录（通道 / 语义变更 / T2 验证结果）
