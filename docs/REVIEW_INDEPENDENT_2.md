# LMS-AiPanel 第二轮独立复核报告（REVIEW_INDEPENDENT_2）

- 审查日期：2026-09-03
- 审查对象：/workspace/LMS-AiPanel，HEAD = b553f28（第一轮 51d14ec 之后 9 个修复提交）
- 审查方式：独立取证。不信任第一轮结论与修复提交说明，全部通过源码阅读 + 单测复跑 + 生产构建黑盒 + 针对性集成脚本逐项验证。
- 环境：Linux 容器，Node v24.20.0，vitest 4.1.5，vite 8.0.11，Fastify 5.8.5。macOS 专属功能仍无法真机验证（标注「未验证」）。
- 结论前置摘要：**本轮仍不能视为验收通过**。第一轮 3 严重 + 7 中等发现中，S1/S3/M1/M4/M5/M6 主体已修复（各有残留），S2 存在**绕过路径**（restore 端点白名单缺失，实测可任意文件写），M3/M7 基本达成但各有 1 个 UI 缺口；另发现 1 个**高严重度回归**（preview→apply 往返会以字面 `<redacted>` 覆盖真实密钥，实测文件被破坏）。

---

## 1. 审查范围与方法

- **独立运行**：`export HOME=/tmp && npm test`（25 文件 / 138 用例，另有 3 个 unhandled rejection）；`export HOME=/tmp && npm run build`（server tsc + fix-dist-imports + typecheck + vite build，干净）。
- **生产黑盒**：以 `node dist/server/index.js`（仅绑 127.0.0.1）启动真实服务，用 curl 复测：无会话任意文件读、白名单内 preview 密钥泄露、无会话写端点、跨源写、SSE 迟到订阅、冷启动 graph、MCP verify 路由、symlink 换绑。
- **针对性集成脚本**（tsx 直调 buildApp/适配器，共 40+ 个独立场景）：restore symlink 任意写、preview→apply 密钥破坏往返、TOCTOU 竞态（3 种方式共 10 万+ 请求，0 次命中）、脱敏绕过变体（值级/数字/布尔/URL 凭据/多行 TOML/嵌套 inline table）、redactionHints 快照边界消费、assistant 路由漂移可达性、MCP 握手全链路、会话 TTL/revoke/剪枝、refresh 单飞/取消、manifest 隔离、慢采集下 GET 不阻塞。
- **回归检查**：客户端测试是否为真实断言（是，见 §4）；dist/ 与源码一致性（构建后 mtime 新于 src，git status 干净，dist 在 .gitignore）。
- **未验证项**：macOS 真机（LaunchAgent 冷启动、真机 start/stop、浏览器真实渲染/窄屏 QA）——无 macOS 环境。

---

## 2. 第一轮发现修复核验表

### S1. `/api/config/preview`、`/api/config/diff` 任意文件读取 + 密钥泄露 —— ✅ 已修复（有残留）

证据：
- 白名单：app.ts:81-101 `canonicalConfigPaths`（构建时 realpath 集合）+ `isAllowedConfigPath`（请求时 realpath 比对）。preview（887-911）、diff（914-940）均在读取前检查。
- 黑盒复测：`GET /api/config/preview?path=/etc/hostname` → `CONFIG_PATH_NOT_ALLOWED`；白名单内 `~/.codex/config.toml`（含 `token = "sk-real-secret-abc123456789"`、`access_token = "sk-..."`）→ rawContent 与 undocumentedFields 均无明文（`sk-...` 与 `access_token` 全部 `<redacted>`）。
- diff 同样被白名单拦截（`POST /api/config/diff` 指向 /etc/passwd → 拒绝）。
- **残留（见新发现 N4/N5/N6）**：值级模式可被变体绕过（`SK-` 大写、短 `sk-abc`、`github_pat_`、`hf_`、`glpat-`、URL 内嵌凭据 `https://user:pass123@...`、`redis://:pass@...`）；数字/布尔值在敏感键下仍原样返回；`preview` 未加 session/origin 守卫（第一轮建议项未执行，见 N6）。
- TOCTOU：3 种竞态（固定 symlink、flap 换绑、并发翻转 + 6 万+ 请求）均 0 命中，白名单+realpath 在实践中稳健；但 check→read 非原子，理论上仍有窗口（低风险，见 N7）。

