# 协议校准报告（对照 zai-org/zcode 开源源码）

校准基准：`zai-org/zcode` main（Apache-2.0），协议定义
`packages/shared/src/zcode-protocol/index.ts`，方法实现
`apps/zcode-cli/packages/core/src/runtime/methods/`，桌面服务层
`packages/services/`。真机对照：ZCode 桌面 3.12.3（嵌入 app-server
0.16.5），macOS arm64。日期：2026-09-21。

## 结论速览

适配器的线缆假设**全部与官方协议一致**，两处实质修正已落地：
resume 路径补传 `mcpServers`（协议 schema 明确接受）、会话建立后触发
`mcp/list mode:"connect"`（MCP 工具挂载的正确动词）。跨 provider 切换
的真通道被找到（`provider/updateAccountConfig`），在发布版二进制上
需要迁移后的 provider 序列化格式，列为后续工作项。

## 逐项校准

| 适配器假设 | 源码结论 | 状态 |
| --- | --- | --- |
| 方法名 create/resume/list/read/messages/subscribe/send/stop/close/setModel/setMode/setThoughtLevel | `zcodeProtocolMethods` 逐一对应 | ✅ 证实 |
| `session/send` params: `{sessionId, content}` | `zcodeSessionSendParamsSchema`: content 必填 + 可选 modelSelection/attachments/expectedRevision 等 | ✅ |
| `session/setModel` params: `{sessionId, model, persistAsWorkspaceLastUsed}` | 官方 schema `.strict()` 仅此 4 字段（+`expectedRevision`）；**`runtimeModel` 不在协议中**（上游 zcode-acp-server 的发明/前瞻） | ✅ 证实排除 |
| `model.options.reasoningLevel` 必带（0.16.5 实测） | `modelSelectionSchema = {providerId, modelId, options?: {reasoningLevel?}}`，`.strict()`；缺省时后端报 "Reasoning level is required" | ✅ 官方形状 |
| Picker 值编码 `providerId/modelId` | 官方 `formatModelPickerValue` 为 `providerId/modelId$level`（`$` 分隔推理档，仅展示边界）；协议态必须保存 ModelSelection | ✅（注意 `$`） |
| `workspace/updateProviderRegistry` | **协议中不存在**（真机 -32601；源码全库无此方法）。上游 0.32.0 面向的是未发布世代 | ❌ 幻影，已从实现中降级 |
| 真 provider 通道 | `provider/updateAccountConfig`（"进程级 Account Provider Config"，{revision, basedOnZCodeBuiltinRevision, providers, states}，真机 -32602 证实存在）+ `interaction/requestProviderRuntimeHeaders` 回调 | 🆕 已定位，未实现（provider 条目为迁移后格式，桌面端有整模块转换器） |
| `session/resume` 接受 mcpServers | `zcodeSessionResumeParamsSchema` 明确含 mcpServers/toolAllowlist/toolDenylist（冷恢复语义） | ✅ 已修：resume 补传 |
| MCP stdio 线缆形状 `{name, command(string), args[], env:[{name,value}]}` | `zcodeProtocolMcpServerSchema` stdio 分支同构；`isolation`/`protocolVersion`/`timeoutMs` 可选 | ✅ |
| MCP "注册 ≠ 连接" | create/resume 只注册；`mcp/list mode:"connect"` 才 spawn 并挂载工具（桌面端在会话前调用）。真机实证：connect 后 `codeg-mcp` connected、toolCount=4、模型工具面出现 `mcp__codeg-mcp__delegate_to_agent`（直驱探针） | ✅ 已修：open 时触发 connect |
| 0.16.5 发布版上模型看不到 MCP 工具 | 发布版 create 未把 params.mcpServers 装配进会话运行时（HEAD 源码的装配链是新增代码）；任何客户端时序都无法在 0.16.5 上挂载 | ⚠️ 上游硬限制，connect 调用为新版前向兼容 |
| `turn.completed` resultType | 官方枚举：`success/cancelled/error_max_turns/error_max_budget/error_during_execution/error_max_tool_calls`（注释明确 cancelled 复用 completed 上报） | ✅（适配器多认的 canceled/aborted/interrupted 为无害防御拼写） |
| `session/event` 信封 | discriminatedUnion：turn.started/completed/failed、part.delta（field: text/reasoning/input/output）、tool.updated、permission.requested/resolved、userInput.requested/resolved、checkpoint.created 等 | ✅ |
| tool.updated 生命周期 | `scheduled → started → progress → result|error`，另有 batch/raw 聚合；scheduled 携带 toolName/input | ✅ |
| 权限选项 kind 为自由字符串 | `zcodePermissionOptionSchema.kind: nonEmptyString`——闭枚举是 ACP 侧约束；真机原生发出 `deny` 等非标 kind | ✅ 适配器映射层位置正确 |
| 模式枚举 | legacy: `plan/build/edit/yolo/auto`；v4 值域刻意排除 auto（源码注释）。真机实测：`session/setMode` 对 build/edit/yolo/auto 生效、对 `bogus` 报 E_REMOTE；**`plan` 被接受却不生效**（读回 build）——plan 是 workspace 交互偏好 `planEnabled`，由 agent 自己的 `EnterPlanMode`/`ExitPlanMode` 工具翻转（桌面 bundle 实证），客户端无法经 wire 强制进入。适配器已对齐 ZCode 的四个可切换模式（含其官方文案：Plan mode / Ask before changes / Edit automatically / Full access）。**新建会话的默认模式改为 `build`**（ZCode 自己的默认）：以 `plan` 建会话会点亮 plan 标记，而 plan 的工作流强制每个回合以提问结束，原生提问又需要客户端作答——客户端没有这条通道时模型只能改口用纯文本重说一遍（现场表现为一次「你好」出现两段回答）。真机 A/B：默认 build 的新会话 1 个模型回合、无任何 plan 标记；旧的 plan 会话 2 个回合、系统提示/思维里带 `plan mode is active` + `ExitPlanMode` | ✅ 已对齐（plan 的 wire 限制见备注） |
| 思考等级 | `session/read` 的 `settings.thoughtLevel = {available:[{value,label}], current, enabled}` 是会话级权威档位表；`session/setThoughtLevel {sessionId, thoughtLevel}` 生效（实测 low/high/max 可切、模型不支持的档位报 E_REMOTE）。适配器据此广告 `reasoning_effort` 选择器并路由到该方法 | ✅ 已实现 |
| 模型展示名契约 | ACP 客户端（codeg）从 model 选项**显示名的第一段 `/`** 推导选择器分组标题并把它从行里剥掉；适配器因此把行标签拼成 `Provider / Model`（`providerId/modelId` 仍是 value，契约不变） | ✅ 已实现 |
| 状态枚举 | `idle/running/waiting/paused/...`——`waiting`（等用户）存在，适配器尚未区分 | 📝 待跟进 |
| 反向偏好应答 `askUserQuestionAutoResolutionEnabled:false` | 与 desktop 行为一致；配合 `interaction/requestOfficialMcpAuthHeaders` 等反向面 | ✅ |
| `session/send` 已收敛 v4 sendText、`session/stop`/`fork`/`cancelBackgroundTask` 标记 @deprecated（wire 兼容保留） | 0.16.5 发布版仍走 legacy wire——适配器用法正确，升级时需关注 v4 命令面 | 📝 跟进项 |

