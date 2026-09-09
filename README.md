# zcode-codeg-adapter

面向 Codeg 的最小 ZCode ACP 启动适配层。

维护边界：固定复用 `william0wang/zcode-acp` 的 `zcode-acp-server@0.32.0`，仅维护 stdio 启动入口、版本校验、Codeg 配置和兼容性测试。不复制协议翻译器，不实现 ZCode 登录，不读取私有会话数据库，不增加 TUI、HTTP 或 WebSocket 服务。

第一阶段通过 Codeg 已有的自定义 ACP 注册机制接入（`custom:zcode-codeg`），由 Codeg 记录标准 ACP 历史。此仓库不是 Codeg 的编译级内置补丁；不会声称已合入 `xintaofei/codeg`。

实现与测试文件将与完整使用文档一起提交到本仓库。