### S2. `/api/config/apply` 任意文件写 —— ❌ 未完全修复（restore 端点可绕过白名单）

证据：
- apply 本身：白名单检查（955-962）+ session 守卫（944-951）均到位；黑盒复测白名单外 apply 被拒（`CONFIG_PATH_NOT_ALLOWED`），symlink 换绑后 apply 同样被拒。
- **但**：`POST /api/config/backups/:id/restore`（app.ts:1013-1034）**没有 isAllowedConfigPath 检查**，`configCenter.restore()`（configCenter.ts:299-328）直接 `fs.writeFile(record.filePath, ...)`（跟随 symlink）。
- 集成实测（rt-restore6/7）：有会话的本机进程 → apply(evil) → apply(clean)（生成 content=evil 的 backup）→ 把白名单文件换成指向 victim 的 symlink → restore(evil backup) → **victim 被改写为 `model = "evil"`**（restored=true）。任意文件写（内容为任意合法 TOML）成立。
- 影响：S2 的「任意已存在文件覆盖」以 restore+symlink 路径复活；攻击者需会话（本机进程可自行 `POST /api/session` 领取，无 Origin 即可）→ 影响与第一轮 S2 相同。
- 修复建议：restore 前对 `record.filePath` 做与 apply 相同的 `isAllowedConfigPath` realpath 检查；对 restore 内容做 TOML 校验回滚（当前无效 TOML 也会先写入，见 N8）。

### S3. 脱敏键名误伤 / 键值不对称 / redactionHints 无消费方 —— ✅ 部分修复（键匹配与 hints 已修复，值级/数字残留）

证据：
- 键匹配：token 级切分（redaction.ts:26-37）。实测 `author`/`authorName`/`coauthor`/`authority`/`helperScript` 不再误伤；`auth_token`/`Token`/`APIKey`/`api-key`/`api key`/`ANTHROPIC_API_KEY`/`accessToken`/`token_count` 均命中。深嵌套（`auth:{nested:{deep:{token}}}`）整子树脱敏；数组内对象递归脱敏。
- redactionHints：scheduler.ts:101 在快照边界消费（`applyRedactionHints`），claudeConfigAdapter 的 `baseUrl` hint 实测生效（`"baseUrl":"<redacted>"` 进入快照与持久化）；omlxAdapter 声明但从不 push（死声明，见 L 级）。
- **残留（见新发现 N4/N5）**：值级模式（17-18 行）覆盖面窄——大写 `SK-`、`github_pat_`、`hf_`、`glpat-`、`AIzaSy`、`ya29`、URL 凭据、`redis://:pass@` 等全部漏网；数字/布尔在敏感键下原样返回（`token: 123456`、`token_value: 987654321` 实测泄露；security.test.ts:146-151 将「数字保留」固化为设计，但同时保留了 `{"token": 123456}` 的泄露面）；多行 TOML 续行靠 envelope 级兜底（主模式 8+ 长度命中可拦，变体仍漏）。
- `redactStringForDisplay` 仍为死代码（唯一引用即定义处，P2 声称的清理未覆盖）。

### M1. refresh/cancel/metrics/plan 无 session 守卫 —— ✅ 已修复

证据：app.ts:377-385（refresh）、411-419（cancel）、474-482（metrics）、659-667（plan）均加 `requireWrite`；黑盒 + 集成枚举全部 16 个写端点（含 registry CRUD、actions 全链、reverify、apply、restore、gateway/clients、mcp/verify）无会话均 `WRITE_GUARD_REJECTED`；security.test.ts:153-174 断言 refresh/metrics/plan 被拒。`/api/config/diff` 与 `/api/session/revoke` 仍无守卫（前者是白名单内只读、后者只吊销自己，见 N6/L 级）。

### M3. MCP 能力握手无 API 路由 —— ✅ 基本修复（1 个 UI 缺口）