## 实验记录（真机 0.16.5）

- `workspace/updateProviderRegistry` → -32601 Method not found
- `session/setModel` + runtimeModel → Zod `unrecognized_keys: runtimeModel`
- `session/setModel` 裸 model ref → ModelProtocolError "Reasoning level is required"
- `session/setModel` + `options.reasoningLevel`（registry 内模型）→ OK，read 回读一致
- `provider/updateAccountConfig`（config.json 原样）→ Zod 拒绝（字段形状不符，需迁移后格式）
- 模型目录来源（2026-09-28 源校准，桌面 3.14.3 / CLI 0.16.9）：`~/.zcode/v2/config.json`
  的 `provider` 表是**旧版**单文件格式，桌面只把它当一次性迁移输入——它停止更新后，任何
  继续读它的客户端都会把模型列表冻结在当时的快照（实测：目录里同时出现已下线的
  `builtin:bigmodel-coding-plan` 与名为 `…-expires-on-0910` 的过期模型，而当前在用的
  `new-provider-3/cline-pass/…` 等 provider 全部缺失）。当前目录 = 个人存储
  `provider_config.json`（schemaVersion 1：`providerOrder` / `providerConfigRules.providerRules`
  / `modelConfigRules.{providerModelRules,manualProviderModelRules}`）+ 内置目录
  `zcode-builtin.json`（应用包 `Resources/config/provider/`，以及 CDN 刷新缓存
  `~/.zcode/v2/runtime/provider/<platform>/<appVersion>/endpoint-<sha256(origin)[0:32]>/`；
  revision 最高者胜，同 revision 时应用包版本胜）。合并规则（`src/backend/provider-store.mjs`）：
  provider 条目 = 模板配置打底 + 个人条目逐字段覆盖；模型 = `builtinModelIds ∪ personalModelIds`
  按 `modelOrder` 排序（显式顺序优先）；model 规则序列 = 内置
  `modelRules → modelApiRules → providerSiteRules → templateModelRules → builtinProviderModelRules`
  再接个人 `providerModelRules → manualProviderModelRules`，**后者覆盖前者**，`modelMatch` 为
  锚定的大小写不敏感正则；可选性 = provider `enabled !== false` 且（`api-key`/`zhipu-coding-plan-api-key`
  需 `access.apiKey`；`zhipu-account` 需 `credentials.json` 里存在 `account-provider:…:<providerId>:…`
  凭据键）且至少一个模型 `enabled !== false`；账号族（`zai-family`/`bigmodel-family`）排在最前，
  其余按 `providerOrder`。协议侧**没有**读取目录的方法（方法表仅有 `provider/updateAccountConfig`
  与 `provider/testModelConnectivity`），所以目录只能由文件推导。
