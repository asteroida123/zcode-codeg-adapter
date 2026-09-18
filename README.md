# zcode-codeg-adapter

面向 Codeg 的 ZCode ACP 适配器：自有 ACP 核心 + 窄边界 ZCode 后端接口。本仓库不是 ZCode/Codeg 官方项目，也不是上游 `zcode-acp-server` 的 fork。

```
Codeg ── ACP / stdio ── zcode-codeg-acp（本仓库：会话协调/事件翻译/权限转接）
                          └─ 私有 NDJSON ── 本机官方 ZCode app-server（zcode.cjs）
```

分层职责：**Codeg 负责记录 ACP transcript（会话历史）；适配器负责 ACP↔原生语义映射；ZCode 负责模型推理、原生工具、认证。** 适配器不解析 ZCode 私有数据库、不迁移凭据、不做远程服务。

## 当前状态

- **npm：[`zcode-codeg-adapter@0.1.3`](https://www.npmjs.com/package/zcode-codeg-adapter)**（MIT，无 scope，stdio-only）
- **Codeg 编译级内置 PR 已提交**：[xintaofei/codeg#768](https://github.com/xintaofei/codeg/pull/768)——内置 `zcode`、registry id `zcode-acp`、pin 本包。**合并前**仍可用自定义智能体方式接入（身份 `custom:zcode-codeg`，见下）
- 真机验收基线：ZCode CLI 0.16.5 / macOS arm64（完整矩阵见 `docs/ACCEPTANCE.md`）

## 架构

生产入口 `zcode-codeg-acp`（`bin/zcode-codeg-acp.js`）实现完整 ACP 服务端（`src/acp/server.mjs`）：初始化/能力声明、新会话/加载、流式提示、工具调用镜像、权限转接（客户端决策，默认拒绝）、取消、模型/模式选择器。原生侧（`src/backend/`）经私有 NDJSON 驱动 ZCode app-server，回合关联与取消契约有版本化证据（`docs/TURN-EVIDENCE.md`、`docs/CANCELLATION.md`）。

旧入口 `zcode-codeg`（`bin/zcode-codeg.js` + `src/launcher.js`）是历史薄启动封装，仅作对照保留，不再是目标架构。

### 模型目录与切换（双代协议）

会话快照的可用模型列表在真机上只含当前模型；完整目录在 ZCode 桌面配置 `~/.zcode/v2/config.json` 的 provider 表。适配器合并两者，模型选择器可列出全部可用模型。切换协议按后端能力探测自动选择：

- **V4 代后端**：`workspace/updateProviderRegistry` 推送 + `session/setModel` 带 `runtimeModel` overlay（第三方 provider 密钥走 inline 联合体；builtin 走自身 OAuth，绝不内联）
- **0.16.5**：无 registry RPC；`setModel` 的 model ref 必须带 `options.reasoningLevel`。跨 provider 切换受后端 Provider Registry 限制（干净报错，会话不倒）——ZCode 后端升级后 V4 路径自动启用

## 安装

需要 Node 22（≥22.16.0）/ 24 / 25（含 `node:sqlite`）、本机安装并已登录的 ZCode。长期部署优先获官方支持的 Node 24/22 LTS；Node 25 已过官方维护期，本项目保证可运行但不承担其安全补丁。`doctor` 只检查启动层，不等于登录或模型可用。

```sh
npm install -g zcode-codeg-adapter
zcode-codeg-acp --version
zcode-codeg-acp            # 需 ZCODE_CODEG_ENTRY，见下
```

开发：

```sh
git clone https://github.com/asteroida123/zcode-codeg-adapter.git
cd zcode-codeg-adapter
npm ci --ignore-scripts
npm run check && npm test && npm run test:mutations
npm run probe:backend       # 合成探测，无账号无网络
```

## 在 Codeg 中接入

**PR #768 合并后的版本**：智能体列表直接出现 ZCode，无需任何配置——Codeg 启动时自动探测标准安装位置（`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` 等）。非标准安装位置在 设置 → ZCode → Environment 填 `ZCODE_CODEG_ENTRY`。

**合并前的自定义方式**：设置 → 智能体 → 添加自定义智能体，分发 JSON 见 `examples/codeg.distribution.json`（npm pin）或 `examples/codeg.local.distribution.json`（本地 `file:`）。cmd 必须显式写 `zcode-codeg-acp`。

存量 `custom:zcode-codeg` 会话在内置合并后保持原身份可读，不强制迁移。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `ZCODE_CODEG_ENTRY` | 是 | ZCode CLI `.cjs` 入口的绝对路径（Codeg 内置模式会自动探测标准位置） |
| `ZCODE_CODEG_CONFIG` | 否 | 适配器自身配置文件绝对路径（恢复续聊等高级场景，见 `docs/RESTORE-READINESS.md`） |

认证完全由 ZCode 自身登录管理；适配器不读取/复制/刷新凭据。密钥纪律：provider 密钥只进入发往本机 ZCode 后端的 RPC 载荷，不进日志、错误消息或 transcript。

## 测试与验证

`npm test`（216 项）覆盖 ACP 服务端契约、权限 kind 映射、模型目录规则、双代切换协议（含 0.16.5 降级路径）与恢复实验；`test:mutations` 防探测退化；`probe:backend` 合成验证后端接口。真机场景（模型额度、文件写入、Codeg UI）用 `scripts/acp-live-*.mjs` 做显式验收，结果记录在 `docs/ACCEPTANCE.md`。

已知边界：ZCode 0.16.5 后端不把 `session/new` 传入的 `mcpServers` 挂载为模型工具（codeg-mcp 委派因此在该版本不可用，待上游支持）；`session/resume` 路径不重传 mcpServers。行级 diff 文本尚未在工具镜像中携带。

## 维护

升级路径：评审一个 ZCode 后端版本 → 裸协议探测差异（`spikes/backend-contract/`）→ 更新 seam 与测试 → 真机验收 → 发布并固定新提交。不堆积多版本兼容分支，不猜协议字段。详见 `docs/MAINTENANCE.md` 与 `TASKBOOK.md`。

本项目新增代码 MIT；测试与文档为各自的贡献内容。