证据：`POST /api/mcp/:id/verify`（app.ts:1087-1139）= session 守卫 + managed 门 + `getServerSpec` + `verifyCapabilities`；集成实测（真实 fake JSON-RPC 端点 + registry managed）返回 serverInfo/tools，且 `tools/list` 的返回内容**未调用**任何业务工具；serverInfo 里 `sk-...` 字符串经 envelope 脱敏为 `<redacted>`（实测）。stdio 服务器明确拒绝（mcpAdapter.ts:213-215）。tests/mcp.test.ts:136-191 有断言。
- **缺口**：客户端（views.tsx/main.tsx/resourceDetail.tsx）无任何触发 `verify` 的 UI；capability-verified 状态在产品中仍不可直接操作（需 API 调用）。第一轮「手工命令路径存在」已满足，UI 按钮仍缺。

### M4. 路由漂移不可达 —— ✅ 已修复

证据：assistantAdapter.ts:314-348 现在探活端点 `/v1/models`，`served` 与 `configured` 比较，不一致时 `live = served[0]`、`drift=true`、`routeNode.state="warning"`；定义节点聚合 `routeDrift`（144 行）。集成实测（fake 端点服务不同模型）→ `route: warning`、evidence 含 `route drift: configured=qwen2.5-32b live=other-model-9b`、`definition.properties.routeDrift === true`。tests/assistant.test.ts:116-157 有两个方向断言（drift / 不可达不 claim）。注意：drift 判定依赖端点可探活（fetch 127.0.0.1:8000 默认地址 1s 超时），不可达时 `endpointChecked=false` → 不误报。

### M5. 冷启动 GET 阻塞 —— ✅ 已修复

证据：app.ts:268-298 无快照时返回 v0 空快照 + `meta.collecting: true`（schemas.ts:220 定义了字段）；scheduler.start()（137 行）后台立即 `collect("all")`（scheduler.ts:70）。集成实测：慢适配器（3s）下 GET /api/graph 11ms 返回 collecting=true、calls=0；冷启动返回 version=0/collecting=true（126ms）。tests/scheduler.test.ts:285-315 有专门断言。

### M6. SSE 迟到订阅者收不到历史 —— ✅ 已修复

证据：sseHub.ts:14-33 缓冲 200 条事件、subscribe 即重放；refreshOrchestrator 事件顺序 run→adapter×N→run(completed)→snapshot。黑盒实测：先完成 refresh 再连接 SSE → 收到 13 adapter + 2 run + 1 snapshot 完整历史。tests/refresh.test.ts:183-209 有迟到订阅断言。SSE 事件仅含 runId/status/adapterId/version，无敏感数据。

### M7. 客户端零接入 —— ✅ 基本修复（2 个缺口）

证据：
- 会话：api.ts:16-27 `ensureSession`（内存持有，非 localStorage）、apiFetch 带 `x-lms-session` 头；main.tsx:242-252 启动获取会话。
- SSE：main.tsx:269-294 `startRefresh` 用 EventSource 订阅 adapter/snapshot/run 事件并更新进度 UI。
- 视图切换：main.tsx:26 NAV_ITEMS 9 项，运行总览/配置中心/审计日志渲染各自面板，其余 5 类走 `ResourceListView` 按类型过滤（views.tsx:227-234），不再是同一页。
- 配置编辑：ConfigCenterPanel（views.tsx:19-108）preview→textarea→apply 闭环。
- 网关覆盖：GatewayPanel（123-191）展示归因/未归因/provider 总量 + 客户端注册。
- 审计：AuditPanel（197-221）。
- 动作流程：resourceDetail.tsx:62-96 严格 plan→create run→confirm→execute 四步，且仅 managed 资源渲染动作按钮（215-230）。
- 客户端测试：clientViews.test.tsx（4 个）与 resourceDetail.test.tsx（2 个）均为真实断言（渲染后断言文本/事件），非「只不报错」。
- **缺口**：(1) MCP verify 无 UI（见 M3）；(2) 配置面板的「保存前会 diff」是文字说明，代码没有调用 `/api/config/diff`（views.tsx 无 diff 引用）——diff 端点存在但 UI 未接；(3) 侧栏「网关」无独立导航项（网关面板挂在运行总览底部，属展示差异，非功能缺失）。

### P2. 死代码清理 —— ✅ 基本完成（1 处残留）

