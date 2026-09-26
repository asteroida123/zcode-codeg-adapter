# Codeg 内置 ZCode ACP：本地开发任务书

交接日期：2026-09-15。面向接手的本地开发者及编码智能体。

**目标是交付可维护的 ZCode ACP 适配器，以及 Codeg 内置接入改动，不是继续堆叠探测脚本或上游启动封装。**本文件给出当前事实、首要问题、工作顺序和验收标准；执行时应读取本地代码，不依赖此前聊天记录。

## 1. 从哪里接手

- 仓库：`asteroida123/zcode-codeg-adapter`。
- 交接分支：`spike/zcode-backend-contract`，关联草稿 PR #1，未合并 `main`。
- 旧验证基线：`fbc06fddcf7dc594465290e7f75f4b75d37ea092`。
- 已补提交的恢复实验：`b8365957decb843bf166a049cfc11f8d0f3293b0`。此前聊天里的 `zcode-resume-readiness.patch` 已整合成源码，**不要再次 git apply**。
- `main` 的旧启动器基线是 `77bd0dd`；启动器仍依赖 `zcode-acp-server@0.32.0`。这不是新适配核心已经完成的意思。

用户当前本地开发环境为 **Node 25**，必须纳入目标兼容范围。当前已提交代码的安装声明和旧启动器仍只允许 Node 22（至少 22.16）/24；**Node 25 兼容代码尚未提交，先执行下面的 T0**，不能把“任务要求”当作“已经支持”。推荐新建工作目录，避免覆盖旧探测目录中的本地补丁：

```bash
git clone --branch spike/zcode-backend-contract --single-branch https://github.com/asteroida123/zcode-codeg-adapter.git zcode-codeg-dev
cd zcode-codeg-dev
git status --short
git log -3 --oneline
```

已经有本地目录时，先检查 `git status`，再决定快进或保留本地分支；禁止用 `reset --hard`、`clean -fd` 或强制覆盖来“解决”冲突。后续开发可从交接点创建小范围功能分支。

### T0 / P0：Node 25 兼容性（2026-09-15 补充）

用户最新反馈为 Node 25，具体小版本由本地开发工具执行 `node --version` 记录。下面已有真实反馈中的 Node 22.23.1 是**历史测试环境**，不能改写成 Node 25 已通过。用户不需要逐条回传测试日志，由本地开发工具完成检查、修改和回归。

**交接状态：**本轮尝试提交兼容代码时被工具安全检查拦截，未创建相关提交或更新分支；此前版本的 CI 不能用于宣称 Node 25 已通过。本节提交的仅为开发要求。不要假定 `npm run test:runtime` 已存在，也不要手工应用聊天补丁。

1. 将 `package.json` 的 `engines.node`、`npm-shrinkwrap.json` 根包的 `engines.node` 与 `src/launcher.js` 的 `assertNode` 同步扩大到 `^22.16.0 || ^24.0.0 || ^25.0.0` 对应范围；保留 Node 22.16 下限、真实 Node 与 SQLite 能力检查。更新相关错误提示和安装文档，不改变传递依赖版本，不使用 `>=22` 自动承诺所有未来大版本。
2. 新增运行时回归并接入主测试：覆盖 25.0.0 和当前 25.x 的接受、低于下限/未验证大版本/预发布格式/Bun 的拒绝、manifest 与锁文件范围一致，以及实际 `node:sqlite` 内存数据库读写。测试启动器版本预检与上游初始化，不能只 mock 一个版本字符串。
3. 在现有 `.github/workflows/ci.yml` 矩阵中增加 Ubuntu 的 25.0.0 下限、25.9.0，以及 macOS/Windows 的 25.9.0。跑完整离线测试、mutation、合成探测、锁定上游包握手和打包检查；不要用 continue-on-error 或新增 skip 掩盖兼容性失败。
4. 在用户当前 Node 25 上直接跑离线回归；相应授权后，用同一 Node 25 执行 T1 恢复实验并记录实际版本、架构和 ZCode 构建。探测通过 `process.execPath` 启动原生 `.cjs`，宿主能运行不等于原生子进程一定兼容。旧启动器若另配 `ZCODE_NODE`，另记该运行时，不能算全部都在 Node 25 下验证。
5. 若发现 Node 25 特有失败，定位运行时 API、依赖或原生 ZCode 的具体差异，再做窄修复或记录可复现限制；不更改权限/恢复语义，不把未知错误直接归因于 Node 版本。确需改用其他运行时，先说明证据并让用户选择，不自动更改全局 Node 或要求先降级。

