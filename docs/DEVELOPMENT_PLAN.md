# LMS-AiPanel v1 开发计划

## 1. 当前基线与主要差距

当前仓库已经具备 React/Fastify/TypeScript、Resource Graph、只读 adapter、SQLite 快照、配置漂移、中文 tooltip 和基础 Token 统计。

下一阶段的主要差距不是 adapter 数量，而是：

- 缺少 Host 和统一 Runtime/Model/Endpoint 领域模型。
- 缺少自动发现与显式注册表的合并规则。
- adapter 没有正式 capability manifest。
- 采集仍主要由 API 请求触发。
- 缺少指标时间序列和 counter epoch。
- 缺少问题驱动首页与统一资源详情。
- Action Gateway 尚未形成持久化 Action Run。
- 缺少 managed 权限边界和写操作本地会话保护。
- 缺少生产 LaunchAgent 和管理 CLI。

实施原则是先升级控制平面核心，再扩展更多 adapter。

## 2. 里程碑

### V1-M0 架构基线与治理

交付新版 PRD、目标架构、开发计划、GitHub milestones 和可验收 issues。明确术语、非目标、版本边界和测试 Gate。

### V1-M1 Host、能力与注册表

建立 host-scoped 资源、adapter manifest、managed registry 和发现合并规则。完成一个端到端注册资源的 UI 与 API 路径。

### V1-M2 后台采集与实时事件

将采集从 GET 请求迁移到 Scheduler；建立 RefreshRun、SSE 和快照版本。页面读取最近完成快照。

### V1-M3 统一本地推理运行时

先用 oMLX 闭合 Runtime/Model/Endpoint 状态和证据，再接入 MLX Server、llama.cpp 和 Ollama 的可靠只读 adapter。

### V1-M4 遥测与历史趋势

建立 MetricSample、counter epoch、保留策略和趋势查询；实现可选 gateway 的最小客户端归因路径。

### V1-M5 运维工作台与资源详情

首页改为问题驱动；统一展示配置、运行态、关系、遥测、可用动作和审计。Stack Map 保持辅助定位角色。

### V1-M6 受控执行与配置中心

建立本地会话保护、Action Run 状态机和 managed 权限检查。先在隔离测试 runtime 上闭合动作，再开放一个 oMLX 托管实例。配置中心先闭合一种结构化配置。

### V1-M7 Assistant、Skill 与 MCP

完成助手实例/Channel/模型路由，Skill 来源与升级评估，以及 MCP 配置/运行/能力三层探测。

### V1-M8 生产打包与 v1 Gate

交付用户级 LaunchAgent、管理 CLI、升级与日志路径。完成契约、fixture、隔离集成、真实机器只读和浏览器验收。

## 3. 已发布的纵向切片 Issues

每个 issue 都应交付一条可演示的 schema、API、UI 和测试路径。`AFK` 表示实现无需人工决策；`HITL` 表示需要真实机器或视觉 Gate。

1. **GitHub #1：持久化 Host Identity 并在总览显示本机范围**
   - 类型：AFK
   - 里程碑：V1-M1
   - 阻塞：无

2. **GitHub #2：展示 Adapter Capability Manifest 和不支持状态**
   - 类型：AFK
   - 里程碑：V1-M1
   - 阻塞：#1

3. **GitHub #3：合并自动发现与 Managed Registry**
   - 类型：AFK
   - 里程碑：V1-M1
   - 阻塞：#1、#2

4. **GitHub #4：由后台 Scheduler 生成版本化资源快照**
   - 类型：AFK
   - 里程碑：V1-M2
   - 阻塞：#2

5. **GitHub #5：用 RefreshRun 和 SSE 展示手动刷新进度**
   - 类型：AFK
   - 里程碑：V1-M2
   - 阻塞：#4

6. **GitHub #6：用 oMLX 闭合 Runtime、Model 和 Endpoint 证据状态**
   - 类型：AFK
   - 里程碑：V1-M3
   - 阻塞：#3、#4

7. **GitHub #8：接入 MLX Server 只读运行时适配**
   - 类型：AFK
   - 里程碑：V1-M3
   - 阻塞：#6

8. **GitHub #9：接入 llama.cpp 只读运行时适配**
   - 类型：AFK
   - 里程碑：V1-M3
   - 阻塞：#6