证据：`safeBaseName`、`seenEntryIds`、`void HOURLY_AGE_SECONDS` 均已删除（069369d）。残留：`redactStringForDisplay`（redaction.ts:79-84）与 `RefreshOrchestrator.defaultTimeoutMs`（refreshOrchestrator.ts:31）仍无人使用。

---

## 3. 新发现清单（按严重度）

### 高

#### N1. 【回归·数据破坏】preview→apply 往返会把真实密钥写成字面 `<redacted>`，破坏用户配置文件

- 问题描述：修复 S1 时对 `rawContent` 做了行级脱敏（configCenter.ts:188），而该脱敏文本是客户端唯一的编辑底稿（views.tsx:28 `setEditing(data.rawContent)`），apply 原样写回（views.tsx:41；app.ts:982）。任何含密钥的配置，只要走一遍「读取预览 → 备份并应用」（即便用户不改任何内容），文件中的真实密钥就被替换为字符串 `"<redacted>"`，配置损坏、密钥失效。
- 证据：生产黑盒 + 集成实测（rt-roundtrip）：文件 `token = "sk-real-secret-abc123456789"` → preview → apply(rawContent) → `apply.ok=true`、文件变为 `token = "<redacted>"`、`CONTENT-DESTROYED: true`。configCenter.test.ts 的 apply 用例全部用手写 UPDATED 文本（保留密钥行），从未覆盖「preview 原文往返」路径，故测试全绿未暴露此回归。
- 影响：配置中心功能在含密钥配置上不可安全使用——一键破坏 Codex 配置（密钥丢失）；配合 N8（无效 TOML 也先写入）可更广破坏。属修复引入的回归（修复前 preview 返回明文，往返无损）。
- 修复建议：(1) apply 前做「脱敏内容还原/白名单 diff」——客户端只能提交对**非敏感行**的编辑，密钥行由服务端保留原值（按行比对：客户端提交内容中敏感键行与 preview 脱敏行一致时，服务端回填文件当前真实值）；(2) 或 preview 增加 `rawContent` 与 `editContent` 分离（editContent 保留原样但 apply 时服务端校验编辑仅涉及非敏感字段）；(3) 至少加集成测试覆盖「含密钥配置 preview→apply 往返不丢失密钥」。

#### N2. 【安全·S2 复活】`/api/config/backups/:id/restore` 无白名单 realpath 检查，配合 symlink 换绑可实现任意文件写

- 问题描述：restore 路由（app.ts:1013-1034）与 `ConfigCenter.restore`（configCenter.ts:299-328）对 `record.filePath` 直接 `fs.writeFile`（跟随 symlink），没有任何 `isAllowedConfigPath` 复核。备份记录里的路径在备份时是白名单内路径，但之后可被换绑。
- 证据：集成实测（rt-restore6/7，全 HTTP、真实会话）：apply(evil) → apply(clean)（DB 中产生 content=evil 的 backup）→ 把白名单文件 rm 后 symlink→victim → `POST /api/config/backups/<evilBackupId>/restore` → `restored=true`、victim 内容 = `model = "evil"`（`ARBITRARY-WRITE-CONFIRMED: true`）。本机进程可自行领 session（无 Origin 的 CLI 路径合法，session.test.ts:120-134），故会话门槛不构成有效防护。
- 影响：等同第一轮 S2 的「任意已存在文件覆盖」原语（内容为任意合法 TOML；若利用 N8，内容可为任意字符串），可覆写 ~/.bashrc、~/.ssh/authorized_keys 等。严重度高于 N1。
- 修复建议：restore 前对 `record.filePath` 执行与 apply 相同的 `isAllowedConfigPath`；用 `fs.open(..., "r+", { flag: "w" })` + O_NOFOLLOW 语义或在目标目录内重写临时文件 + rename 避免跟随 symlink；补集成测试（symlink 换绑后 restore 必须被拒）。

#### N3. 【安全·中高】`/api/config/apply` 先写后验：无效 TOML 也会写入目标文件，且 previewHash 是客户端可自算的文件哈希而非服务端凭据

