# 已验证范围

代码基线：`0525f10d0eb5f49d7f6fa39cdcf472b53e17c445`。

GitHub Actions：[Adapter contract，运行 34335193004](https://github.com/asteroida123/zcode-codeg-adapter/actions/runs/34335193004)，2026-09-09 完成，结论 **success**。后续文档提交不改变该基线的运行代码、测试或依赖锁。

| 环境 | 启动层测试 | 真实上游包测试 | 安装与打包检查 |
| --- | --- | --- | --- |
| Ubuntu / Node 22.16.0 | 31 通过 | initialize、未知方法、EOF、SIGTERM 通过 | 通过 |
| Ubuntu / Node 24 | 31 通过 | initialize、未知方法、EOF、SIGTERM 通过 | 通过 |
| macOS / Node 22 | 31 通过 | initialize、未知方法、EOF、SIGTERM 通过 | 通过 |
| Windows / Node 22 | 30 通过，1 项 POSIX 信号测试不适用而跳过 | initialize、未知方法、EOF 通过 | 通过 |

真实上游包为锁定的 `zcode-acp-server@0.32.0`，使用 `npm ci --ignore-scripts` 安装。打包检查确认发布文件集包含 `npm-shrinkwrap.json`。本地 Linux / Node 22.16.0 也通过语法检查与 31 项启动层测试；本地环境不能访问 npm，真实依赖验证由上述 GitHub Actions 执行。

第一轮 CI 暴露的 macOS `/var` 与 `/private/var` 路径别名断言已修正为比较 realpath。另补充了上游磁盘 remote.enabled 覆盖环境变量的启动拒绝与错误脱敏回归。

## 不在已验证范围内

CI 没有安装或登录真实 ZCode；没有发起模型请求，没有验证 Codeg UI、文件修改、真实权限拒绝、回合取消、会话恢复、MCP 委派或真实 ZCode 后端进程回收。`doctor` 只检查启动层。全局预安装后的 Codeg 接入配置仍需在真实用户机器上验证。

此项目没有修改 `xintaofei/codeg` 或用户的 Codeg fork，没有创建正式内置 ZCode 的 Codeg PR，也未发布到 npm。

手工端到端验收清单：[ACCEPTANCE.md](ACCEPTANCE.md)。
