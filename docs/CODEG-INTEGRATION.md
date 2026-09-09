# Codeg 接入与正式内置的边界

评审基线：`xintaofei/codeg@541bdc91caa42d86780c6ab678f436b0d981f613`。

## 当前可配置的路径

Codeg 已有 `CustomAgentSpec.npx`：package、args、env、cmd、node_required；身份持久化为 `custom:<registry-id>`。本项目选择 `custom:zcode-codeg`。名称可显示 ZCode，但不冒充编译级内置。

- 配置优先使用固定提交的 `examples/codeg.distribution.json`；本地模板为 `examples/codeg.local.distribution.json`，`file:` 路径属于 Codeg 后端主机。
- `--version` 返回适配器版本，不是 ZCode CLI 或上游版本；doctor 分开报告上游版本。
- Codeg 负责记录 ACP transcript；不碰 ZCode 私有历史 schema。
- 上游负责将 session/new 的 mcpServers 传给后端；Codeg 的 MCP 支持开关可保留开启，但真实委派仍要手工验收。
- Codeg 自定义智能体不能从其 MCP 设置页管理 ZCode 私有配置。不要声称普通 MCP 服务器设置自动同步。
- Skills 目录不凭猜测填写。只有确认当前 ZCode 实际读取该目录后，才在 Codeg 声明 shared store 或专用路径。

本地 file: 包与 GitHub 包安装都由调用方 npm 处理，本包不创建额外下载器。运行期不自动升级。生产部署固定适配器提交，并在该提交下使用锁文件安装；不要追随 main/latest。

## 正式内置：单独的 Codeg 改动，未在本提交实现

必须跟 Codeg 维护者确认历史来源契约，不能只在 registry 填一个显示名就声称完成。建议继续使用 Codeg 自有 ACP transcript，而不是逆向 ZCode 数据库。

最少要审查的触点：

1. `src-tauri/src/models/agent.rs` 的枚举、wire 序列化、显示名和常量；`acp/registry.rs` 的 builtin 集合、registry_id 映射、分发与原生 CLI/适配器关系。
2. 将 ACP 录制/恢复的策略从“只有 Custom”扩展为“明确声明使用 ACP transcript”，接入 `parsers/acp_native`；同步 conversations/import/后端 exhaustive match，验证新建、重启、分页、取消和恢复后的历史不空白、不重复。
3. 前端 BuiltinAgentType、标签、图标、选项、设置/委派、i18n，以及 MCP/skills 对未支持能力的明确处理。
4. 自定义身份迁移：已经保存的 `custom:zcode-codeg` 不能突然改为 `zcode`。需要显式迁移或继续保留旧身份可读；不自动删除用户的旧 transcript。

内置补丁不应携带私有 RPC 翻译器、ZCode 安装器、凭据迁移、SQLite 表解析或远程 hub。适配器发布和 Codeg 内置发布独立进行。未经 Rust/前端测试和本机真实验收，不提交“已可用”的生产发布声明。

## 参考源

- https://docs.codeg.app/guide/custom-agents
- https://github.com/xintaofei/codeg/blob/541bdc91caa42d86780c6ab678f436b0d981f613/src-tauri/src/acp/custom_registry.rs
- https://github.com/xintaofei/codeg/blob/541bdc91caa42d86780c6ab678f436b0d981f613/src-tauri/src/models/agent.rs
- https://github.com/william0wang/zcode-acp/blob/v0.32.0/src/server.ts
