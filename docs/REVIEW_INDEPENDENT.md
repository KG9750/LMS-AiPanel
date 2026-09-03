# LMS-AiPanel 独立审查报告（REVIEW_INDEPENDENT）

- 审查日期：2026-09-03
- 审查对象：/workspace/LMS-AiPanel（commit 51d14ec，28 个提交，工作区干净）
- 审查方式：独立取证。不信任任何既有结论（包括 docs/RELEASE_GATE.md），全部通过运行命令、读取源码、启动真实服务实测验证。
- 依据：GitHub 21 个 issue（#1–#6、#8–#23，页面正文抓取自 github.com/KG9750/LMS-AiPanel/issues/N）的验收标准为唯一验收依据；docs/RELEASE_GATE.md 仅作交叉参考，凡与其冲突处均以实测为准。
- 环境：Linux x86/arm 容器，Node v24.20.0，npm 10.x，vitest 4.1.5，vite 8.0.11，Fastify 5.8.5。macOS 专属功能（LaunchAgent、launchctl、docker 等）无法真机验证，结论中以「未验证（macOS 真机）」标注。

---

## 1. 审查范围与方法

- **独立验证**：`export HOME=/tmp && npm test`（23 个文件、116 个用例）；`export HOME=/tmp && npm run build`（server tsc + typecheck + vite client）。
- **验收核对**：对每个 issue 逐条验收标准，对照源码（文件:行号）与测试（tests/*）逐一取证；对易"表面实现"的点（SSE、epoch、网关不存 body、origin/session 守卫、ActionRun 状态机、Config Center 原子写、CLI status、脱敏）做了代码级与运行级双重验证。
- **安全与边界审查**：密钥脱敏绕过、会话 token 泄露、跨源写、路径穿越（config preview/apply/diff 的 path 参数）、SSE 资源泄漏、SQL 注入面、红队视角（DNS rebinding、任意本地进程、数据投毒）。
- **运行级实测**：以生产构建 `node dist/server/index.js`（仅绑 127.0.0.1）启动真实服务，对以下行为做了黑盒验证：
  - 未授权访问 `/api/config/preview`（任意路径、返回全文）、`/api/config/diff`（任意路径、返回全文 diff）；
  - 未授权 POST `/api/refresh`、`/api/metrics` 成功（无 session）；
  - 有 session + 合法 previewHash 时 `/api/config/apply` 可覆盖**任意已存在文件**（实测将 /tmp/secret-config.toml 改写为 `model = "pwned"`）；
  - 含密钥的 TOML 经 preview 返回 `rawContent` 全文（`token = "sk-real-secret-abc"` 明文）；diff 的 removed 行同样明文；
  - SSE：真实 HTTP 连接收到 `run → adapter×N → run(completed) → snapshot` 顺序；**迟到连接（run 已完成）只收到 adapter 事件、收不到 snapshot 事件**；
  - 冷启动 0.4s 内 GET /api/graph 在请求期间触发完整收集（响应 52ms，说明收集是同步内联完成的）。

---

## 2. 独立验证结果（test / build）

### npm test（HOME=/tmp）

```
Test Files  23 passed (23)
     Tests  116 passed (116)
   Duration  5.69s
```

- 全部通过，无 skip（`grep -rn "it.skip|describe.skip|xit|test.skip"` 无结果）。
- 23 个测试文件，116 个 `it()` 块，与 RELEASE_GATE.md 声称的"23 test files, 116 tests"一致。
- 注意：cli.test.ts 依赖 `dist/` 产物（tests/cli.test.ts:20,32,98），即**测试套件要求先构建**；本次运行前 dist 已存在且为最新（构建后重跑测试仍通过）。

### npm run build（HOME=/tmp）

```
tsc -p tsconfig.server.json        # 通过（严格模式）
node scripts/fix-dist-imports.mjs  # 修复 21 个文件的扩展名导入
tsc --noEmit                       # 通过
vite build                         # dist/client/index.html + 251.66 kB js + 10.18 kB css
```

- 构建干净。`dist/server/index.js` 可在纯 node 下运行，实测绑定 127.0.0.1 并服务 UI 与 API。

### 附注（不影响结论）

- RELEASE_GATE.md 声称"（npm test）no skipped critical tests" —— 属实。
- RELEASE_GATE.md 声称生产服务对未知 API 路由返回 NOT_FOUND envelope —— 属实（app.ts:981-998）。

---

## 3. 发现清单（按严重度）

### 严重

#### S1. `/api/config/preview`、`/api/config/diff`：未授权任意文件读取 + 密钥明文泄露（脱敏绕过）

- 位置：src/server/app.ts:811-827（preview）、830-841（diff）；src/domain/configCenter.ts:157-189（readPreview）；src/domain/redaction.ts:12-30。
- 证据：
  - preview 无 session 守卫、无 origin 守卫、**无路径白名单**：`filePath = request.query.path ?? options.configPath ?? ""`（app.ts:812），直接 `fs.readFile(filePath)`（configCenter.ts:158）。
  - 响应经 `envelope()`（app.ts:146-152）调用 `redactValue`，但脱敏只匹配**键名**（redaction.ts:1,20-21），`rawContent` 键不匹配敏感模式，字符串值原样返回（redaction.ts:29）。`documentedFields[].value`、`undocumentedFields[].value` 同理只对键名脱敏。
  - 运行级实测（生产服务）：
    - `GET /api/config/preview?path=/tmp/secret-config.toml` 返回 `rawContent` 全文，含 `token = "sk-real-secret-abc"`、`api_key = "key-value-xyz"` 明文；`undocumentedFields` 中的 `secret_section.token` 反而被脱敏，**同一响应的不同字段脱敏不一致**，证明这是绕过而非设计。
    - `POST /api/config/diff`（同样无守卫）返回 `removed` 行明文：`token = "sk-real-secret-abc"`。
    - 对任意路径（如 /etc/hostname、任意用户文件）同样可读（TOML 解析失败也会回显错误信息中的内容）。
  - 影响：
    - 本机任意进程/其他本地用户可通过 API 读取服务进程可读的任意文件（~/.ssh、~/.aws、~/.claude、~/.codex 配置等），并拿到其中**明文密钥**。服务进程以操作者身份运行，即等于操作者身份的任意文件读取。
    - 对浏览器攻击面：GET 响应受同源策略/CORS 保护，恶意网页直接读不到；但**DNS rebinding**（攻击域名解析到 127.0.0.1）可使恶意页面与 localhost 服务同源，从而读取响应——origin 守卫只拦写（且只拦带 Origin 的请求），拦不住本类 GET。
    - 直接违反项目自身安全基线（docs/SECURITY.md："Redact secrets before API responses"）与 PRD 成功标准（"No API … includes plaintext secrets"）。
- 修复建议：
  1. preview/diff/apply 统一收敛到**路径白名单**（如 `~/.codex/config.toml` 解析后的真实路径，并拒绝符号链接逃逸）；
  2. preview 响应**移除 rawContent**（或对 rawContent 整体做结构化重解析后再逐字段脱敏）；
  3. diff 响应按行做敏感值级脱敏（对 removed/added 行应用正则 `sk-…`/`Bearer …` 等值级脱敏）；
  4. 至少给 preview/diff 加与 apply 相同的 session+origin 守卫（缓解 DNS rebinding 读取面）。

#### S2. `/api/config/apply`：任意已存在文件的内容覆盖（任意文件写原语）

- 位置：src/server/app.ts:844-902（apply 路由）；src/domain/configCenter.ts:221-272（apply 实现）。
- 证据：
  - `filePath = request.body.path ?? ""`（app.ts:853）无任何路径约束；apply 流程 = 校验 previewHash → backup → 写临时文件 → fsync → `rename(tmp, filePath)`（configCenter.ts:246-255）。
  - 守卫仅有 `requireWrite`（session+origin）。任何本机进程可自行 POST /api/session 获得 token（session.test.ts:120-134 明示 CLI 无 Origin 路径合法），从而满足守卫。
  - 运行级实测：POST /api/session 取 token → GET preview 取 hash → POST /api/config/apply（path=/tmp/secret-config.toml, content=`model = "pwned"`）→ **文件被覆盖为 `model = "pwned"`，响应 ok=true**。（新路径 apply 会因 readPreview 读不到文件而失败，但**任意已存在文件**均可覆盖，且原内容被写入 config_backups 表。）
  - 影响：本机任意进程可覆写操作者可写任意文件（~/.bashrc、~/.zshrc、~/.ssh/authorized_keys、~/.claude/settings.json 等），等于任意文件写 + 触发 shell/工具链在下次使用时加载恶意内容；同时备份保留在服务 DB 中造成敏感内容留存。issue #19 只授权"一种受支持的配置类型（Codex config.toml）"，实现未做任何类型/路径绑定。
- 修复建议：
  1. apply 的路径必须来自受支持的配置类型解析（拒绝任意 path 参数）；对最终路径做 `path.resolve` + 目录白名单 + 符号链接检查；
  2. apply 仅在 previewHash 由服务端签发且绑定该路径时才接受（把 previewHash 从"文件内容哈希"升级为"服务端签发的 (path,hash,nonce) 凭据"）。

#### S3. 脱敏键名模式误伤与覆盖缺口（键值不对称 + `helper`/`auth` 子串误报）

- 位置：src/domain/redaction.ts:1,20-21。
- 证据：
  - 模式 `/(token|api[_-]?key|secret|password|credential|auth|helper)/i` 是**子串匹配**：`author`、`authorName`、`coauthor`、`authority`、`authentication`、`helperScript` 均被误判为敏感（运行验证）。
  - 键值不对称：**数字/布尔值不脱敏**（redaction.ts:21），若某密钥以数字形式出现（罕见但存在，如 `"token": 123456`）会直接泄露；同时**值级完全不脱敏**——任何放在非敏感键名下的明文密钥（如 `{"data": {"raw": "sk-…"}}`）原样通过。
  - `redactionHints`（适配器声明敏感路径）**没有任何消费方**：grep 显示 hints 只被生产（omlxAdapter/claudeConfigAdapter）与 schema 定义，domain/server 无一处读取应用（src/domain、src/server 无 redactionHint 引用）。即"红action 提示"是死数据，脱敏完全依赖键名猜测。
  - 影响：误伤导致 UI 数据缺失（author/helper 等键被抹掉）；漏报导致密钥泄露（与 S1 叠加是 preview 泄露的主因之一）。规则是"黑名单猜测"而非"白名单+显式提示"，与 SECURITY.md 声称的"Redact secrets before … UI rendering"不符。
- 修复建议：改为"键名黑名单（精确词）+ 值级正则（`sk-[A-Za-z0-9]`、`Bearer …`、`AKIA…`）+ 适配器显式 redactionHints 白名单"三层；数字/布尔一律按敏感键脱敏。

### 中等

#### M1. `POST /api/refresh`、`POST /api/refresh/:id/cancel`、`POST /api/metrics`、`POST /api/actions/plan` 无 session 守卫（#16 验收"Write and command endpoints reject missing … sessions"未覆盖）

- 位置：app.ts:333（refresh）、359（cancel）、404-414（metrics）、589-631（plan）。
- 证据：
  - 四个端点均无 `requireWrite`；与守卫齐全的 registry/actions/runs/config/apply/gateway/clients（app.ts:457,635,679,701,739,769,845,906,934）对比明显。
  - 运行级实测：无 session 的 `POST /api/refresh` 返回 ok=true 并创建 run；`POST /api/metrics` 返回 ok=true 并写入样本。
  - session.test.ts 只对 /api/registry 断言守卫（tests/session.test.ts:35-41），对上述端点无覆盖——即测试通过不等于守卫存在。
  - 影响：refresh/cancel 属"命令端点"（启动/取消后台采集并产生副作用），metrics 属"写端点"（注入任意样本：可伪造 Token 遥测、污染趋势与计数，即**数据投毒**面）。任何本机进程/被 rebinding 的页面均可触发。严重度定中等，因为写内容本身非敏感、且本机进程本可直连；但**与验收标准直接冲突**且 metrics 无校验来源标识（source 可任意填写）。
- 修复建议：refresh/cancel/metrics/plan 按 #16 语义加 `requireWrite`；metrics 若需供适配器内部使用，改为进程内直调而非开放 HTTP 端点（当前没有任何适配器调用该 HTTP 端点，全部为进程内 record）。

#### M2. Config preview/apply/diff 无路径限制 ⇒ S1/S2 的组合放大（DNS rebinding 可读、任意进程可写）

- 位置：app.ts:812,853,831。
- 证据：与 S1/S2 相同链路。单独列出以强调：**路径穿越不是"绕过白名单"，而是根本没有白名单**。issue #19 验收"Choose one supported configuration type"未落实为任何路径约束；预览/应用对"受支持配置类型"的语义只体现在响应头 `configType: "codex-config-toml"`（configCenter.ts:181），与文件内容无关。
- 修复建议：同 S1/S2。

#### M3. MCP 能力层（#21 的"capability 手工握手"）未接入任何 API 路由——功能只存在于单元测试

- 位置：src/adapters/mcpAdapter.ts:173-222（verifyCapabilities）；src/server/app.ts（无任何路由调用）；tests/mcp.test.ts:104-124（直接调用类方法）。
- 证据：`grep -rn "verifyCapabilities" src/` 只有 mcpAdapter.ts 定义处；`src/server/app.ts` 无 MCP 相关路由；客户端无调用。UI 上 MCP 节点 `capabilityVerified` 恒为 false（mcpAdapter.ts:89-95）。
- 影响：issue #21 验收"Capability inspection requires a managed server or explicit manual command"中"explicit manual command"路径**不存在**——产品面没有"受管服务器+手动命令"触发能力握手的能力，capability-verified 状态在产品中不可达。验收标准部分未满足。
- 修复建议：增加 `POST /api/mcp/:serverId/verify`（requireWrite + registry managed 检查）路由并接线 UI，或明确将该层降级为"仅单元级能力"并在文档中如实声明。

#### M4. Assistant 模型路由漂移（#15 "route drift are distinct states"）逻辑不可达

- 位置：src/adapters/assistantAdapter.ts:310-331。
- 证据：`live` 只可能被赋值为 `configured`（第 316 行 `if (body.data?.some(...)) { live = configured; }`）或保持 undefined；`drift = Boolean(live && live !== configured)`（第 323 行）恒为 false。**代码路径上漂移状态永远不可能产生**；`routeNode.state = "warning"`（第 325 行）为死分支。assistant.test.ts 也未断言任何 drift=true 场景。
- 影响：验收"Instance stopped, Channel unreachable, endpoint unreachable, and route drift are distinct states"中 route drift 未真实实现（其余三个状态有实现与测试）。中等级：功能缺口而非安全缺口。
- 修复建议：live 应记录"端点实际提供的模型列表"（例如 `live = body.data?.map(id)` 或端点上发现的实际 serving 模型），再与 configured 比较。

#### M5. `#4` 验收"GET overview … do not initiate a full collection"存在冷启动例外

- 位置：src/server/app.ts:237-254（`/api/graph` 无快照时同步 `scheduler.collect("all")`）。
- 证据：运行级实测——空数据目录冷启动 0.4s 时 GET /api/graph 在**请求期间**完成全部 13 个适配器收集并返回 version=1 快照（响应 52ms，说明收集被内联等待）。scheduler.test.ts 的"GET requests do not initiate collection"测试在**先手动 collect 过**的前提下进行（tests/scheduler.test.ts:83-89），未覆盖冷启动路径。
- 影响：与验收字面冲突；实际影响较小（仅冷启动首请求，且后台调度器也会做同样收集），但属于"表面实现"疑点被实测坐实的例子。若某适配器慢（如 docker ps 卡住），冷启动首屏会阻塞到超时。
- 修复建议：冷启动由调度器立即触发后台收集，GET 一律返回"暂无快照"或恢复的旧快照；或至少在文档中声明该例外为设计。

#### M6. SSE 断线恢复的"恢复"语义：迟到/重连连接收不到已完成 run 的 snapshot 事件

- 位置：src/domain/sseHub.ts:11-33（纯内存、无历史回放）；src/server/app.ts:376-399（SSE 路由）；src/domain/refreshOrchestrator.ts:88-93（完成事件仅在 run 结束时发布一次）。
- 证据：运行级实测——先 POST /api/refresh 完成 run，再建立 SSE 连接：只收到 13 条 adapter 事件，**没有 run(completed) 与 snapshot 事件**（hub 只向"当前订阅者"广播，迟到订阅者拿不到历史）。
- 影响：验收原文是"disconnect recovery by polling the run and latest snapshot"——**轮询恢复确实实现**（refresh.test.ts:118-140 验证 run 持久化 + GET 轮询），所以验收可判为通过；但产品实际并未让重连的浏览器自动恢复（客户端代码中**没有任何 EventSource / SSE 消费逻辑**，见 M7），SSE 整体是"服务端存在、客户端未使用"的半成品。事件顺序本身正确（实测 run→adapter×N→run→snapshot）。
- 修复建议：客户端接入 EventSource 并实现"连接即拉取最新 run 状态+最新快照"；或服务端在 SSE 连接时回放最近 run 的摘要事件。

#### M7. 客户端 UI 与多项验收能力脱节（#5 SSE 进度、#11 趋势图、#12 网关覆盖说明、#17/#18 动作确认执行 UI、#19 配置编辑 UI、#21 能力握手 UI 均无）

- 位置：src/client/main.tsx、src/client/resourceDetail.tsx（全文件）；grep 证据：client 无 EventSource、无 /api/session、无 actions/runs、无 gateway、无 config 编辑、无 mcp verify 调用。
- 证据：
  - `grep -rn "EventSource" src/` 无结果；`grep -rn "api/session" src/client/` 无结果；`grep -rn "gateway|/v1/chat" src/client/` 无结果；`grep -rn "actions/runs|confirm|execute" src/client/` 无结果。
  - main.tsx 只有：总览 + 资源表 + 轻量地图 + 漂移 + 采集器运行（main.tsx:271-508）；详情视图只有只读展示（resourceDetail.tsx:69-198），availableActions 只是 chip 无按钮。
  - 侧栏 9 个导航项（main.tsx:24：运行总览/AI 工具/AI 助手/本地模型/运行框架/技能/MCP/配置中心/审计日志）**全部渲染同一个总览页**——导航是装饰性的，无对应视图。
- 影响：验收标准明确要求"UI shows progress, partial failure, completion, and reconnect states"（#5）、"UI displays recent Token and memory trends"（#11）、"UI explains covered and uncovered traffic"（#12）、"UI shows the exact actions declared by the adapter manifest"（#18）等 UI 类标准**未达成**；服务端能力存在但产品无法操作（SSE、会话、动作、配置、MCP 握手）。这是"声称完成但实际为服务端 API 完成 + UI 未接"的最大类别差距。
- 修复建议：按验收标准逐项补齐客户端接入（会话获取、动作确认/执行、配置预览/编辑/应用、网关覆盖说明、SSE 进度、遥测趋势），或如实将 UI 范围降级并更新 RELEASE_GATE。

### 轻微

#### L1. `RefreshOrchestrator.defaultTimeoutMs` 死参数；#5 验收"timeout"无集成测试

- 位置：src/domain/refreshOrchestrator.ts:31；app.ts:110 构造未传超时；tests/refresh.test.ts 无 timeout 用例（实测 grep 无）。
- 影响：超时实际由 AdapterRuntime.withTimeout（src/adapters/runtime.ts:66-73,110-123）保证，功能存在；但 orchestrator 层参数是死代码，验收"integration tests cover … timeout"未满足（只覆盖了 event order / disconnect / cancellation）。

#### L2. `selectAdapters` 快慢分派与 manifest 间隔语义偏差

- 位置：src/domain/scheduler.ts:120-130；app.ts:98-102（fast 30s/slow 120s）。
- 证据：`intervalSeconds=15` 的适配器（omlx/mlx/llama/ollama）落在 fast 循环（30s），实际采集周期被拉长到 30s（非 15s）；`=60` 的落在 slow（120s），被拉长 2 倍。快慢分组只是"≤30 / >30"两档，未按各自 interval 独立调度。验收"adapter-specific schedules continue independently"仅部分成立（两档，非逐适配器）。
- 影响：功能可用，节奏与声明不符；记轻微。

#### L3. `getAppPaths()` 的 `migrationsDir` 依赖 `process.cwd()`

- 位置：src/storage/paths.ts:26。
- 影响：若服务从其他目录启动（如 LaunchAgent WorkingDirectory 已设 ROOT，cli/index.ts:65 有设置），依赖 cwd 正确；否则迁移目录找不到。当前 CLI/LaunchAgent 均设了 WorkingDirectory，风险低，但比绝对路径脆弱。

#### L4. `/api/session/revoke` 无 session 校验

- 位置：app.ts:217-221。
- 影响：无 token 时 revoke 空操作；有 token 时任何人都能吊销**自己已知的** token（本机模型下影响极小），但严格说也属"写端点无守卫"。与 M1 一并处理即可。

#### L5. 审计日志 `auditLog` 仅内存、不持久化

- 位置：app.ts:138；无 audit_log 表写入（迁移里虽有 audit_log 表但代码从未 INSERT——grep `INSERT INTO audit_log` 无结果）。
- 影响：/api/audit 重启即空；issue #19 验收"all apply operations create ActionRun and audit evidence"中 audit 证据不跨重启。ActionRun 本身持久化，故影响有限。

#### L6. `dist/` 被 git 忽略但 cli.test.ts 依赖它；测试与构建顺序耦合

- 位置：.gitignore 忽略 dist/；tests/cli.test.ts:20,32,98 直接 exec dist/cli/index.js。
- 影响：全新克隆后必须先 `npm run build` 再 `npm test`，否则 cli 测试失败。RELEASE_GATE 的验收顺序（先 test 后 build）与测试实现矛盾，属工程卫生问题。

#### L7. `redactStringForDisplay` 未在任何生产代码中调用

- 位置：src/domain/redaction.ts:32-36。
- 影响：死代码（唯一消费者无；grep 仅定义处）。

#### L8. oMLX 执行器 `stop`/`load-model`/`unload-model` 不执行任何真实命令；`start` 的 execa 失败被 `.catch()` 吞掉

- 位置：src/adapters/omlxAdapter.ts:99-115。
- 证据：stop/load/unload 直接返回 `ok: true` + "command issued"证据字符串，未调用任何进程/API；start 的 `execa("omlx", ...).catch(() => {})` 把失败吞掉后仍返回 ok:true（随后 verifyEvidence 会以真实证据判定，见 131-154，所以**不会**错误地标记 succeeded——这是设计意图：execute 只"请求"，verify 才判真）。RELEASE_GATE.md:96-103 已如实声明真机步骤待操作者执行，故不算隐瞒；但"执行"二字名不副实（#18 验收"dedicated real test instance passes manual start/stop"在 CI 侧未验证，只能算"未验证（macOS 真机）"）。
- 影响：符合已知限制声明；记轻微，提醒验收时注意 #18 的"手动验证"仍是未完成项。

#### L9. `rollback` 在无 executor 时构造假 executor 传参（死参数）

- 位置：app.ts:751（`executor ?? ({...} as AdapterActionExecutor)`）；actionRun.ts:163-175 的 rollback 实际不使用 executor。
- 影响：`as AdapterActionExecutor` 类型掩盖；行为上 rollback 只追加证据，不真正回滚配置（config restore 是另一条路径）。rollback 语义被稀释为"标记"，记轻微+建议文档说明。

#### L10. 类型安全：`as never`/`as unknown as` 使用点

- 位置：app.ts:474（`registry.create({...} as never)`）、app.ts:179-183、metrics.ts:179、sessions.ts:53 等（node:sqlite 行映射）。
- 影响：node:sqlite 行类型无法静态推导，使用断言可接受；`as never` 一处属应清理。低风险。

#### L11. `plan` 路由对"read"动作不校验资源存在性

- 位置：app.ts:595-606。
- 影响：`action=read` 时对任意 resourceId 返回可执行 read 计划（无副作用，计划本身不执行）。轻微。

#### L12. 快照保留 50 版、metrics 保留 7 天/24h 细粒度——RETENTION 与文档一致但"小时级降采样"是占位

- 位置：src/storage/snapshots.ts:45；src/storage/metrics.ts:46-47,197-217。
- 证据：RELEASE_GATE.md:107-109 已如实声明 hourly downsampling 是 placeholder。`applyRetention` 中 `void HOURLY_AGE_SECONDS`（metrics.ts:217）确认占位。与文档一致，无隐瞒；记建议级。

---

## 4. 各 issue 验收标准核对表

> 判定：✅ 通过（实现+测试/实测满足验收）；🟡 部分通过（核心成立但有缺口）；❌ 未通过（关键验收点未实现）；➖ 未验证（需 macOS 真机/人工步骤）。

| Issue | 判定 | 一句话证据（文件:行号） |
|---|---|---|
| #1 Host Identity | ✅ | hostId 持久化+幂等迁移（storage/host.ts:31-48；tests/host.test.ts:38-76）；所有 API 响应 hostId 作用域（app.ts:146-152；tests/host.test.ts:98-129）；UI 显示 host（hostBadge.tsx:30-35）。 |
| #2 能力 Manifests | ✅ | 13 个适配器全部通过 manifest schema（tests/manifest.test.ts:21-30）；invalid 隔离（app.ts:77-93；tests/manifest.test.ts:46-98）；supported/unsupported/unavailable/failed 区分（adapters/types.ts:44-62；tests/manifest.test.ts:100-135）。 |
| #3 注册表 | ✅ | 发现默认只读（registryMerge.ts:52-57）；supplement 物化未验证资源（103-128）；冲突产生 attention（57-65,94-97；tests/registry.test.ts:92-107）；临时存储测试（tests/registry.test.ts）。 |
| #4 后台 Scheduler | 🟡 | 常规 GET 不触发收集（scheduler.ts:77-79；tests/scheduler.test.ts:66-90）✅；但冷启动 GET /api/graph 同步收集（app.ts:237-254，实测坐实）❌；单调版本+重启持久（scheduler.ts:98-117；tests/scheduler.test.ts:92-111）✅；失败隔离+stale 回退（adapters/runtime.ts:89-106；tests/scheduler.test.ts:173-200）✅；快慢 profile 仅两档近似（scheduler.ts:120-130）🟡。 |
| #5 RefreshRun+SSE | 🟡 | run 立即返回（refreshOrchestrator.ts:41-53；实测）✅；SSE 顺序 run→adapter→snapshot（实测+refresh.test.ts:87-116）✅；单飞复用（refreshOrchestrator.ts:43-45；tests/refresh.test.ts:142-157）✅；断线轮询恢复（tests/refresh.test.ts:118-140）✅；**迟到连接收不到已完成 run 的 snapshot 事件**（实测）🟡；timeout 无集成测试（tests/refresh.test.ts）❌；客户端无 EventSource 消费（见 M7）❌。 |
| #6 oMLX 统一推理域 | ✅ | Runtime/Endpoint/Artifact/Instance 四类身份（omlxAdapter.ts:172-260；tests/omlx.test.ts:52-74）；显式证据状态（183-228）；内存层级（190,252）；端点级 Token 不捏造客户端归属（tests/omlx.test.ts:104-116）；fixture 覆盖 running/stopped/缺失遥测（tests/omlx.test.ts）。 |
| #8 MLX Server | ✅ | 注册端点+进程发现（mlxServerAdapter.ts:53-121）；端点验证后才 live（83-106）；fixture 覆盖 running/stopped/unreachable（tests/runtimes.test.ts:38-64）。 |
| #9 llama.cpp | ✅ | 进程/注册端点单一运行时（llamaCppAdapter.ts:57-75）；OpenAI/llama 身份分记（93-97；tests/runtimes.test.ts:66-84）；serving 不凭进程推断（tests/runtimes.test.ts:86-93）。 |
| #10 Ollama | ✅ | 已装/已加载分离（ollamaAdapter.ts:119-147；tests/runtimes.test.ts:97-138）；API/进程/端点证据独立（94-117；tests/runtimes.test.ts:150-163）；不可用不拖垮（140-148）。 |
| #11 计数器 Epochs | ✅ | 回滚开新 epoch、delta 永不为负（metrics.ts:85-108,151-171；tests/metrics.test.ts:43-60）；host/资源/来源/覆盖元数据（88-105）；current+window delta（109-135）；UI 趋势**未实现**（见 M7，client 无趋势图）🟡 → 综合 🟡。 |
| #12 网关 | 🟡 | 转发到受管端点（gateway.ts:14-107；tests/gateway.test.ts:45-89）✅；**只存指标、无 body**（gateway.ts:39,56-58；gateway 存储无 content 列：storage/gateway.ts:1-178；测试断言无 prompt/response 文本：tests/gateway.test.ts:83-85）✅；provider 独立+直连=unattributed（tests/gateway.test.ts:91-126）✅；**UI 无覆盖/未覆盖说明**（M7）❌；"real test client request manually verified"（tests/gateway.test.ts:60-69 为自动化 fake，非人工真机）➖。 |
| #13 运维工作台 | 🟡 | 注意力优先排序（operations.ts:43-97；tests/operations.test.tsx:48-90）✅；运行中组件带证据（100-104）✅；RefreshRun/ActionRun 活动页：**只显示 adapter 活动，无 RefreshRun/ActionRun**（operations.ts:106-111 仅 adapterRuns）❌；窄屏/桌面 QA 仅 jsdom（tests/operations.test.tsx）🟡；**导航 9 项全是同一页**（M7）❌。 |
| #14 资源详情 | ✅ | 稳定 ID 深链（app.ts:262-323；tests/resourceDetail.test.ts:65-89）✅；unsupported/unavailable 分述（adapters/types.ts:44-62）✅；证据带来源+时间（app.ts:317-321；tests/resourceDetail.test.ts:76-78）✅；managed+动作可见但不可绕过（app.ts:299-304；tests/actionRun.test.ts:263-281 未授权 execute 被拒）✅；覆盖 runtime/model/assistant/config（tests/resourceDetail.test.ts:91-101）✅。 |
| #15 Assistants | 🟡 | 定义/实例/Channel/路由分离（assistantAdapter.ts:71-152；tests/assistant.test.ts:28-74）✅；失败态区分（88-115）✅；Channel 密钥/消息不入资源（tests/assistant.test.ts:62-64）✅；**route drift 逻辑不可达**（M4）❌；聚合状态不隐藏证据（137-151）✅。 |
| #16 Session+Origin | 🟡 | 只读 GET 无副作用（tests/session.test.ts:26-33）✅；写端点拒无/过期/无效 session（35-88）✅ 但**仅 registry 被测**；跨源写拒（90-118）✅；CLI 无 Origin 路径（120-134）✅；**refresh/cancel/metrics/plan 无守卫**（M1）❌；session token 18 字节随机（sessions.ts:30）+宿主绑定（52）✅。 |
| #17 ActionRun 状态机 | ✅ | 非法转换拒绝（actionRun.ts:19-30,84-86,112-114；tests/actionRun.test.ts:56-63）✅；仅受管+声明动作可执行（actionGateway.ts:63-111；tests/actionRun.test.ts:65-80）✅；成功依赖验证证据（actionRun.ts:120-143；tests/actionRun.test.ts:82-110）✅；重启复验（app.ts:768-804；tests/actionRun.test.ts:170-206）✅；临时运行时覆盖成功/超时/验证失败/回滚（tests/actionRun.test.ts:112-168）✅。 |
| #18 oMLX 受管控制 | 🟡 | 自动发现保持只读（tests/omlxControl.test.ts:43-67）✅；UI 显示声明动作：**仅 chip 展示无执行按钮**（M7，resourceDetail.tsx:175-183）🟡；每个动作重检进程/端点/模型/内存证据（omlxAdapter.ts:131-154；tests/omlxControl.test.ts:79-98）✅；连接数不确定性展示：**仅测试内构造属性，无真实接线**（tests/omlxControl.test.ts:100-138）🟡；真机 start/stop 验证：**未执行**（RELEASE_GATE.md:96-103 声明为待办）➖。 |
| #19 Config Center | 🟡 | 字段元数据齐全（configCenter.ts:27-88；tests/configCenter.test.ts:34-53）✅；未知字段往返保留+标 undocumented（176-178；tests/configCenter.test.ts:55-76）✅；外部变更使 preview 失效（192-199；tests/configCenter.test.ts:78-101）✅；临时目录+备份恢复（tests/configCenter.test.ts:103-139）✅；apply 产生 ActionRun+audit（app.ts:867-893）✅；**路径无白名单 ⇒ 任意文件读/写**（S1/S2）❌；"Choose one supported configuration type"未约束（S2）❌。 |
| #20 Skills | ✅ | 远端升级仅在有可验证来源+版本时显示（skillsAdapter.ts:112-131；tests/skills.test.ts:44-62,98-115）✅；本地-only 不猜（64-71）✅；available/recommended 分离（116-121；tests/skills.test.ts:73-96）✅；usage 来自元数据且保未知（184-194；tests/skills.test.ts:142-156）✅；fixture 覆盖 git/registry/local/modified/invalid（tests/skills.test.ts）✅。 |
| #21 MCP 三层 | 🟡 | 自动采集不启动服务器（mcpAdapter.ts:48-104；tests/mcp.test.ts:72-90）✅；**能力握手无 API/UI 路径**（M3）❌；仅保留能力元数据、无工具业务结果/env（mcpAdapter.ts:204-218；tests/mcp.test.ts:104-117）✅；configured/running/reachable/capability-verified 状态区分（110-116；tests/mcp.test.ts）✅ 但 capability-verified 产品不可达。 |
| #22 CLI 打包 | 🟡 | 服务仅绑 127.0.0.1+生产 UI/API（server/index.ts:3-8；tests/cli.test.ts:97-129）✅；status 验证进程+健康端点（cli/index.ts:96-136；tests/cli.test.ts:59-72）✅；install/upgrade 可重复并保留存储（138-159,294-313）✅；stop 移除端点并报告终态（212-263；tests/cli.test.ts:80-93）✅；**冷启动 GUI/浏览器验证与日志路径检查：未在 macOS 真机执行**（RELEASE_GATE.md:103-106 声明待办）➖。 |
| #23 v1 Gate 文档 | 🟡 | 四类套件通过且无跳过（第 2 节实测）✅；真机只读检查：RELEASE_GATE.md:36-55 声称在门禁机器上执行了 13 个适配器——**本审查无法复核该机器结果**，且 oMLX/MLX/llama/Ollama 均为 stopped/未安装（56-60）➖；写测试仅用受管测试实例（RELEASE_GATE.md:57-68，审查复核属实）✅；桌面/窄屏 QA：jsdom 组件测试（70-80）且无真实浏览器验证 ➖；无敏感/运行时数据入库（第 5 节：git 扫描无 sqlite/db/log/env/pem/key；密钥正则无匹配；实测复核一致）✅；**但 RELEASE_GATE 未披露 S1/S2/M1/M7 等差距** ❌（文档完整性问题）。 |

---

## 5. 安全审查结论

**总体**：项目安全模型的核心前提是"仅绑 127.0.0.1 + 只读适配器 + 键名脱敏 + Action Gateway 守卫写路径"。在该前提下，**最严重的问题是"localhost-only"边界内仍然存在无守卫的任意文件读写原语，且脱敏机制可被一键绕过**：

1. **任意文件读 + 密钥明文泄露（S1）**：`/api/config/preview`（无守卫 GET、无路径限制、rawContent 全文返回）与 `/api/config/diff`（无守卫 POST、全文 diff）——任何本机进程可直接读取操作者身份可读的任意文件及明文密钥；DNS rebinding 场景下恶意网页也可读。
2. **任意已存在文件写（S2）**：`/api/config/apply` 有 session+origin 守卫，但本机任意进程可自行领取 session（无 Origin 即可），从而覆写任意已存在文件（含 shell 启动文件、SSH 授权文件）。
3. **脱敏不对称（S3）**：键名子串黑名单 + 值不脱敏 + 数字/布尔不脱敏；`redactionHints` 无消费方。preview 的 rawContent 绕过是直接后果。
4. **写/命令端点守卫不完整（M1）**：refresh/cancel/metrics/plan 无 session 守卫；metrics 可作为无认证数据投毒通道。
5. **SQL 注入面**：所有 SQL 均使用 node:sqlite 参数化（`prepare().run(?,…)`），唯一字符串拼接处 `gateway.ts:158` 的 `clientFilter` 仅为三个常量（"client_id IS NOT NULL"/"client_id IS NULL"/"1=1"），无注入面。**未发现 SQL 注入。**
6. **会话 token**：18 字节 CSPRNG + 宿主绑定 + 5 分钟 TTL + 过期即删（sessions.ts:30,44,57-59），**无泄露路径**（audit 仅记录前 12 字符，app.ts:204）。/api/session 签发仅受 origin 守卫，本机进程可领——这是设计（无用户账户），但意味着 session 防线只防浏览器跨源，不防本机进程。
7. **SSE 资源泄漏**：订阅者 set 有 close 清理（app.ts:394-397）与 15s 心跳（390-392），实测断连后无泄漏迹象。**未发现泄漏。**
8. **跨源写**：origin 守卫 + CORS 仅放行 dev origin（app.ts:117-130,154-156）；带 Origin 的跨源写被拒（tests/session.test.ts:90-118）。**绕过面**：无 Origin 请求（CLI 路径）放行——设计如此；DNS rebinding 的写请求 Origin 为攻击域，会被拒。**主要绕过面是读（S1）而非写。**
9. **路径穿越**：不是"穿越白名单"，是**根本没有白名单**（S1/S2）。
10. **红队一句话**：拿到该服务任意端点的本机攻击者 = 操作者的文件读 + 文件写 + 遥测污染；跨网攻击者（DNS rebinding）至少可读任意文件。修复优先级 S1>S2>S3>M1。

**与 SECURITY.md/PRD 的一致性**：SECURITY.md 声称"Redact secrets before API responses"与 PRD"No API … includes plaintext secrets"——**被 S1/S3 违反**；PRD"Every write-capable code path is forced through the Action Gateway"——**被 M1（refresh/metrics/plan/cancel 绕过 Action Gateway）部分违反**（这些端点不经 Action Gateway）。

---

## 6. 总体评价

- **工程完整性**：28 个提交、10 个迁移、13 个适配器、23 个测试文件 116 用例全绿、构建干净、生产服务可运行、SQL 全部参数化、测试对多数核心行为有真实断言（不是"只不报错"）——**基础工程质量明显高于普通"表面实现"项目**。状态机、epoch、网关不存 body、外部变更守卫、CLI status 双重验证等"易造假点"经代码+运行级验证**确为真实实现**。
- **主要问题集中在两类**：(1) **安全边界**——Config Center 三端点无路径白名单 + preview/diff 无守卫 + 脱敏键值不对称，形成"任意文件读/写 + 密钥泄露"组合（S1/S2/S3），这是发布前必须修复的；(2) **验收差距**——大量 UI 类验收标准（#5 SSE 进度、#11 趋势、#12 覆盖说明、#17/#18 动作执行、#19 配置编辑、#21 能力握手）**只完成了服务端 API，客户端没有任何接入**，侧栏 9 个导航项渲染同一页；#15 路由漂移逻辑不可达、#21 能力层无路由、#16 四个写端点无守卫、#4 冷启动 GET 触发收集，均为"声称完成但实际未满足"的具体条目。
- **诚实性**：RELEASE_GATE.md 对"已知限制"（真机验证待办、小时降采样占位、快慢 profile 近似）的披露是真实的；但**未披露 S1/S2/M1/M7 等差距**，v1 门禁证据据此不完整。
- **结论**：**不能按当前状态通过 v1 发布门禁**。安全修复（S1/S2/S3）为阻断项；UI 接入（M7 涉及的 #5/#11/#12/#17/#18/#19/#21）与守卫补齐（M1）为发布前必修；其余为可排期改进。

---

## 附：审查期间执行的验证动作清单（可复现）

1. `export HOME=/tmp && npm test` → 23 文件/116 用例全过。
2. `export HOME=/tmp && npm run build` → 全过，dist 更新。
3. 生产服务黑盒（`node dist/server/index.js`，仅绑 127.0.0.1）：
   - 未授权 `GET /api/config/preview?path=/tmp/secret-config.toml` → 返回含明文 `sk-…` 的 rawContent；
   - 未授权 `POST /api/config/diff` → removed 行明文密钥；
   - 未授权 `POST /api/refresh`、`POST /api/metrics` → ok=true；
   - 有 session+hash 的 `POST /api/config/apply`（path=/tmp/secret-config.toml）→ 文件被改写；
   - SSE 全序列（run→adapter×13→run→snapshot）与迟到连接缺 snapshot 事件；
   - 冷启动 0.4s GET /api/graph → 请求内联完成全量收集。
4. git 复核：无 sqlite/db/log/env/pem/key 入库；密钥正则无匹配；`redactionHints` 无消费方；`verifyCapabilities` 无路由；`audit_log` 表无 INSERT。
5. 未验证项（诚实声明）：macOS 真机上的 LaunchAgent 冷启动、docker/launchctl 实采、oMLX/MLX/llama/Ollama 真机 start/stop、浏览器真实渲染与窄屏 QA、网关"人工真机客户端请求"——均无 macOS 环境，标 ➖。