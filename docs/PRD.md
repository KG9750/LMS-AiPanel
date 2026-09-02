# LMS-AiPanel 产品需求文档

## 1. 文档状态

- 产品：LMS-AiPanel
- 架构基线：v1
- 目标平台：macOS
- 主要用户：本机唯一操作者
- 产品形态：localhost 后台服务与浏览器控制台

## 2. 产品定位

LMS-AiPanel 是 macOS 本地 AI 工作栈的可信监测与受控执行平台。它统一展示 AI 工具、助手、本地推理运行时、模型、服务端点、Channel、Skill、MCP 和配置文件，并以现场证据区分“已配置”“正在运行”“已经加载”和“真实可服务”。

产品采用“监测优先、受控执行紧随其后”的交付策略：

- `v0.5`：可信监测、Token 遥测、配置预览和 diff。
- `v0.7`：对显式托管资源开放有限启停、模型加载/卸载和配置修改。
- `v1.0`：监测与控制均达到日常稳定可用。

只读资产盘点不是完整控制台，不能单独作为 `v1.0` 完成标准。

## 3. 产品原则

1. **现场证据优先**：进程存在、端点健康、模型 API 和真实请求分别表达，不互相冒充。
2. **发现默认只读**：自动发现的资源不自动获得控制权限。
3. **显式托管后可控**：只有注册为 `managed` 且 adapter 声明支持的动作可以执行。
4. **数据覆盖透明**：完整统计、部分统计和无法归因必须明确区分。
5. **不采集对话正文**：Token 和调用统计不保存 prompt、response 或聊天内容。
6. **单机交付、模型可演进**：v1 只管理本机，但核心数据从一开始包含 `hostId`。
7. **中文解释属于产品能力**：参数说明必须与 adapter 的版本化 schema 一起维护。

## 4. 用户目标

操作者需要能够：

- 快速发现当前 AI 栈中需要处理的问题。
- 查看 AI 工具当前绑定的模型、配置来源和运行状态。
- 查看 OpenClaw、Hermes 等助手的实例、Channel 和模型路由。
- 查看本地推理运行时、可用模型、已加载模型和服务端点。
- 查看模型和进程内存，并在卸载后验证实际释放结果。
- 统计所有命中本地推理 endpoint 的 Token，并在条件允许时归因到客户端。
- 查看、解释、预览并受控修改支持的配置文件。
- 查看 Skill 的用法、来源、验证状态和可验证的升级信息。
- 查看 MCP 的配置、运行和能力状态，但不在自动刷新中调用业务工具。
- 对显式托管资源执行可审计、可验证的控制动作。

## 5. 领域对象

v1 使用以下一等对象：

- **Host**：运行 LMS-AiPanel 和资源的主机。
- **Tool**：Codex、Claude Code、Waku、Open WebUI 等客户端或工具。
- **Assistant Definition**：助手的行为和配置定义。
- **Assistant Instance**：助手的进程、容器或 LaunchAgent 实例。
- **Channel Binding**：助手与 Telegram、微信、飞书、Discord、Web 等入口的绑定。
- **Inference Runtime**：oMLX、MLX Server、llama.cpp、Ollama 等本地推理服务。
- **Model Artifact**：磁盘上的模型文件或模型目录。
- **Model Instance**：某个 runtime 中已配置或已加载的模型实例。
- **Endpoint**：监听地址、端口、协议和 API 能力。
- **Skill Installation**：特定平台和作用域中的 Skill 安装实例。
- **MCP Server**：MCP 配置定义、运行实例和能力清单。
- **Config Document**：可查看或受控修改的配置文件。

## 6. 功能需求

### 6.1 自动发现与注册表

- 从进程、LaunchAgent、Docker、已知配置目录和 localhost 候选端点自动发现资源。
- 使用显式注册表补充自定义路径、端口、稳定名称、忽略规则和控制权限。
- 资源状态区分 `discovered`、`registered`、`configured`、`live` 和 `unverified`。
- 自动发现与注册表合并后必须保留证据来源，不能静默覆盖冲突。

### 6.2 本地推理运行时

- oMLX、MLX Server、llama.cpp 和 Ollama 使用统一运行时层级和能力模型。
- 通用能力包括 `discover`、`health`、`list-models`、`loaded-models`、`token-usage`、`start`、`stop`、`restart`、`load-model` 和 `unload-model`。
- adapter 必须明确声明支持和不支持的能力。
- 缺失能力显示为“不支持”或“无遥测”，不能显示为零或异常。

### 6.3 模型状态与内存

- 模型状态使用 `configured`、`loaded`、`serving`、`process-only`、`unloaded` 和 `unknown`。
- `loaded` 需要 runtime API 证据；`serving` 需要健康检查或轻量真实请求证据。
- 内存分别展示 runtime/模型报告值、进程 resident memory 和系统内存压力。
- 卸载验证同时检查模型状态和内存变化，不承诺对共享内存做虚假精确归因。

### 6.4 Token 与调用遥测

