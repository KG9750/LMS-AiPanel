# LMS-AiPanel 目标架构

## 1. 架构目标

LMS-AiPanel 是单机优先的本地 AI Control Plane。架构围绕五条主链路组织：

```text
Discovery -> Resource Graph -> Drift / Metrics -> UI
Registry  -> Managed Resource -> Action Run -> Verification
Adapter   -> Scheduler -> Snapshot / Events -> API
Config Schema -> Preview / Diff -> Guarded Apply -> Audit
Provider Telemetry + Optional Gateway -> Metric Series
```

v1 不实现分布式控制，但所有资源、指标和动作均携带 `hostId`，为未来远程 collector 保留边界。

## 2. 运行拓扑

```text
Browser
  | HTTP + SSE
  v
Fastify Control API (127.0.0.1)
  |-- Query Services ----------> SQLite snapshots / metrics / audit
  |-- Scheduler ---------------> Adapter Runtime
  |-- Action Service ----------> Action Gateway -> Managed adapters
  |-- Config Service ----------> Schema / Preview / Atomic writer
  `-- Session Guard

Adapter Runtime
  |-- Tool and Assistant adapters
  |-- Runtime adapters: oMLX / MLX Server / llama.cpp / Ollama
  |-- Process adapters: LaunchAgent / Docker
  |-- Skill and MCP adapters
  `-- Optional Observability Gateway adapter
```

生产形态由同一 Fastify 服务提供 API 和 React 静态资源。后台服务通过用户级 LaunchAgent 持续运行，浏览器是否打开不影响采样。

## 3. 限界上下文

### 3.1 Inventory

负责 Host、Tool、Assistant、Runtime、Model、Endpoint、Skill、MCP 和 Config Document 的发现、注册与关系。

### 3.2 Observability

负责 AdapterRun、RefreshRun、健康状态、Token、内存、请求、延迟、错误和指标周期。

### 3.3 Configuration

负责版本化参数 schema、中文说明、原文、预览、diff、备份和受控写入。

### 3.4 Control

负责 Managed Resource、Action Plan、Action Run、执行、现场验证和恢复。

### 3.5 Experience

负责运维首页、资产盘点、统一资源详情、历史趋势、实时事件和审计展示。

## 4. 核心领域模型

### 4.1 主机与资源

所有资源使用稳定主键：

```text
<hostId>:<adapterId>:<resourceType>:<stableKey>
```

核心对象包括：

- `Host`
- `Tool`
- `AssistantDefinition`
- `AssistantInstance`
- `ChannelBinding`
- `InferenceRuntime`
- `ModelArtifact`
- `ModelInstance`
- `Endpoint`
- `SkillInstallation`
- `McpServer`
- `ConfigDocument`

关系包括 `configured_by`、`uses`、`routes_to`、`runs_on`、`serves`、`loaded_in`、`binds`、`exposes`、`managed_by` 和 `owns`。

### 4.2 状态与证据

资源状态不能只用一个通用枚举压平。模型实例至少包含：

- `configured`
- `loaded`
- `serving`
- `process-only`
- `unloaded`
- `unknown`

每个判断包含：

- `evidenceType`
- `observedAt`
- `sourceAdapter`
- `confidence`
- 人类可读 evidence

进程、endpoint、API 列表和真实请求是不同证据。后一级可以增强可信度，但前一级不能冒充后一级。

### 4.3 助手模型

助手拆为 Definition、Instance、Channel Binding 和 Model Route。聚合状态由查询层计算，原始对象不丢失单独故障，例如“实例运行但 Channel 不可达”。

## 5. 自动发现与注册表

### 5.1 自动发现

只读来源包括进程 argv、LaunchAgent、Docker、已知配置目录、模型根目录和 localhost 候选端点。端点探测必须验证服务身份，不能只依据端口占用。

### 5.2 显式注册表

注册项包含：

- 稳定名称和资源匹配条件。
- 自定义配置路径、端口或启动描述。
- `managed` 标记。
- 允许的动作集合。
- 忽略或纠正自动发现结果的规则。

### 5.3 合并规则

自动发现与注册信息不互相覆盖原始证据。Resolver 生成规范资源，并保留 `discovered`、`registered`、`configured`、`live`、`unverified` 等来源状态。匹配冲突生成 drift 或 attention item。

## 6. Adapter 体系

v1 使用随项目编译的静态 adapter，不在主进程动态加载第三方代码。

每个 adapter 提供 manifest：

- 资源类型和发现来源。
- 支持的 capability 与 action。
- 外部命令、文件和网络权限。
- 默认超时、刷新周期和成本等级。
- 配置 schema 与说明版本。
- 遥测覆盖范围和归因粒度。
- 是否可能产生进程或网络副作用。

统一能力词汇包括：

```text
discover, health, list-models, loaded-models, token-usage,
start, stop, restart, load-model, unload-model, configure
```

能力缺失是正常结果，不作为 adapter 失败。

## 7. Adapter Runtime 与 Scheduler

### 7.1 执行隔离

- 每个 adapter 独立超时并接收 `AbortSignal`。
- 同一 adapter 使用 single-flight。
- 一个 adapter 失败不阻断其他 adapter。
- 失败时可以返回最近成功快照，并标记 `stale` 和原始失败原因。
- 所有 adapter 输出在 API 和存储边界再次经过脱敏和 schema 校验。