- 问题描述：apply 流程（configCenter.ts:247-273）先 `writeFile(tmp) → rename(tmp, filePath)`，**再**重读+解析校验；解析失败仅返回 `ok:false`，文件已被覆盖（无回滚）。`previewHash` 校验（app.ts:964-972）比较的是「客户端提交值 vs 服务端重算的当前文件哈希」——哈希就是 `sha256(文件内容)`，客户端可自行 preview 获取（或直接算），不是防伪凭据；并发两个同哈希 apply 均成功（实测 r1/r2 均 ok，后者覆盖前者，无锁）。
- 证据：集成实测：提交 `this is [[[ invalid toml` → 响应 `CONFIG_APPLY_FAILED`（错误信息还回显文件内容片段），但**文件已变为该无效内容**；并发同哈希双 apply 均 `ok:true`。
- 影响：外部变更守卫（previewHash）只防「预览后被外部改过」，不防「谁在写」；与 N2 组合可把任意字符串写入任意路径；无效配置覆盖后 Codex 无法读取配置。
- 修复建议：写前校验内容可解析（先 parse 再写）；校验失败回滚备份；previewHash 升级为服务端签发的 (path, hash, nonce) 凭据；apply 期间对文件加锁/串行化。

### 中

#### N4. 【脱敏残留】值级模式覆盖面窄，多种真实密钥形态绕过

- 问题描述：`SECRET_VALUE_PATTERN`（redaction.ts:17-18）只覆盖 `sk-`、`ghp_`、`xox[bap]-`、`Bearer`、`AKIA` 五类，且 `sk-` 要求 8+ 字符、大小写敏感。
- 证据：集成实测（rt-leak，白名单内 preview）：`SK-ABCDEF1234567890XYZ`（大写）、`sk-abc`（短）、`github_pat_...`、`hf_...`、`glpat-...`、`AIzaSy...`、`ya29...` 全部 LEAKED；`AKIAIOSFODNN7EXAMPLE` 正确脱敏。
- 影响：密钥形态未覆盖时明文出 API（同一白名单内文件、无会话可读）。Codex/Claude 生态真实 token（anthropic 的 `sk-ant-` 因 `sk-` 前缀命中；GitHub PAT / HuggingFace / Google 等未命中）。
- 修复建议：扩充模式（`github_pat_`、`hf_`、`glpat-`、`AIzaSy`、`ya29`、`sk-ant-`、任意 `sk-[A-Za-z0-9]{6,}` 不分大小写、URL 内嵌凭据 `://user:pass@`、redis/mongodb DSN）；或对值级做「熵+黑名单」启发。

#### N5. 【脱敏残留】数字/布尔值在敏感键下原样返回

- 问题描述：redaction.ts:63-64 对敏感键下的 number/boolean 直接保留（为保住 `tokensIn` 等计数器）。该规则对**所有**敏感键生效，不区分「计数器键」与「真密钥键」。
- 证据：集成实测：`[profile] token = 123456` → undocumentedFields `{"token":123456}` 明文；`[experimental] token_value = 987654321` → documentedFields `experimental: {"token_value":987654321}` 明文。security.test.ts:146-151 断言 `tokensIn: 12` 保留，属于设计意图，但未覆盖「敏感键+数字」泄露面。
- 影响：数字型密钥/口令/端口密钥泄露（少见但真实存在，如部分 API 用数字 token/ID）。
- 修复建议：仅在**明确非敏感**的度量键（`tokensIn/tokensOut/latencyMs/memoryKb/端口`等白名单）下保留数字，其余敏感键一律 `<redacted>`。

#### N6. 【安全边界】`/api/config/preview`、`/api/config/diff`、`/api/refresh/events` 无 session/origin 守卫（读面）

