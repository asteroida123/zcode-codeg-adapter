# zcode-codeg-adapter

面向 **Codeg** 的 ZCode ACP **薄启动适配层**。本仓库不是另一套 ZCode 协议实现，也不是 Codeg/ZCode 官方项目。

```text
Codeg ── ACP / stdio ── zcode-codeg
                          └─ 固定版本 zcode-acp-server.main()
                                 └─ 本机官方 ZCode app-server
```

我们维护的运行代码只有 `bin/zcode-codeg.js` 和 `src/launcher.js`。不 fork 上游，不改写 JSON-RPC，不复制会话、工具、权限和事件翻译器。

## 交付范围

当前版本 `0.1.0` 固定依赖 `zcode-acp-server@0.32.0`（[william0wang/zcode-acp](https://github.com/william0wang/zcode-acp/tree/v0.32.0)）。默认无参数或 `server` 启动 stdio ACP 服务；`--version` 支持 Codeg 的版本探测；`doctor` 检查启动层，不启动 ZCode，不调用模型。

**此版本先通过 Codeg 的自定义 ACP 入口接入，身份是 `custom:zcode-codeg`，不是已经合入 Codeg 的编译级内置智能体。** 自定义入口能复用 Codeg 的选择器、会话记录和委派接入点，不需要新增 ZCode 私有数据库解析器。正式内置的边界与验收见 [docs/CODEG-INTEGRATION.md](docs/CODEG-INTEGRATION.md)。

## 安装与检查

需要真实 Node.js **22（>=22.16.0）或 24**（含 `node:sqlite`）、本机安装并已登录的 ZCode。优先使用更新到安全补丁版本的 Node 22/24；22.16.0 是兼容性下限，不是推荐固定的安全版本。ZCode CLI/桌面运行时与上游桥接的兼容性需在本机验收，不能把 `doctor` 成功当成登录或模型调用成功。

```bash
git clone https://github.com/asteroida123/zcode-codeg-adapter.git
cd zcode-codeg-adapter
git checkout 0525f10d0eb5f49d7f6fa39cdcf472b53e17c445
npm ci --ignore-scripts
npm run check
npm test
npm run test:upstream
node bin/zcode-codeg.js doctor
```

仓库使用实际 npm 安装生成并转换的 `npm-shrinkwrap.json`，锁定直接与传递依赖；它会随 CLI 打包分发，避免只有开发者 clone 安装才受锁文件约束。支持的 Node 下限综合了 SQLite 及完整依赖图的要求，而不只是上游 package.json 的最低声明。

本包不需要构建步骤。`--ignore-scripts` 避免执行依赖的安装生命周期脚本（包括上游的 hub 升级通知）；不要为这个薄适配器增加 postinstall 下载器或自动更新器。首次安装需要访问 npm。项目自身的 `.npmrc` 不会强制约束调用方在全局安装/npx 场景中的配置，外部安装仍需显式使用 `--ignore-scripts`。

尚未发布到 npm；不要使用 `npm install @asteroida123/zcode-codeg-adapter` 当作已发布包安装。

## 在 Codeg 中接入

Codeg：**设置 → 智能体 → 添加自定义智能体 → 手动**。填写 Registry ID `zcode-codeg`、显示名 `ZCode`、版本 `0.1.0`、分发方式 `npx`。

固定运行代码提交的分发 JSON 见 [examples/codeg.distribution.json](examples/codeg.distribution.json)，不需要先发布 npm 包。建议先按上面的源码步骤安装，并运行下面的全局安装命令，再在 Codeg 添加配置；Codeg UI 的实际连接仍需本机验收。

源码本地安装的分发 JSON 模板见 [examples/codeg.local.distribution.json](examples/codeg.local.distribution.json)。将 `file:` 后面的路径改为实际仓库的绝对路径；Windows 在 JSON 中推荐使用 `/` 路径分隔符。`cmd` 必须显式写 `zcode-codeg`，不能让 Codeg 根据带 scope 的包名猜命令。

在仓库目录安装到全局 PATH（不执行依赖的安装脚本）：

```bash
npm install -g --ignore-scripts .
zcode-codeg --version
zcode-codeg doctor
```

手动表单的版本探测命令可显式填 `zcode-codeg --version`。不要假设 Codeg 的 Install/Upgrade 按钮也会采用本仓库的 `.npmrc`；上述预安装命令才是本项目控制的安装路径。

客户端直接启动的命令是 `zcode-codeg`，参数留空，或使用 `node /absolute/path/zcode-codeg-adapter/bin/zcode-codeg.js`。不要启动 `doctor` 作为 ACP 服务；也不要将 Zed 的 `agent_servers` 配置粘贴进 Codeg 的 Distribution 字段。桌面程序找不到 Node 或全局命令时，设置其运行环境/命令路径并重启 Codeg。

Codeg server / Docker 场景下，路径、ZCode 安装及登录都属于**运行 Codeg 后端的机器和系统用户**，不是浏览器所在机器；本包不安装 ZCode，也不迁移凭据。

### 环境变量

沿用上游支持的 `ZCODE_BIN`、`ZCODE_NODE`、`ZCODE_MODEL`、`ZCODE_BASE_URL`、`ZCODE_ACP_LANG`、`ZCODE_ACP_SANDBOX` 等配置。通常可由上游发现安装路径；非标准安装时显式指定（以下路径为占位示例）：

```json
{
  "ZCODE_BIN": "/absolute/path/to/zcode.cjs",
  "ZCODE_ACP_LANG": "zh"
}
```

这是要加进 distribution.npx.env 的内容，不是完整分发 JSON。不要填 API key；先在官方 ZCode 中完成登录。本启动层不读取/复制 ZCode 认证文件，也不输出环境变量或原始上游启动异常。上游仍按其实现管理配置、认证、模型请求和日志；这不是对整个依赖链的隐私/安全认证。

上游自己的 `$XDG_CONFIG_HOME/zcode-acp/config.json`（默认 `~/.config/zcode-acp/config.json`）优先于环境变量。若其 `remote.enabled` 为 true，本启动层会拒绝启动并给出 `E_REMOTE_CONFIG`，不会改写文件；使用此配置需将该字段设为 false 或移除。无法读取或格式异常也会停止。需要同时保留另一客户端的远程模式时，当前上游缺少独立进程覆盖接口，本版不支持这类共享配置组合；不要改 HOME/XDG 来冒充凭据隔离。

此 Codeg 配置设置 `ZCODE_ACP_REMOTE=0`、`ZCODE_ACP_RUNTIME=node`，移除远程/hub/TUI 恢复的已知启动变量。启动前和加载上游后都会检查上述磁盘配置；这是启动预检，不是对并发修改配置的沙箱隔离保证。保留已有 sandbox 设置，不增加自动批准或 yolo 模式。**stdio-only 不是沙箱**：ZCode 仍可按用户权限访问文件、执行工具并连接模型服务。

## 测试与限制

已验证的代码提交、四组跨平台 CI 结果及明确未覆盖的范围见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

`npm test` 是启动层单元/模拟子进程测试，不证明真实 ZCode 可用。`npm run test:upstream` 使用真实安装的固定上游包，在隔离 HOME、无真实 ZCode 可执行文件的环境中验证 ACP 初始化、错误响应和退出，不消耗模型额度；缺少依赖会失败，不会静默跳过。

流式回答、文件修改、权限拒绝、取消、跨进程恢复、MCP 委派和 Codeg UI 仍需 [手工验收](docs/ACCEPTANCE.md)。CI 的自动验证目标为 Linux/Windows/macOS，实际已通过的平台与测试结果以对应提交的 Actions 记录为准。

尚未实现：Codeg 编译级内置入口、ZCode 原生历史导入、Codeg MCP 设置页写入 ZCode 私有配置、自动安装/登录 ZCode、独立 TUI/远程访问。上游的非标准 ACP 扩展仍然属于上游，不因本包变成 Codeg 已支持的功能。

## 维护

升级只有一条路径：评审一个上游版本 → 改精确依赖和锁文件 → 跑跨平台契约测试 → 做真实 ZCode/Codeg 验收 → 发布/固定新提交。不要在本仓库堆积多版本兼容分支或私有 RPC 补丁。升级检查清单见 [docs/MAINTENANCE.md](docs/MAINTENANCE.md)。

本项目新增代码使用 MIT；依赖 `zcode-acp-server` 使用 Apache-2.0，其他依赖各自的许可证和 NOTICE 保持不变。