**完成标准：**Node 25 不再被项目自己的安装/启动白名单误拒绝；离线和真实上游包测试均有 Node 25 结果；真实 ZCode 结果独立记录。真实恢复续聊的 -32031 和回合关联仍按 T1/T2 处理，不因 runtime 兼容完成而宣称解决。

**维护边界：**Node 25 已于 **2026-06-01** 结束官方维护（[官方生命周期表](https://github.com/nodejs/Release/blob/main/schedule.json)；[Node EOL 说明](https://nodejs.org/en/about/eol)）。本项目目标是兼容用户现有环境，不承担 EOL 运行时的安全补丁；长期部署推荐仍获官方支持的 Node 24 LTS/22 LTS。生产建议与是否兼容是两件事，不能仅因 Node 25 是非 LTS 就认定技术上不可运行。

## 2. 已知事实：不要让用户从头再测

以下是**用户提供的本机运行反馈**，不是 CI 自行跑出的真实模型验收。已知环境为 macOS arm64、Node 22.23.1、ZCode CLI 0.16.5，入口为 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。这是测试基线，不是“当前最新版”的声明；开始本地开发时记录实际版本，发生升级才重做兼容性评估。

| 检查 | 已有证据 | 结论边界 |
| --- | --- | --- |
| CLI 版本 | inspect 通过，0.16.5 | 不等于模型和权限可用 |
| 新会话 | 创建、订阅、读取状态和历史通过 | 原来的缺少模型配置问题已在后续运行中消失 |
| 一轮真实回答 | 收到 8 条流式事件、结束事件，助手历史含随机测试标记 | 基本回答成立；严格回合关联尚未通过 |
| 回合身份 | `turnIdObserved=false`、`terminalIdMatched=false` | 当时仅使用 `payload.turnId`，不能断言所有位置都没有 ID |
| 重启恢复历史 | 第二进程的 resume、subscribe、read、messages 已完成；按控制流，历史标记和数量核对通过 | 历史恢复不等于恢复后的推理可用 |
| 恢复后续聊 | 第二轮 `session/send` 返回 `E_REMOTE / -32031` | **当前首要阻塞，尚未修复验证** |
| 同模型重选实验 | 已入库，有合成回归测试 | 尚未拿到用户真实成功结果；不得宣称已修复 |
| 取消、文件权限、MCP、Codeg UI | 无真实验收记录 | 必须后续验证，不能用模拟通过代替 |

`unknownNotifications=95`、`unknownEvents=5` 是当时未消费的通知/事件计数，不是错误次数，也不是已确认无害的遥测。一次 smoke 成功不能证明所有 provider、模型身份、并发及后台回合都正确。

## 3. 代码地图与维护边界

| 位置 | 接手用途 |
| --- | --- |
| `spikes/backend-contract/rpc.mjs` | 私有 NDJSON 传输、双向请求、超时、进程回收；不是 ACP 服务端 |
| `backend.mjs`（同目录） | 原生会话、回合、权限拒绝和恢复实验接线 |
| `resume-model.mjs`（同目录） | 仅对原模型做显式重选的候选实验 |
| `probe.mjs`、`turn-evidence.mjs`（同目录） | 探测流程、分阶段证据和身份形态；不是生产业务层 |
| `scripts/probe-zcode.mjs` | 离线/真实探测入口；默认 synthetic |
| `scripts/setup-zcode-cli.mjs` | 独立的一次性本机配置工具；现有机器已完成配置，不要重复执行 |
| `test/resume-readiness.test.js`、`test/fake-resume-model.cjs` | 恢复实验及合成后端反例 |
| `bin/zcode-codeg.js`、`src/launcher.js` | 历史薄启动封装，暂留对照，不是最终目标架构 |
| `docs/RESTORE-READINESS.md`、`docs/TURN-EVIDENCE.md` | 恢复问题和证据字段的详细说明 |

目标分层为：**Codeg → 自有 ACP 映射/会话协调 → 窄 ZCodeBackend 接口 → ZCode 原生后端**。自己负责会话状态、事件语义、权限转接和兼容性；模型推理、原生工具执行、原生认证继续交给 ZCode。

首版只维护一个已验证后端路径和有限版本组合，优先现有 app-server。只有出现可复现且无法在窄范围解决的关键缺口，再评估 desktop host；不要同时养两套生产实现。也不要只把 `main()` 封装换成上游内部文件的深层导入。

不做独立 TUI、远程 Hub/HTTP 服务、多后端框架、自动登录或令牌刷新、原生数据库解析、ZCode App 旧历史批量导入。Codeg 中新建会话的保存和继续是首版基本能力，不能排除。

现有 README、MAINTENANCE 等文档描述了历史薄封装阶段；它们不构成“新实现永远不得拥有协议层”的限制。迁移生产入口时应同步更新这些文档，但不要为重构而重构。

## 4. 首批任务：恢复、回合归属、取消

### T1 / P0：修复“恢复后不能继续发送”

先运行离线回归，再在用户授权额度后执行已入库的恢复实验。不要重跑 setup、重复下载补丁，也不要无限重复同一条付费测试。

```bash
node --test test/resume-readiness.test.js
```

以下命令最多发送两次模型提示，并请求在临时测试会话中重选原模型；必须获得本机模型测试授权后运行：

```bash
node scripts/probe-zcode.mjs --live --zcode "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" --allow-model --scenario resume --rebind-resume-model
```

读取 `resumeProgress.stage / firstTurn / historyRetained / modelRebind / secondTurnRetainedContext`。`modelRebind.verified` 仅证明选择、plan、idle 读回符合预期，不证明推理恢复；数值 `-32031` 也不能独自证明根因。[1]

本地开发者应检查原生恢复响应及状态中实际可用的警告、模型引用和工作区关联，在本机检查必要错误，向用户仅报告脱敏结论。当前 `--local-error` 只支持 session，不支持 resume；不要给用户一个无效参数组合。需要增加恢复诊断时，保持默认不输出原文、明确开启、限定请求和本地保存，不收集无关配置。

若重选仍被拒绝或缺少预期模型字段，保留阶段证据、确认真实 schema，再做单点修复；不要猜模型、静默切到首个 provider、清除原生保护条件、解密凭据或重发结果不明的提示。不得以新建空会话或把历史拼成新 prompt 冒充原生恢复。

**完成标准：**同一会话和原模型保持；跨进程恢复后第二轮真正回答并记得第一轮；失败原因可定位；至少覆盖恢复被拒、模型变更、历史丢失、选模假成功和仍不可推理的反例。真实结果与合成结果分别记录。

### T2 / P0：把回合关联做正确，不强求字段名称

研究真实事件的 ID 位置、事件序号、前台/后台标记和结束条件，先得到有边界的样本与规则，再实现归一化。`foregroundExecutionId`、顶层 ID、`payload.turnId` 不得未经验证就当成同义字段。

验收目标是“不会串回合”，不是强求某个 JSON 字段存在。确实没有原生 ID 时，可评估会话+事件边界+单活跃回合等替代规则，但必须明确约束，覆盖迟到终止、重复开始、订阅积压、后台/内部回合、连续提示和双会话的反例。不能因随机标记正确或状态 idle 就强行把严格身份匹配标为 true。

保留“回答正确”“原生 ID 匹配”“替代关联已验证”三种不同证据。若采用替代判定，版本化修改报告和测试，不能只放宽旧断言。没有充分关联依据时不发布该能力。

### T3 / P0：真正停止工作，而不是只关闭 UI

目前 `cancel` 只发送 legacy `session/stop`；参考项目报告部分构建该方法不起作用，需验证 V4 stop，但不能未经实测就全量接入 V4。[2]

验证生成中取消、待审批取消、重复取消、取消后立即下一轮、退出客户端、后端异常退出。取消和进程回收分开记录：发送 stop 不等于已取消，强杀进程不等于协议取消成功，根进程退出不等于所有派生进程已回收。

**完成标准：**有对应回合停止证据，挂起交互得到结算，旧消息不进入新回合，清理有期限并记录未覆盖的平台/分离子进程边界。超时不能伪造成功。

## 5. 第二批任务：形成真正可用的 ACP 适配器

### T4 / P1：自有 ACP 核心和工具交互

使用与目标 Codeg 兼容的 ACP SDK/协议版本，固定依赖。参考 `xintaofei/deepseek-acp` 的窄后端接口和契约测试，以及 `agentclientprotocol/codex-acp` 的分层；不是复制其全部功能或所有依赖。[3]

首版完成初始化/能力声明、新会话、流式提示、可靠回合结束、取消、历史加载/续聊、工具状态与文件变更、权限允许/拒绝，以及必要的配置选择。将 probe 的“一律拒绝”替换为真正的客户端决策转接；等待超时、断开或未知选择不能默认允许。

标准 ACP `session/load` 需在历史回放完成后返回；具备协商能力的 `session/resume` 不回放历史。它们与 ZCode 同名私有方法不可机械等同。只声明已实现能力；MCP stdio 是基础要求，不应静默丢弃客户端传入配置；HTTP/SSE 等按实际能力协商。[4]

使用临时测试仓库验证：读文件、批准一次修改、拒绝一次修改、长时间工具、错误结束。检查磁盘实际内容、工具卡片和 diff 一致；无权限请求发生时不能算“拒绝有效”。不要用批准所有操作或 yolo 默认值换取测试通过。

后端关键规则形成证据后，把稳定模块迁入 `src/`；探测工具只调用同一实现，避免验证版与生产版成为两套逻辑。小范围重构优先，不为迁移强行引入新语言/构建链。

### T5 / P1：Codeg 接入是单独交付，不止一个配置文件

先阅读 Codeg 当前 checkout 的 `AGENTS.md`、智能体注册/类型、启动和历史路径，记录实际基线提交；此前研究的 main 已是历史快照。允许自定义 ACP 入口作为联调阶段，但最终需给出编译级内置 ZCode 的补丁及验收说明，不把自定义智能体改名当成内置完成。

适配器仓库与 Codeg 工作树分离。处理内置 ID/名称/图标、安装与运行环境诊断、版本检查、前端选择与会话身份，以及已有 `custom:zcode-codeg` 会话的兼容策略。优先评估复用 Codeg 通用 ACP 记录，不额外维护 ZCode 私有数据库解析器；必要改动以实际代码评审为准。

**完成标准：**从 Codeg 启动并连续对话，正确展示工具/审批/diff，停止后能继续，关闭重开后历史不重复且能续聊，Codeg 注入的 MCP 测试工具有真实调用结果。交付本地 Codeg 补丁/分支和安装说明；不承诺上游已经接收或合并。

### T6 / P1：打包、兼容性与维护说明

从 `npm pack` 产物在干净目录安装并运行，而不是只测开发路径。确认 `files` 列表包含新生产核心及所需模块、依赖锁和命令入口；当前 scripts/spikes 不进入发布文件集，不能忘记迁移。

保留 Linux/macOS/Windows 的离线 CI（含 Node 25），先把用户当前 Node 25 / macOS arm64 的真实链路跑通。其他平台未真实验收就标注未验证；构建成功不能替代运行成功。明确 Node/ZCode/ACP/Codeg 版本组合、升级复测入口、失败诊断和回滚方法。

交付需要代码、回归、真实证据、Codeg 改动、安装文档五者同时可查，不以测试数量或 CI 绿色单独验收。

### T7 / P0：ZCode 父委托链路三缺陷加固（2026-09-26 集成线实测）

背景：ZCode 桌面 0.16.5 + 本 adapter 0.1.4。ZCode 会话工具表已挂上完整
codeg-mcp 工具集，ZCode→codex 委托端到端可通；实测暴露三个"ZCode 作为父
智能体委托他人"链路上的真实阻断点。分支 `feat/parent-delegation-hardening`，
每缺陷一个提交。真机复测已于 2026-09-26 完成（见下方"真机复测结果"）：
场景 1/2 通过；场景 3 首轮暴露 E_FRAME 真机形态缺口，修复（`c6439a6`）后
复测通过。

1. **权限请求风暴**（`src/backend/backend.mjs`）
   - 实测现象：一条 MCP 工具调用触发的 `interaction/requestPermission` 未应答
     期间，原生后端每 2-10 秒用**新 request id** 重发同一 tool_call 的权限请求；
     adapter 1:1 透传成 `session/request_permission`，客户端排队 12-21 条；约
     185 秒后后端以 `Internal error: E_FRAME` 拒绝。
   - 修复：`reverseRequest` 按 `(sessionId, toolCallId)` 去重——同一在途
     tool_call 只向 ACP 客户端转发一次，重复 reverse 请求 **join** 同一决策
     （每个 reverse id 仍各自得到响应，不悬挂）；决策落定后 30 秒退避窗口内
     的重问**重放**已记录决策（重放的 allow 只可能是客户端对该 tool_call 已
     给出的选择，重放的 deny 仍计入当轮 denied）。上限：join 32、条目 64；
     新增 `metrics.permissionsDeduped` 计数。
   - 回归：fake 新增 `permission-retry`（6 连发同 tool_call、各自待响应），
     断言客户端只见 1 条且 6 个 reverse id 全部被应答；另钉住窗口内重问不
     重新弹窗、跨窗口会重新询问。mutation：join 返回值置 null 必须红。
2. **E_FRAME 会话砖化**（`src/backend/diagnostics.mjs`、`src/backend/backend.mjs`、`src/acp/server.mjs`）
   - 实测现象：后端一旦返回 `Internal error: E_FRAME`，该 session 后续所有
     prompt 约 5ms 内被同样拒绝；adapter 原行为是每次 prompt 原样转发底层错误。
   - 修复：diagnostics 新增闭枚举 hint `native-frame`（`\bE_FRAME\b` 符号/文本
     识别，不复制远端文本）；`session/send` 拒绝命中该 hint 时归一为
     `E_SESSION_FATAL`（携带 rpcCode 与 hints）并照旧关闭传输。ACP 层做
     **恰好一次**恢复尝试：复用 cancel 路径的 recycle（新后端进程 + resume
     同一原生会话 + read 校验），成功则错误信息明确指引"重试一次"；resume
     失败或恢复后再次 E_FRAME 则标记永久 fatal——此后每次 prompt 立即返回
     同一条可操作错误（"close this session and create a new one"），不再触
     后端。失败 prompt 不自动重放（是否重发由客户端决定）；恢复后有一次
     成功 prompt 即重置计数（新的砖化事件有自己的恢复机会）。真机复测
     （2026-09-26）补充：真机上该故障还以**传输层断帧**形态出现（无错误
     响应、stdout 帧损坏、本地 E_FRAME 传输错误），`c6439a6` 将本地
     E_FRAME 传输码同判 session-fatal，并在 `abortTurns` 的 fault 同步结算
     路径先行分类（onFault 先于 send 拒绝微任务结算 turn，只在 send 处
     分类来不及）。
   - 边界（如实记录）：resume+read 只证明传输与读回正常，**不证明 send 可
     用**，故恢复后首条 prompt 若再 E_FRAME 才升级永久 fatal；后端没有任何
     "重建会话/健康探测"动词，adapter 侧更深的恢复需要 ZCode 后端支持。
   - 回归：fake 新增 `frame-transient`（进程内损坏，resume 痊愈）与
     `frame-brick`（持久砖化）；分别钉住"恢复后重试成功"与"三次 prompt 的
     错误语义：第一条含恢复结果、第二/三条为同一稳定错误"。mutation：
     native-frame 分类改判 request-schema 必须红。
3. **connect 时 preferredConfigValues 的 mode 不生效**（新增 `src/acp/preferred-config.mjs`、`src/acp/server.mjs`）
   - 根因：Zed/codeg 风格客户端在 initialize **顶层**发
     `preferredConfigValues:{"mode":"build"}`，而锁定 SDK 1.4.0 的 initialize
     zod schema 剥离未知顶层字段，值到不了 `initialize()` handler；
     `newSession` 又硬编码 `mode:'plan'`——plan 模式调不了 MCP 工具，委托链
     被卡在计划流程。
   - 修复：stdin 上加**被动** TransformStream 嗅探（字节原样转发、仅旁路解
     析 initialize 帧提取该字段；256KB 扫描预算、sanitize 只收基本类型、
     16 键/256 字符上限）；同时接受 `_meta.preferredConfigValues`（schema 保
     留 `_meta`，顶层线上值优先）。`newSession` 以 preferred mode 调 create，
     并立即补发一次已验证动词 `session/setMode`（等价于建立时即做一次
     acp_set_config_option(mode)）+ `current_mode_update` 通知。off-menu 值
     （如 yolo）忽略不猜；`session/load` 不应用（保留会话持久化 mode）；
     原生拒绝 setMode 时诚实降级，configOption currentValue 如实显示。
   - 回归：新增 `test/preferred-config.test.js`（字节级转发不变形、分块边
     界、噪声/伪造帧、预算放弃、sanitize 边界，8 项）+ acp-server 3 项（顶
     层生效含 current_mode_update、_meta 生效、off-menu 保持 plan）。注：
     plan/build/edit/yolo 是 ZCode 模式枚举，本修复只应用已向客户端广告
     的 plan/build；edit/yolo 的广告面仍按 PROTOCOL-CALIBRATION 后续项处理。

测试证据（合成，本机 macOS arm64，本轮复跑 Node 22.23.1）：`npm run check` 通
过；`npm test` 238 项全过（原 235 + `c6439a6` 新增 3：传输断帧 contract 1、
acp 恢复/永久 2；此前 235 含 backend-contract 5（含跨窗口重问）、acp-server
新增 3 项 preferred + 2 项 frame + 1 项风暴、preferred-config 8）；`npm run
test:mutations` 11/11 检出（新增：transport frame classification；此前含权限
去重、native-frame 分类、嗅探捕获）；`npm run probe:backend` synthetic/pass。

真机复测结果（2026-09-26，macOS arm64 / Node 22.23.1 / ZCode 桌面 0.16.5，
本分支含 `c6439a6`；驱动 `spikes/live-retest/driver.mjs`，脱敏逐帧证据与
verdict 在 `/tmp/zcode-live-retest/<scenario>/`，修复前的失败证据存档于
`/tmp/zcode-live-retest/storm-prefix-buggy/`）：

1. **preferred mode 真机生效 —— PASS**。initialize 顶层
   `preferredConfigValues:{"mode":"build"}`（SDK schema 会剥离、靠 stdin 嗅探
   捕获）→ newSession 返回前收到 `current_mode_update=build`，configOption
   mode currentValue=build；极小 bash 任务 1 个 tool_call
   （pending→in_progress→completed）、stopReason=end_turn、标记回流，无 plan
   模式拒绝。反向对照 `preferredConfigValues:{"mode":"plan"}`：setMode(plan)
   被原生接受并发出 `current_mode_update=plan`——证明模式确实由嗅探到的
   preferred 值驱动，而非原生默认恰好相同。环境事实（如实记录）：0.16.5 的
   `session/create` 不决定初始 mode——全新 workspace、create(mode:plan) 仍
   返回原生默认（本机为 build），且 create 后 ~200ms 内原生会重申自身默认；
   与原生默认相反的钉扎可能被盖回（adapter 侧 currentValue 如实上报实际
   运行值，不伪造）。修复中的显式 setMode 是承重步骤。
2. **权限风暴去重 —— PASS**。build 会话 Write 工具触发 1 条
   `session/request_permission` 后**故意不应答**，两轮分别挂起 280.6s /
   278.6s（覆盖 185s 阈值）：客户端累计仅 1 条权限请求（修复前字段报告
   12-21 条），原生重发全程被去重吸收；风暴按预期以 E_FRAME 收尾（prompt
   发出后 ~301s，即权限挂起 ~278s）。
3. **E_FRAME 恢复 —— 首轮 FAIL → 修复 → 复测 PASS**。首轮（修复 5840624
   后、`c6439a6` 前）：真机 E_FRAME 以**传输层断帧**形态出现——无错误响应、
   stdout 帧损坏、adapter 本地 E_FRAME 传输错误——`isNativeFrameRejection`
   只认响应形态（E_REMOTE + native-frame hint），未分类未恢复，客户端收到
   原样转发的 `{"code":-32603,"message":"Internal error","data":{"details":
   "E_FRAME"}}`。修复 `c6439a6` 后复测：prompt1 于 301.9s 收到归一化的
   `E_SESSION_FATAL`（"backend process was recycled and the native session
   resumed - retry this prompt once"）；客户端重试同一 prompt → 新 Write 权限
   请求（本轮应答 allow_once）→ 工具 completed、`storm.txt` 落盘
   （content=storm-marker-42）、end_turn；第三条探测 prompt 亦 end_turn
   （4990ms）。恢复分支 **transient-recovered**：本机 0.16.5 的 E_FRAME 损伤
   为进程级，recycle（新进程 + resume 同一原生会话 + read 校验）即痊愈，
   会话恢复后持续可用。

残留（需 ZCode 后端或后续配合）：
- 权限未应答为何演化为会话级 E_FRAME——根因在后端的重发/超时策略，adapter
  只能止血（去重）+ 砖化后恰好一次恢复（真机 2026-09-26 复测：损伤为进程级，
  recycle+resume 痊愈）或清晰失败；
- 会话级致命错误无后端恢复动词（无 rebuild/health-probe），恢复上限即本修
  复的 recycle+resume+read；
- 0.16.5 发布版 create 不装配 `params.mcpServers`（见 PROTOCOL-CALIBRATION），
  MCP 工具面完整依赖新版后端，与本轮三项修复正交；
- 0.16.5 的 `session/create` 不决定初始 mode（真机复测实测），新会话模式取
  原生全局默认；adapter 侧已用显式 setMode 钉扎，但与原生默认相反的钉扎
  可能在 create 后 ~200ms 内被原生重申覆盖（见真机复测结果 1）。



以下基线检查不需要 npm 安装或真实账号：

```bash
npm run check
npm test
npm run test:mutations
npm run probe:backend
```

测试旧启动器与锁定上游包时，才另外安装依赖；不是恢复实验的前置条件：

```bash
npm ci --ignore-scripts
npm run test:upstream
```

权限/模型/文件副作用必须按测试组明确授权。无授权时仍可编写代码、跑合成回归、分析已提供的脱敏结果，不要因此停止所有开发。原生会话可能残留在 ZCode 存储中；临时 cwd 不是操作系统沙箱。不要修改用户业务项目、读取无关文件、自动重做 CLI 配置或把秘密写进 Git。

在本地工具具备终端访问且用户授权相应测试后，开发者直接完成运行—查看—修复—回归，不再让用户逐条复制命令或搬运日志。遇到未知错误应先取本地必要证据，不在每次失败后仅新增一层分类器。

原始日志、配置、备份、会话 ID 和可能含秘密的本机错误文件留在本机。确需纳入 fixtures 的真实样本应单独取得授权、脱敏审查并注明来源；现有 fake fixtures 必须保持 synthetic 标签。

## 7. 每个任务的交付格式

每一阶段单独提交，说明改了哪些文件、为什么、测试命令/实际结果、真实与合成证据、未完成项和下一步。通过时记录适配器提交、原生 CLI/应用构建、Node、系统架构、Codeg 提交、场景及故障修复前后差异；不提交原始秘密。

完成 T0 Node 25 兼容性后，T1 首个本地工作回合应至少交付：离线回归结果；授权后的恢复实验结果或明确未运行原因；针对 -32031 的有证据判断；一个小范围修复/诊断改动和回归，或能够复现阻塞的脱敏说明。T2/T3 的关联与取消未成立前，不把整套生产适配器标为完成。

用户没有要求自动合并或发布。保留草稿 PR，未经明确授权不合并 `main`、不发布 npm、不覆盖其他工作树；不要为“整理”把失败证据或保护测试删掉。

## 8. 给本地编码智能体的启动指令

> 读取根目录 AGENTS.md 和 TASKBOOK.md，然后检查实际代码与工作树。目标是面向 Codeg 的自有、窄边界 ZCode ACP 适配器，不是上游 main() 薄封装。先完成 T0 Node 25 兼容性，再从 T1 恢复后 -32031 阻塞接手，再解决 T2/T3 回合关联与取消，然后推进 ACP 核心和 Codeg 内置集成。恢复实验已入库，不要再应用聊天补丁，不要重复 setup。用户当前 Node 为 25，先在该运行时跑离线测试，不擅自降级；真实模型/文件测试只在本机获得相应授权后执行。由你直接读取本地必要诊断、修复和回归，不让用户充当命令转发器。保留失败前证据，不伪造恢复、权限或回合匹配，不自动合并或发布。结束时给出改动、测试、已证实结论和剩余阻塞。

## 9. 参考资料与证据优先级

以本仓库源码和本机实测为准，下面只是定位入口，不是兼容性保证；复用代码前核对许可、来源提交和修改边界。

[1] [恢复实验说明](docs/RESTORE-READINESS.md)、[回合证据说明](docs/TURN-EVIDENCE.md)。恢复警告线索见 [zai-org/feedback#223](https://github.com/zai-org/feedback/issues/223)，不同平台/版本的问题不能直接当作本机根因。

[2] ZCode app-server 参考：[william0wang/zcode-acp](https://github.com/william0wang/zcode-acp)、[tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge)。desktop host 备选：[supermomonga/zcode-acp](https://github.com/supermomonga/zcode-acp)。不整仓照搬、不同时维护所有接入路径。

[3] 工程对标：[xintaofei/deepseek-acp](https://github.com/xintaofei/deepseek-acp)、[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)。宿主：[xintaofei/codeg](https://github.com/xintaofei/codeg)。

[4] ACP 官方规范：[Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)（交接时核对；具体实现须匹配所固定的 SDK 与 Codeg）。

交接时本地 Linux/Node 22.16 对恢复补丁重跑了 29 项新测试与 31 项旧启动层测试，60 项均通过；默认离线 probe 为 synthetic/pass，diff 检查通过。代码提交 `b836595` 的 [CI 运行 34981695815](https://github.com/asteroida123/zcode-codeg-adapter/actions/runs/34981695815) 已核对四组作业全部成功：Ubuntu/Node 22.16、Ubuntu/Node 24、macOS/Node 22、Windows/Node 22，涵盖全分支测试、mutation、合成探测、旧上游握手和打包检查。后续仅任务文档提交不改变该运行代码；以后新增代码仍需自己的 CI 结果。不把此次交接理解成新一轮真实 ZCode 验收。