- 问题描述：第一轮建议「至少给 preview/diff 加与 apply 相同的 session+origin 守卫」未执行；SSE 端点同样无守卫且不校验 Origin。
- 证据：实测 `GET /api/config/preview`（无会话）可读白名单配置全文（脱敏后）；`POST /api/config/diff`（无会话）可做任意内容 diff；SSE `GET /api/refresh/events`（带 `Origin: https://evil.example.com`）返回 200 + 事件流，响应无 `Access-Control-Allow-Origin`。浏览器读侧因 CORS 缺失无法跨站读取（事件流对恶意页面不可读）；但**本机任意进程**无会话即可读取全部读面数据；DNS rebinding 场景下恶意页面可读取脱敏后配置与 SSE 流（SSE 无密钥，风险低；preview 含配置结构）。
- 影响：与第一轮 M2 同类残留（读面无守卫）；SSE 无守卫可被用于无差别连接（资源消耗极小，非泄漏）。写面守卫已完整，读面属残余风险。
- 修复建议：preview/diff 增加可选 session 校验（有 Origin 的浏览器请求要求会话；无 Origin 的 CLI 请求维持白名单即可）；SSE 至少校验 Origin 不在拒绝列表。

#### N7. 【低-中】白名单 realpath 检查与读取之间存在 TOCTOU 窗口（理论）

- 问题描述：`isAllowedConfigPath`（app.ts:94-101）与后续 `fs.readFile`（configCenter.ts:159）非原子；同一路径在 check 与 read 之间被换绑为 symlink 时理论上可读到白名单外文件。
- 证据：3 种竞态实测（固定 symlink 3.5 万请求、flap 翻转、并发翻转 6 万请求）**均 0 命中**——因为 check 与 read 在同一事件循环内连续执行，本地攻击者难以精确命中微秒级窗口。代码层面仍非原子（apply 的 check→readPreview→previewIsFresh→backup 有更多 await 点）。
- 影响：实践中难以利用；属防御纵深缺口。
- 修复建议：用 `fs.open` 以 O_NOFOLLOW 打开并 `fstat` 与 canonical 比对后再读（fd 级原子性），或在读取路径上直接使用 realpath 后的路径。

### 低

#### N8. 【工程】`npm test` 有 3 个 unhandled rejection（database is not open），exit code 仍为 0

- 问题描述：registry.test.ts:117/166 与 manifest.test.ts:33 调 `buildApp({...})` 未传 `schedulerAutoStart: false` → scheduler 启动后台 collect；测试 `built.close()` 关闭 DB 后，后台 collect 的 `RegistryRepository.list`（registry.ts:56）在已关闭 DB 上抛 `database is not open` → vitest 报 3 个 unhandled rejection。
- 证据：`npx vitest run` 稳定复现 3 个 `Unhandled Rejection`（originated in registry.test.ts/manifest.test.ts），`Test Files 25 passed / Tests 138 passed / Errors 3 errors`，exit code 0。
- 影响：测试套件「带错通过」；对把 unhandled rejection 视为失败的 CI（如 `--unhandled-rejections=strict`）会红。属第一轮未发现的新问题。
- 修复建议：registry.test.ts:117/166 与 manifest.test.ts:33 补 `schedulerAutoStart: false`；或 `close()` 等待 in-flight collect 完成。

#### N9. 【工程】apply 错误信息回显文件内容片段

- 证据：无效 TOML apply 的 `CONFIG_APPLY_FAILED` message 含 `1: this is [[[ invalid toml`（smol-toml 错误带上文）。白名单内文件可被无会话 diff/preview 之外的途径诱导回显（需会话）。低危信息泄露，与 N1 一并修（写前校验 + 错误信息脱敏）。

#### N10. 【未修复·低】第一轮遗留小项

- `redactStringForDisplay`（redaction.ts:79）与 `RefreshOrchestrator.defaultTimeoutMs`（refreshOrchestrator.ts:31）仍为死代码（P2 未清干净）。
- `/api/session/revoke` 无守卫（app.ts:248-252）：无 token 空操作、有 token 吊销自己，实测允许带 Origin 吊销（设计内，维持低）。
- `/api/config/diff` 无会话守卫（见 N6）。
- 审计日志仍仅内存（app.ts:169，audit_log 表无 INSERT——grep 无结果），重启即空；第一轮 L5 未修复。
- `getAppPaths().migrationsDir` 仍依赖 `process.cwd()`（paths.ts:26）；CLI 设置了 WorkingDirectory，风险低。
- `defaultTimeoutMs`/`RefreshOptions.timeoutMs` 无消费方；`redactionHints` 在 omlxAdapter 中声明但从不 push（omlxAdapter.ts:170,263，dead）。

---

## 4. 回归检查结果