- `provider/updateAccountConfig`（正确信封）→ 待实现：需 `@zcode/provider` 的 provider 序列化
- `mcp/list` connect → 真实 spawn codeg-mcp：connected、toolCount=4、
  `protocolEra: "legacy"`；模型工具面确认出现 `mcp__codeg-mcp__delegate_to_agent`（直驱探针）

## 后续工作项

0. **registry/overlay 仍读旧表**（V4 后端才有影响）：`loadZcodeConfig`（喂给
   `workspace/updateProviderRegistry` 与 `setModel` 的 runtimeModel overlay）仍读
   `~/.zcode/v2/config.json`，所以 V4 后端上切换到"新存储里才有"的第三方 provider 依旧会
   `provider_not_configured`。同一份新存储的连接方式见 `src/backend/provider-store.mjs`；
   切换前需确认新存储的模型定义（`properties.contextWindow`、`optionSpecs.reasoningLevel`）
   能补上旧表里的 `reasoning.variants`，否则 overlay 会把会话的思考档位重置成 apiFormat 默认值。
   当前真机 CLI 0.16.9 无 registry RPC，此路径不生效。
1. **跨 provider 切换解锁**：实现 `provider/updateAccountConfig` 推送
   （需按 `packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts`
   的转换逻辑把 config.json 迁移到协议 provider 格式）。
2. **MCP 工具面**：新版后端发布后，现有 connect 调用自动生效；届时用
   `mcp/list` 的 toolCount 断言加回归。
3. ~~**模式面扩展**~~ ✅ 已完成（0.1.6）：向 codeg 暴露 ZCode 的四个可切换模式
   （`plan`/`build`/`edit`/`yolo`，含官方显示名）；`auto` 遵循 v4 弃用不暴露。
   `plan` 在 0.16.5 上无法由客户端强制（见上表），选择器如实回报会话实际状态。
4. **原生 `AskUserQuestion` 的客户端回答面**：ZCode 的原生提问工具需要客户端作答，
   适配器经 `interaction/requestPermission` 转发；codeg 目前只给自己的 MCP
   `ask_user_question` 提供提问 UI，原生提问会走成权限拒绝——模型随后改用纯文本
   重述问题（现场观测：一次「你好」出现两段问候）。要么 codeg 渲染原生提问，要么
   适配器侧开启 `askUserQuestionAutoResolutionEnabled` 让 ZCode 自答（语义待定——桌面端保持 false，
   即把选择权留给用户）。**主要触发源已被上表的默认模式改动消除**：只有客户端显式把会话设为 plan
   （或未来后端允许客户端切 plan）时才会再遇到；届时按上面两条路之一补客户端回答面。
5. **`waiting` 状态**：会话等用户时 projection.status=waiting，适配器可
   向 ACP 侧表达 blocked-on-user（当前仅委托链路有 blocked_on）。
