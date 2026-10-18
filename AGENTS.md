# opencode-goal 项目指令

## 禁令（用户 2026-10-17 裁定，永久，优先级高于一切默认行为）
1. **禁止自动发布**：绝不自行执行 npm publish（含 `scripts/publish.mjs` 及任何等效途径）。仅当用户**当轮**明确下令"发"才可执行；历史指令不延续、不累积。
2. **禁止自动递增版本号**：绝不自行修改 `package.json` 的 version 字段（或任何版本字段）。仅当用户**当轮**明确指定版本号才可修改。
3. 发布前版本号保持最后已发布版本（不提前 bump）。
4. **任何 registry 写操作**（publish / unpublish / deprecate / dist-tag）均须用户**当轮**明确下令，绝不自动执行。

## 验证纪律（用户 2026-10-17 同批裁定）
- 宿主契约问题：只读离线取证（grep 宿主二进制），禁止对生产 129 做探针 surgery。
- 实机行为验证：本机一次性测试宿主（隔离 config + 端口 + 空白目录）；129 只在用户下令更新后做播种 + 日志观察。
- 涉及"129 上现在是什么版本/什么代码"时：读 129 缓存目录的 package.json 与日志 entrypoint 实证，不得从 registry 状态推断。

## 命令（bun 工具链）
- 测试 `bun test`（311 用例，约 20s）；单文件 `bun test test/harness.test.ts`；单用例 `bun test -t "名称正则"`
- 类型检查 `bun run typecheck`（tsc --noEmit）
- 构建发布包 `bun run scripts/publish.mjs pack`（staging + 双硬门：strip 残留、tarball 文件清单；无需 auth）；`publish` 子命令 = npm publish（2026-10-18 起由 CI 代跑）
- 测试两层：`test/*.test.ts` = 进程内 stub 宿主（`test/harness.ts`，快，可伪造 parentID/shell 等契约数据）；`scripts/host.ts` 的 `startHost()` = 本机隔离真实宿主（慢；lab LLM 需 env `OPENCODE_LAB_PROVIDER_BASE/KEY`）——宿主行为级结论必须出自后者（调用方：`scripts/verify-*.ts`、`probe-*.ts`）

## 发布通道（2026-10-18 起：tag 触发 CI/OIDC）
- 流程：main 开发（version 停在最后已发布版本）→ 发布时切 `publish` 分支 bump version → 打 `vX.Y.Z` tag → push → `publish.yml` 自动发布（版本门 tag==package.json → typecheck/test → 双硬门 → npm publish，零 token；provenance 自动附加 sigstore 日志）
- 禁令不变：bump 与推 tag 都须用户当轮明令，CI 只执行
- 仓库防护（bypass 均仅 ch2lab；agent push 日志出现 "Bypassed rule violations" 属正常）：`main-gate`（PR 1 审批 + `test` 检查必过 + 禁 force push）、`tag-gate`（`v*` tag 创建/删除受限）
- GitHub Actions 白名单 action：`actions/checkout@*`、`actions/setup-node@*`、`oven-sh/setup-bun@*`——**pattern 必须带 `@*`**（裸仓库名匹配不到 `@v6` 引用，已实证卡死过一次发布）。新 workflow 用白名单外 action 须先请用户扩白名单
- 发布后核验：`gh run view` 日志 → registry `npm view` latest + tarball 标记（CDN 复制有分钟级滞后：`npm pack` 报 ETARGET 时，直连 registry tarball URL 才是 ground truth）→ publish 合回 main 记账

## 架构速览
- `index.ts` 宿主入口；**发布物是 stripped 变体**（纯 `{id, setup}` 导出，零运行时依赖）——由 publish.mjs 的变换生成，宿主以该形态加载
- `src/` 11 模块：`controller.ts`（goal 循环主体：在飞门禁、`isSubtaskOf` parentID 归属、wake 决策）、`wake.ts`（全部注入文案 builder）、`judge`/`evidence`（判官/证据）、`state`/`options`/`permission`/`types`/`compact`/`decisionlog`/`hostapi`
- 设计规格 `docs/superpowers/specs/2026-10-15-goal-loop-design.md`（含修订附录 §17+）——改 goal 循环语义前先读
- `README.md` 即 npm 包文档（随 tarball 发布，改动随下个版本进包）

> 机器本地信息（129 实机细节、本机工具现状）：见 `AGENTS.local.md`——未入 git，仅存在于配置过的机器；该文件不存在时，向用户询问 129 访问细节。
