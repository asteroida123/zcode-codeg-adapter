# Codeg 内置 ZCode ACP：本地开发任务书

交接日期：2026-09-15。面向接手的本地开发者及编码智能体。

**目标是交付可维护的 ZCode ACP 适配器，以及 Codeg 内置接入改动，不是继续堆叠探测脚本或上游启动封装。**本文件给出当前事实、首要问题、工作顺序和验收标准；执行时应读取本地代码，不依赖此前聊天记录。

## 1. 从哪里接手

- 仓库：`asteroida123/zcode-codeg-adapter`。
- 交接分支：`spike/zcode-backend-contract`，关联草稿 PR #1，未合并 `main`。
- 旧验证基线：`fbc06fddcf7dc594465290e7f75f4b75d37ea092`。
- 已补提交的恢复实验：`b8365957decb843bf166a049cfc11f8d0f3293b0`。此前聊天里的 `zcode-resume-readiness.patch` 已整合成源码，**不要再次 git apply**。
- `main` 的旧启动器基线是 `77bd0dd`；启动器仍依赖 `zcode-acp-server@0.32.0`。这不是新适配核心已经完成的意思。

运行环境使用 Node 22（至少 22.16）或 Node 24。推荐新建工作目录，避免覆盖旧探测目录中的本地补丁：

```bash
git clone --branch spike/zcode-backend-contract --single-branch https://github.com/asteroida123/zcode-codeg-adapter.git zcode-codeg-dev
cd zcode-codeg-dev
git status --short
git log -3 --oneline
```

已经有本地目录时，先检查 `git status`，再决定快进或保留本地分支；禁止用 `reset --hard`、`clean -fd` 或强制覆盖来“解决”冲突。后续开发可从交接点创建小范围功能分支。

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

保留 Linux/macOS/Windows 的离线 CI，先把真实 macOS arm64 跑通。其他平台未真实验收就标注未验证；构建成功不能替代运行成功。明确 Node/ZCode/ACP/Codeg 版本组合、升级复测入口、失败诊断和回滚方法。

交付需要代码、回归、真实证据、Codeg 改动、安装文档五者同时可查，不以测试数量或 CI 绿色单独验收。

## 6. 本地命令与执行约束

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

T1 首个本地工作回合应至少交付：离线回归结果；授权后的恢复实验结果或明确未运行原因；针对 -32031 的有证据判断；一个小范围修复/诊断改动和回归，或能够复现阻塞的脱敏说明。T2/T3 的关联与取消未成立前，不把整套生产适配器标为完成。

用户没有要求自动合并或发布。保留草稿 PR，未经明确授权不合并 `main`、不发布 npm、不覆盖其他工作树；不要为“整理”把失败证据或保护测试删掉。

## 8. 给本地编码智能体的启动指令

> 读取根目录 AGENTS.md 和 TASKBOOK.md，然后检查实际代码与工作树。目标是面向 Codeg 的自有、窄边界 ZCode ACP 适配器，不是上游 main() 薄封装。先从 T1 恢复后 -32031 阻塞接手，再解决 T2/T3 回合关联与取消，然后推进 ACP 核心和 Codeg 内置集成。恢复实验已入库，不要再应用聊天补丁，不要重复 setup。先跑离线测试；真实模型/文件测试只在本机获得相应授权后执行。由你直接读取本地必要诊断、修复和回归，不让用户充当命令转发器。保留失败前证据，不伪造恢复、权限或回合匹配，不自动合并或发布。结束时给出改动、测试、已证实结论和剩余阻塞。

## 9. 参考资料与证据优先级

以本仓库源码和本机实测为准，下面只是定位入口，不是兼容性保证；复用代码前核对许可、来源提交和修改边界。

[1] [恢复实验说明](docs/RESTORE-READINESS.md)、[回合证据说明](docs/TURN-EVIDENCE.md)。恢复警告线索见 [zai-org/feedback#223](https://github.com/zai-org/feedback/issues/223)，不同平台/版本的问题不能直接当作本机根因。

[2] ZCode app-server 参考：[william0wang/zcode-acp](https://github.com/william0wang/zcode-acp)、[tizerluo/zcode-open-bridge](https://github.com/tizerluo/zcode-open-bridge)。desktop host 备选：[supermomonga/zcode-acp](https://github.com/supermomonga/zcode-acp)。不整仓照搬、不同时维护所有接入路径。

[3] 工程对标：[xintaofei/deepseek-acp](https://github.com/xintaofei/deepseek-acp)、[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)。宿主：[xintaofei/codeg](https://github.com/xintaofei/codeg)。

[4] ACP 官方规范：[Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)（交接时核对；具体实现须匹配所固定的 SDK 与 Codeg）。

交接时本地 Linux/Node 22.16 对恢复补丁重跑了 29 项新测试与 31 项旧启动层测试，60 项均通过；默认离线 probe 为 synthetic/pass，diff 检查通过。代码提交 `b836595` 的 [CI 运行 34981695815](https://github.com/asteroida123/zcode-codeg-adapter/actions/runs/34981695815) 已核对四组作业全部成功：Ubuntu/Node 22.16、Ubuntu/Node 24、macOS/Node 22、Windows/Node 22，涵盖全分支测试、mutation、合成探测、旧上游握手和打包检查。后续仅任务文档提交不改变该运行代码；以后新增代码仍需自己的 CI 结果。不把此次交接理解成新一轮真实 ZCode 验收。