### 7.2 后台调度

Scheduler 根据 adapter manifest 的周期执行。API 读取最近完成的规范快照，不在 GET 请求中触发全量扫描。

手动刷新创建 `RefreshRun`：

- 记录目标 adapter、开始时间、完成时间和状态。
- 复用 single-flight。
- 通过 SSE 推送 adapter 进度和快照版本。
- 慢扫描和手动 MCP 握手进入独立任务。

## 8. Resource Graph 与 Drift

Resource Graph 保存规范节点、关系和证据引用。Drift Engine 首先比较 configured 与 live，未来再增加用户声明的 expected 状态。

drift 必须关联具体证据并区分：

- 配置存在但运行态缺失。
- 运行实例没有对应配置或注册。
- 助手、Channel 或模型路由不可达。
- 注册表与自动发现匹配冲突。
- adapter 数据陈旧或不可验证。

## 9. 遥测架构

### 9.1 Provider 遥测

runtime adapter 读取 endpoint 或模型级累计 Token、请求、延迟和错误。它覆盖所有客户端，但通常无法识别调用方。

### 9.2 可选 Observability Gateway

愿意接入的客户端通过本地 OpenAI-compatible gateway 调用 runtime。gateway 记录客户端 ID、模型、Token、延迟、错误和目标 endpoint，不记录 prompt 或 response。

### 9.3 覆盖与去重

provider 和客户端数据分层呈现。系统记录 coverage 和 attribution，不把可能重叠的数据相加。未经过 gateway 的 provider 流量显示为“无法归因”。

### 9.4 时间序列

`MetricSample` 保存原始累计值、采样时间和 counter epoch。计数器回退创建新 epoch。后台 compaction 保留最近 24 小时细粒度样本和 30 天小时级样本。

## 10. 配置中心

adapter 提供版本化 `ConfigSchema`，其中包含字段类型、中文说明、适用版本、敏感性和生效规则。

写入流程：

1. 读取当前文档并解析。
2. 生成结构化变更和原文 diff。
3. 保存预览时的原始内容作为并发修改基准。
4. 执行前重新读取；内容变化则使计划失效。
5. 校验新内容并写入同目录临时文件。
6. 同步并原子替换，保存可恢复备份。
7. 重新读取、重新采集并验证生效状态。

自由文本配置使用受控文本模式。未进入 adapter 白名单的文件保持只读。

## 11. Action Gateway

所有写操作转换为持久化 `ActionRun`：

```text
planned -> awaiting-confirmation -> executing -> verifying -> succeeded
                                                   -> failed
                                                   -> rollback
```

规则：

- 目标资源必须 `managed`，且 adapter manifest 声明对应动作。
- Action Plan 描述目标、参数、影响、已知客户端和验证步骤。
- start/stop/load/unload 的成功必须依赖现场复验，不依赖命令退出码。
- 配置写入失败可以恢复备份；运行态动作不盲目自动反向执行。
- 服务重启后，未完成 ActionRun 进入重新验证流程。

## 12. Skill 与 MCP 边界

### 12.1 Skill

普通 Skills adapter 负责安装发现。管理模块负责来源、版本、结构验证和升级计划。有远程来源才能判断可升级；纯本地 Skill 不推断升级状态。v1 不自动执行升级。

### 12.2 MCP

MCP 分为配置、运行和能力三层。自动采集只读取配置和已有运行状态。能力握手必须由显式托管或手动动作触发，且只读取能力清单，不调用业务 tool。

## 13. API 与事件

所有 API 使用统一 envelope：

```json
{ "ok": true, "data": {}, "meta": { "timestamp": "...", "snapshotVersion": "..." } }
```

主要 API 资源：

- `/api/overview`
- `/api/resources`
- `/api/resources/:id`
- `/api/refresh-runs`
- `/api/action-runs`
- `/api/config-plans`
- `/api/metrics`
- `/api/events`（SSE）

读取 API 无副作用。启动扫描、握手和写操作使用明确的命令端点。

## 14. 本地保护与脱敏

- 服务固定监听 `127.0.0.1`。
- 不建立用户账户系统。
- 写操作要求短期本地会话、合法 Origin 和确认参数。
- 敏感字段在 adapter 输出、API、日志和存储边界统一脱敏。
- 环境变量只展示名称和是否存在，不展示值。
- 不采集 prompt、response、聊天正文或真实凭据。

## 15. 持久化边界

SQLite 使用 WAL 和显式 migrations。核心表按职责拆分：

- hosts / registry_entries
- resources / relations / evidence
- adapter_runs / refresh_runs / snapshots
- metric_samples / counter_epochs
- config_plans / action_runs
- audit_log

运行数据位于：

```text
~/Library/Application Support/LMS-AiPanel/{storage,backups,logs}
```

仓库只保存源码、文档、fixtures 和测试，不保存机器快照、运行数据库、日志、备份或 secret。

## 16. 部署与扩展

- 生产运行：用户级 LaunchAgent + 单一 Fastify 服务。
- 开发运行：Vite 与 Fastify独立热更新。
- CLI 提供 install、start、stop、status、logs 和 upgrade。
- 未来外部扩展优先采用独立进程 collector 协议，不在主进程热加载未知代码。
- 未来多机扩展以 `hostId` 和 collector 边界为基础，但不属于 v1。