9. **GitHub #10：接入 Ollama 只读运行时适配**
   - 类型：AFK
   - 里程碑：V1-M3
   - 阻塞：#6

10. **GitHub #11：保存 Token 与内存指标的 Counter Epoch 历史**
    - 类型：AFK
    - 里程碑：V1-M4
    - 阻塞：#4、#6

11. **GitHub #12：通过可选 Gateway 归因一个本地客户端**
    - 类型：HITL
    - 里程碑：V1-M4
    - 阻塞：#11

12. **GitHub #13：交付问题驱动的运维首页**
    - 类型：HITL
    - 里程碑：V1-M5
    - 阻塞：#4、#11

13. **GitHub #14：交付统一资源详情页**
    - 类型：AFK
    - 里程碑：V1-M5
    - 阻塞：#2、#13

14. **GitHub #15：展示 Assistant Instance、Channel 和 Model Route**
    - 类型：AFK
    - 里程碑：V1-M7
    - 阻塞：#3、#14

15. **GitHub #16：为写操作建立本地 Session 和 Origin Guard**
    - 类型：AFK
    - 里程碑：V1-M6
    - 阻塞：#3

16. **GitHub #17：在隔离 Runtime 上闭合 ActionRun 状态机**
    - 类型：AFK
    - 里程碑：V1-M6
    - 阻塞：#6、#16

17. **GitHub #18：控制一个显式托管的 oMLX 测试实例**
    - 类型：HITL
    - 里程碑：V1-M6
    - 阻塞：#17

18. **GitHub #19：闭合一种结构化配置的预览、写入和验证**
    - 类型：AFK
    - 里程碑：V1-M6
    - 阻塞：#16

19. **GitHub #20：展示 Skill 来源、验证和升级评估**
    - 类型：AFK
    - 里程碑：V1-M7
    - 阻塞：#3、#14

20. **GitHub #21：按配置、运行和能力三层检查 MCP**
    - 类型：HITL
    - 里程碑：V1-M7
    - 阻塞：#3、#14、#16

21. **GitHub #22：使用 LaunchAgent 和 CLI 运行生产服务**
    - 类型：HITL
    - 里程碑：V1-M8
    - 阻塞：#4、#16

22. **GitHub #23：执行 v1 跨层发布 Gate**
    - 类型：HITL
    - 里程碑：V1-M8
    - 阻塞：#5、#8、#9、#10、#12、#13、#15、#18、#19、#20、#21、#22

GitHub issue 与 Pull Request 共用编号，因此 PR #7 之后的第 7 个切片从 issue #8 开始。以上编号均为真实 GitHub issue 引用。

## 4. Issue 验收模板

每个 issue 必须包含：

- **What to build**：描述端到端用户行为，不按文件或技术层拆任务。
- **Acceptance criteria**：可执行、可观察、可判定。
- **Blocked by**：引用真实 GitHub issue。
- **测试证据**：契约、fixture、隔离集成、真实机器或浏览器 Gate 中适用的层级。
- **安全边界**：是否读取真实配置、是否启动进程、是否写入或控制资源。

## 5. 验证 Gate

### 5.1 契约测试

验证 schema、稳定 ID、host scope、capability、状态、错误和 stale 语义。

### 5.2 Fixture 测试

覆盖版本差异、缺失字段、未运行、不可达、计数器回退和外部配置变化。

### 5.3 隔离集成测试

使用临时目录、测试端口和假服务验证 Scheduler、SSE、超时、取消、配置写入和 Action Run。

### 5.4 真实机器验收

只读 adapter 可以使用真实机器证据。写操作只针对明确登记的测试实例，并验证进程、endpoint、模型列表和内存变化。

### 5.5 浏览器验收

验证桌面与窄屏、中文说明、加载/失败/stale/unknown/空状态、键盘访问、无重叠、无横向溢出和控制台无错误。

## 6. 版本控制

- `main` 始终保持可启动且测试通过。
- 分支使用 `codex/feature-<scope>`、`codex/fix-<scope>` 或 `codex/docs-<scope>`。
- 每个纵向切片对应一个 issue 和一个聚焦 PR。
- PR 必须包含目标、范围、测试结果、安全边界和真实配置/写操作说明。
- 不提交 runtime DB、备份、日志、`.env`、secret、真实聊天内容或原始机器快照。