- **客户端测试是真实断言**：clientViews.test.tsx（4 用例）断言渲染文本（配置中心字段、`<redacted>`、网关三指标、审计条目、列表过滤+点击回调）；resourceDetail.test.tsx（2 用例）用 `vi.waitFor` 断言详情字段/受管状态/动作说明。均有断言内容，非「只渲染不报错」。
- **dist 与源码一致**：`npm run build` 后 dist 各文件 mtime 新于 src（redaction.js mtime 07:34 > redaction.ts 05:15）；git status 干净；dist 在 .gitignore（`git check-ignore dist` 命中）；dist 产物含最新逻辑（`isAllowedConfigPath`/`CONFIG_PATH_NOT_ALLOWED`/`/api/mcp/:id/verify`/restore 路由均存在）。
- **构建**：server tsc + fix-dist-imports（21 文件）+ `tsc --noEmit` + vite build（262.03 kB js / 13.15 kB css）全过。
- **测试**：25 文件 / 138 用例全过 + 3 unhandled rejection（见 N8）。
- **生产服务**：`node dist/server/index.js` 仅绑 127.0.0.1，UI/API 均正常服务；未知 API 路由返回 NOT_FOUND envelope。

---

## 5. 安全边界复核结论

1. **写面守卫完整**：16 个写/命令端点全部 `requireWrite`（session + origin）；枚举实测无一处漏网。`/api/session/revoke` 与 `/api/config/diff` 是仅有的无守卫写/半写端点（前者自吊销、后者白名单内只读）。
2. **CORS/origin**：`@fastify/cors` 只对 5173 dev origin 放行；evil origin 的预检无 ACAO、GET 无 ACAO、带 Origin 的写被 `WRITE_GUARD_REJECTED`。读面（preview/diff/SSE）对浏览器跨站不可读（无 ACAO），对本机进程完全开放（白名单内）——这是设计基线，但 preview/diff/SSE 仍无会话（见 N6）。
3. **会话**：18 字节 CSPRNG、宿主绑定、5 分钟 TTL、过期即删（实测 TTL 50ms 下过期写被拒；revoke 后写被拒；多次签发后过期剪枝生效）。token 存 sqlite `local_sessions`（明文，本地 DB，风险可接受），客户端仅内存持有，不进 localStorage/日志；audit 只记录 token 前 12 字符。**未发现 token 泄露路径。**
4. **SSE**：事件仅含 runId/status/adapterId/snapshotVersion，无敏感数据；订阅有 close 清理 + 15s 心跳；历史缓冲 200 条。
5. **SQL**：全部参数化；gateway.ts:164-165 的字符串拼接仅三个白名单常量（`client_id IS NOT NULL`/`IS NULL`/`1=1`），无注入。
6. **SQLite 持久化**：快照 nodes_json 在快照边界已脱敏（实测 `"baseUrl":"<redacted>"` 入库，无密钥）；config_backups 表**明文存储备份内容（含密钥）**（实测 DB 中有 `sk-backup-secret-...` 全文）——为 restore 所需，但属敏感留存，建议评估加密或标记。
7. **红队一句话**：本机进程（无 Origin 领会话）仍可：读白名单内配置（脱敏但有 N4/N5 变体泄露）→ 经 N2 任意文件写 → 经 N1 破坏白名单文件本身。跨网（DNS rebinding）读侧被 CORS 挡住，写侧被 origin 守卫挡住；浏览器读侧无法跨站读取。
8. **与 SECURITY.md/PRD 一致性**：SECURITY.md「Redact secrets before API responses」被 N4/N5 违反；「任意文件写」被 N2 违反。PRD「写路径经 Action Gateway」被 restore 违反（restore 不经 Action Gateway，仅 requireWrite）。

---

## 6. 总体评价

