# 一条上游版本线，不维护第二套协议

## 选择

复用 william0wang/zcode-acp 的 npm 包，当前审查版本 0.32.0，对应上游提交 dbb0addf60f8c69441dea575770c938aba10b441。不复制后端 RPC 和 translator；上游负责 ZCode 的协议变化。

备选 supermomonga/zcode-acp 采用桌面 host 路径，README 当前限定 ZCode 3.11.2 / CLI 0.16.5，并验证 host artifact/hash。该路线不是不能用，但会引入另一套安装与精确 host 兼容性契约。第一版不同时支持两个上游。

## 两个受测的耦合点

其一是依赖包的 package.json 主入口 `dist/index.js` 及其 `main()` 导出。这是当前上游已实现的模块入口，**不是上游承诺稳定的嵌入 API**。所以精确锁版本并做真实包 smoke，而不是依赖 latest 或 ^。若上游将来提供专用无副作用 server 导出，可用独立小变更切换；不能直接导入其 handlers/translator 私有路径。

其二是上游桥接配置的路径与 `remote.enabled` 字段：文件优先于环境变量，所以启用远程时直接拒绝启动，不改写配置、不读取 ZCode 登录存储。升级需回归这项优先级；这是启动检查，不提供对并发配置修改的安全隔离。

不额外 spawn 上游、不代理 stdout、不重写 sessionId/permission/options，不分叉一套 cancel/EOF 逻辑。这样只保留上游已有的进程生命周期。

## 升级清单

- 读 release diff，特别是 src/index.ts 的 main 导出和自动启动判断、runtime.ts、remote/config.ts、postinstall 和依赖变化。
- package.json 只改一个精确上游版本，更新 npm-shrinkwrap.json；不要手写 integrity/锁文件，不自动合并依赖机器人 PR。
- 在 Linux、Windows、macOS 安装时禁用 lifecycle scripts，跑 check、unit、真实 upstream smoke、npm pack。
- 检查 Node 兼容下限，生产使用带安全补丁的 Node 22/24；升级依赖的高风险变更需重新评审。
- 用真实 ZCode 与 Codeg 按 ACCEPTANCE.md 回归。单元测试和 initialize 成功不够。
- 固定发布版本/提交供 Codeg 使用，记录 Codeg commit、ZCode app/CLI 版本、Node/OS 与通过范围。
- 回滚时恢复上一适配器提交及锁文件；不能因此保证能回滚已被 ZCode 自己迁移的用户状态。

## 不做

TUI、hub、WebSocket、账号套餐查询、私有凭据处理、ZCode 自动安装、多上游/多版本矩阵、自己的工具执行器、自己的 transcript 数据库、自动授权。上游安装包仍包含它自己的额外模块；本配置只是不启动远程入口，不是依赖裁剪或代码沙箱。

资料：
- https://github.com/william0wang/zcode-acp/tree/v0.32.0
- https://github.com/supermomonga/zcode-acp
- https://nodejs.org/api/sqlite.html