- 默认读取 runtime 原生 provider 遥测，覆盖命中该 endpoint 的全部客户端。
- provider 累计统计不能可靠识别客户端时，显示“无法归因”。
- 提供可选 Observability Gateway，为接入的客户端记录模型、Token、延迟、错误和客户端身份。
- provider 和客户端数据可能重叠，UI 不得直接相加。
- 状态快照与指标时间序列分开存储。
- 累计计数器回退或 runtime 重启时开启新的计数周期，不能产生负增量。
- 默认保留最近 24 小时细粒度数据和 30 天小时级数据。

### 6.5 AI 助手与 Channel

- Assistant Definition、Assistant Instance、Channel Binding 和 Model Route 分开建模。
- 一个助手可以关联多个实例、Channel、默认模型、备用模型和路由 endpoint。
- 必须能够区分实例未运行、Channel 不可达、模型 endpoint 不可达和路由漂移。

### 6.6 配置中心

- 已支持配置使用结构化表单，未知字段保留原始键并标注“暂无版本化说明”。
- 每个参数说明包括中文名称、详细含义、类型、范围、默认值来源、敏感性、生效方式、重启要求、适用版本和官方文档。
- 提供只读原文、修改预览和 diff。
- 只有 adapter 白名单声明的文档可以写入。
- 写入前重新读取文件并与预览时原内容比较，外部变化会使计划失效。
- 写入使用临时文件、原子替换和可恢复备份。
- `AGENTS.md`、`CLAUDE.md` 等自由文本使用受控文本模式，不伪装为结构化配置。

### 6.7 Skill

- 展示安装位置、平台、作用域、状态、用法、来源和当前版本。
- 有可靠远程来源时区分 `latest`、`upgrade-available` 和 `locally-modified`。
- “可升级”与“建议升级”分开表达。
- 纯本地 Skill 显示“无远程升级来源”，只进行结构和引用完整性检查。
- v1 只提供升级预览和动作计划，不自动执行升级。

### 6.8 MCP

- 配置层展示客户端绑定、transport、启动方式和变量名。
- 运行层识别已有进程、端口和 transport 状态，不在自动刷新时启动服务。
- 能力层仅对显式托管或用户手动触发的 MCP 执行握手，读取 server info、tools、resources 和 prompts 清单。
- 自动刷新不调用具体 MCP tool，不读取业务数据，不展示环境变量值。

### 6.9 运维工作台

首页按以下优先级组织：

1. 不可达、配置漂移、采集失败和升级建议。
2. 正在运行的模型、runtime、助手和 Channel。
3. Token、内存、请求、延迟和错误。
4. 最近资源变化和 Action Run。
5. 完整资产盘点入口。

Stack Map 是辅助关系视图。资源详情统一展示配置、运行态、关系、遥测、动作和审计。

### 6.10 后台采集与实时更新

- Adapter Scheduler 根据各 adapter 的刷新周期持续采集。
- API 默认返回最近一次已完成快照，不在读取请求中触发全量扫描。
- 手动刷新创建 Refresh Run，并可查看各 adapter 进度。
- SSE 推送资源变化、采集结果、动作进度和错误；断开后 UI 可回退 polling。
- 同一 adapter 维持 single-flight，昂贵扫描进入独立任务。

### 6.11 受控执行

- 自动发现资源默认只读，注册为 `managed` 后才开放动作。
- 写操作统一进入 Action Run：

```text
planned -> awaiting-confirmation -> executing -> verifying -> succeeded
                                                   -> failed
                                                   -> rollback
```

- 动作计划展示目标、影响对象、已知客户端和预计影响。
- 执行后重新验证进程、endpoint、模型列表和内存状态。
- 后端重启后重新检查未完成动作的现场状态，不凭旧状态直接判定结果。

### 6.12 部署与本地访问

- Fastify 后端作为用户级 LaunchAgent 持续运行。
- React 静态资源由同一服务提供，固定监听 `127.0.0.1`。
- CLI 管理安装、启动、停止、状态、日志和升级。
- 不建立账户系统；写操作使用短期本地会话、合法 Origin 和明确确认参数。
- 后台采样不依赖浏览器页面是否打开。

## 7. 非目标

v1 不包含：

- 多主机控制和远程 collector。
- 第三方动态插件市场或主进程热加载未知代码。
- 多用户账户、角色和 OAuth。
- 自动执行 Skill 升级。
- 自动调用 MCP 业务工具。
- 删除模型文件或卸载工具。
- 保存 prompt、response、聊天正文或凭据值。

## 8. v1 验收标准

- 单机核心对象均关联稳定 `hostId`。
- oMLX、MLX Server、llama.cpp、Ollama 至少达到可靠只读监测。
- provider Token 总量和可选客户端归因能够分层展示覆盖率。
- 模型加载、服务和内存状态使用明确证据等级。
- 显式托管资源支持有限且经过现场复验的控制动作。
- 白名单配置支持结构化说明、diff、备份、原子写入和验证。
- 助手、实例、Channel 和模型路由关系可查询。
- Skill 与 MCP 满足各自的来源和三层探测边界。
- 首页、资源详情和历史趋势满足桌面与窄屏使用要求。
- 后台 Scheduler、SSE、Action Run、审计和本地会话稳定运行。
- 契约测试、fixture 测试、隔离集成测试、真实机器只读验收和浏览器验收全部通过。