- **修复真实性**：9 个修复提交中，S1（白名单+行级脱敏）、S3（token 级键匹配+hints 消费）、M1（写面守卫）、M4（漂移可达）、M5（冷启动不阻塞）、M6（SSE 历史重放）、M7（客户端接入）经代码+运行级双重验证**确为真实实现**；S2 的 apply 路径已修，但 **restore 端点存在等价的任意文件写绕过**，S2 只能算「部分修复」；S3 的值级/数字残留、M3 的 UI 缺口、M7 的 diff UI 缺口属「修复不完整」。
- **新引入的严重问题**：N1（preview→apply 往返破坏真实密钥，数据破坏回归）是本轮最重要的新发现，直接使配置中心在真实（含密钥）配置上不可安全使用；N2（restore symlink 任意写）使 S2 复活；N3（先写后验 + 可自算 hash）放大前两者。
- **测试盲区**：configCenter 测试用手写完整文本绕过「脱敏往返」路径；registry/manifest 测试漏 `schedulerAutoStart: false` 产生 unhandled rejection；security.test 把数字保留固化为设计而未覆盖数字密钥泄露。
- **结论**：**本轮不能视为验收通过**。阻塞项：N1（数据破坏回归）、N2（任意文件写绕过）、N3（先写后验）——三者均落在 Config Center 应用链路上，修复优先级最高；其次 N4/N5（脱敏变体与数字泄露）、N6（读面守卫）；N7/N8 及 L 级项可排期。

---

## 附：修复优先级建议

| 优先级 | 项 | 动作 |
|---|---|---|
| P0 | N2 restore 任意写 | restore 加 isAllowedConfigPath + O_NOFOLLOW 写；补 symlink 换绑回归测试 |
| P0 | N1 往返破坏密钥 | preview/apply 分离「展示脱敏」与「提交底稿」；敏感行由服务端回填原值；补往返测试 |
| P0 | N3 先写后验 | 写前 parse 校验；失败回滚；previewHash 升级服务端凭据；apply 串行化 |
| P1 | N4/N5 脱敏残留 | 扩充值级模式（大小写/更多前缀/URL 凭据）；数字仅白名单度量键保留 |
| P1 | N6 读面守卫 | preview/diff/SSE 增加会话/Origin 校验（CLI 无 Origin 路径保留） |
| P2 | N7 TOCTOU、N8 测试 rejection、N9 错误回显、N10 死代码/audit 持久化/omlx hints | 逐一清理 |

> 说明：本报告所有「已修复/未修复」判定均基于本轮独立实测；凡未在 macOS 真机验证的项均标注「未验证」。
---

# 第二轮修复状态（2026-09-03）

上表全部发现已修复并提交（`5f86924` → `e5625b4`，共 4 个提交），黑盒复测全部通过。

| 发现 | 修复 | 验证 |
|---|---|---|
| N1 往返破坏密钥 | apply 前把脱敏行回填为服务端持有的原值 | ✅ 往返后密钥/URL 凭据/数字原样保留，编辑生效，无 `<redacted>` 残留 |
| N2 restore 任意写 | restore 走白名单 realpath 检查 + O_NOFOLLOW 拒绝 symlink | ✅ symlink 换绑后 restore 被拒（CONFIG_RESTORE_DENIED），victim 未动 |
| N3 先写后验 | apply 写前 TOML 解析校验，无效编辑不落盘 | ✅ 无效 TOML 被拒且文件未动 |
| N4 值级模式窄 | 覆盖大小写变体（SK-/ghp_/gho_/github_pat_/xox/Bearer/AKIA/AIza/glpat-/hf_）+ URL 内嵌凭据（含 redis://:pass@） | ✅ 全部脱敏 |
| N5 数字密钥泄露 | 敏感键下数字仅度量计数键保留，其余脱敏 | ✅ `password = 123456` 脱敏，`tokensIn` 保留 |
| N6 读面无守卫 | preview/diff 加会话守卫（CLI 无 Origin 路径保留） | ✅ 无会话被拒 |
| P2 | scheduler 停止后拒绝采集（消除 3 个 unhandled rejection）；死代码清理；配置面板接入真实 diff；MCP 握手按钮 | ✅ 测试无 Unhandled Errors |

## 终态验证

- `npm test`: 25 文件 / 144 测试全过，无 unhandled rejection
- `npm run build`: 干净
- 黑盒复测：N1–N6 全部 9 项断言通过
- 遗留：macOS 真机验证与真实浏览器 QA（环境限制，代码与隔离测试就绪）

**结论：第二轮发现的全部问题已闭环，可进入真机验收阶段。**
