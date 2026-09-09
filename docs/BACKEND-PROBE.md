# ZCode 后端契约验证分支

本阶段不是新的 ACP 服务端，也不替换 `bin/zcode-codeg.js`。目标是先拿到可复现的
后端证据，而不是继续封装上游 `main()`，或提前把另一仓库整套搬进来。

## 不需要先装依赖的离线验证

在本仓库检出后，用 Node 22.16+（22 系列）或 24：

```sh
node scripts/check-backend.mjs
node --test test/backend-contract.test.js test/probe.test.js
node scripts/check-backend-mutations.mjs
node scripts/probe-zcode.mjs
```

最后一条默认执行 `--mock --scenario all`，运行创建/订阅/读取、流式回合、拒绝写入、
取消、重启进程后恢复等场景。它不需要 npm 安装、ZCode、账号、模型额度或网络。
报告标记 `evidence: synthetic` 和 `productionReady: false`。假后端不会继承 provider
凭据或用户 HOME；仅在本次临时目录内保存合成会话。**不是采集到的真实协议 fixture。**

`npm run test:backend` 和 `npm run probe:backend` 是相同命令的快捷方式。
`npm test` 同时跑旧启动层与新增测试；真实上游包测试仍是独立 `test:upstream`。

## 真实机器按阶梯运行，不需要自行比较多个仓库

当前只有一条候选实现：`app-server-cli-0.16.5-candidate`。
只调用用户明确指定的本地 `.cjs` 文件，不查找/安装软件，不调用其他 ACP 桥，不改写
ZCode 配置，不复制或解密凭据。需要官方 CLI 自己能够在该系统用户下使用原生认证。
桌面登录是否足以供 app-server 使用，本来就是待验证项；失败不能用导出用户秘密来绕过。

**首次只检查版本，不启动 app-server，也不发送模型提示：**

```sh
node scripts/probe-zcode.mjs --live --zcode "/absolute/path/to/zcode.cjs"
```

Windows 示例参数形态为 `--zcode "C:\实际安装目录\resources\glm\zcode.cjs"`。
执行脚本的 `node` 同时用于执行 `.cjs`；不另选 Electron/Bun。也可设置 `ZCODE_BIN`
为同一个绝对路径。当前期望 CLI `0.16.5`；别的版本输出 `E_VERSION_MISMATCH`，
不会盲目调用 app-server。这个版本来自参考项目的观察记录，**不是我们已完成真实验收**。
CLI 版本相同也不证明桌面构建、协议语义完全相同。

**再验证会话面，不主动调用模型：**

```sh
node scripts/probe-zcode.mjs --live --zcode "/absolute/path/to/zcode.cjs" --scenario session
```

这会启动后端、创建原生测试会话、订阅事件、读取状态与消息。ZCode 自身可能初始化
网络/MCP、写入其原生状态；不能把“未发送 prompt”理解为整个进程绝无网络或写入。
原生会话记录可能留在 ZCode 数据目录，本探测不编辑/删除该私有存储。

**模型场景需显式授权，逐个执行：**

```sh
# 一次真实提示：接收流式事件并在助手历史中核对随机测试 token。
node scripts/probe-zcode.mjs --live --zcode "/absolute/path/to/zcode.cjs" --allow-model --scenario smoke
# 两次真实提示：终止旧进程，用原 ID 恢复，再要求回忆前一轮 token。
node scripts/probe-zcode.mjs --live --zcode "/absolute/path/to/zcode.cjs" --allow-model --scenario resume
# 第一条流式事件后发送停止；必须等待后端终止证据。
node scripts/probe-zcode.mjs --live --zcode "/absolute/path/to/zcode.cjs" --allow-model --scenario cancel
```

`--allow-model` 表示这次运行允许使用当前 ZCode 账户的模型额度。没有此选项，脚本在
启动任何后端前拒绝模型场景。真实模式没有“一键 all”，避免一次意外运行多项付费检查。

**拒绝写入需要额外授权一次临时文件测试：**

```sh
node scripts/probe-zcode.mjs --live --zcode "/absolute/path/to/zcode.cjs" --allow-model --allow-file-test --scenario deny
```

这一个场景以 build 模式请求仅尝试一次写 `deny-sentinel.txt`，其他模型场景用 plan。
所有反向权限请求一律拒绝；验证必须同时看到拒绝请求、且临时文件确实没有产生。
模型根本没请求权限时是 `inconclusive`，不是绿色通过；后端无视拒绝仍写文件则失败。

**临时 cwd 不是操作系统沙箱。**原生工具可能无需询问就运行，后端也继承用户的
原生配置与权限；不能保证模型/原生插件绝不访问工作区外。对隔离有要求时使用
专门的系统账号或隔离环境。没有自动放行、yolo、向普通项目运行或自定义 prompt/cwd
的命令行入口。本工具不会将凭据放入测试报告。

## 报告与退出码

stdout 只输出一个 JSON 摘要。`--out /absolute/path/new-report.json` 可另存该摘要；
文件以 `wx` 独占创建，POSIX 权限 0600，不覆盖已有文件，也不上传任何内容。
不要把 live 报告或任何原始日志提交到 Git。

报告仅包含固定字段：候选 profile、CLI 版本、合成/真实标记、场景结果、计数、
固定错误码、可用时的整数后端错误码以及清理结果。不保留原生 session ID、路径、
环境变量、对话文本、工具输入输出或原始 stderr；未知事件只计数，不输出名称/内容。
这是一份诊断摘要，**不是可重放的真实事件采样包，也不是兼容性认证**。

| 退出码 | 含义 |
| --- | --- |
| 0 | 仅所选检查通过；`inspect` 通过只代表版本检查 |
| 1 | 所选检查失败，或清理失败/运行被中断 |
| 2 | 参数/显式授权不满足，或报告无法安全创建 |
| 3 | 没有足够证据，例如没有触发审批，或停止后自然结束 |

主要错误：`E_REMOTE` 保留整数 RPC code，但不猜测所有后端错误都是认证失败；
`E_SCHEMA`/`E_FRAME` 为结构不符合候选契约；`E_TURN_TIMEOUT` 为回合未结束；
`E_CANCEL_UNCONFIRMED` 为发送停止后未在期限内观察到终止；`E_HISTORY` 为恢复内容
或后续上下文验证不符；`E_INTERACTION_UNSUPPORTED` 为遇到当前探测未处理的反向交互。
未知交互返回错误，不构造成功响应。当前工具不实现浏览器、官方 MCP 认证头或用户问答。

## 窄接口与不变量

```text
scripts/probe-zcode.mjs（授权、临时目录、摘要）
    → AppServerBackend（open / prompt / inspect / cancel / close）
        → PrivateRpc（NDJSON、双向请求、期限、清理）
            → 用户明确指定的 ZCode app-server
```

代码放在 `spikes/backend-contract/`，不进入当前 npm `files` 发布清单。
不新增运行依赖，不修改生产启动器。`package.json` 只增加开发脚本。

- 反向 request 与本端 pending request 的 ID 分开处理，即使 ID 数字相同。
- `session/send` 的 accepted 与回合终止事件必须都到达，才结算成功。
- 同一会话只有一个 active prompt；不同会话分别绑定状态。
- 在发送提示之前完成事件订阅，过滤重放边界、重复序号与可辨识的旧回合事件。
- 超时/发送结果不确定时关闭该后端，不自动重发可能已经执行过工具的提示。
- 恢复必须返回原生同一个 ID；不得以“新建一条空会话”掩盖恢复失败。
- 权限永远拒绝；未知交互永不假装成功。这里没有正式 ACP 的权限 UI。
- 字节帧、pending 数量、反向 ID 数量有上限；错误文本不会写入报告。
- EOF/SIGINT/SIGTERM 下有期限清理；POSIX 使用进程组，Windows 使用 taskkill/直接终止。
  不承诺宿主 SIGKILL、OOM、主动脱离进程组的孙进程或所有原生子进程完全回收。

## 参考事实与假设分开

所有新增实现独立编写；下面是行为研究来源，不是整个源码的复制清单。

1. william0wang/zcode-acp，固定提交 `dbb0addf60f8c69441dea575770c938aba10b441`：
   [PROTOCOL](https://github.com/william0wang/zcode-acp/blob/dbb0addf60f8c69441dea575770c938aba10b441/docs/PROTOCOL.md)、
   [backend/types](https://github.com/william0wang/zcode-acp/blob/dbb0addf60f8c69441dea575770c938aba10b441/src/backend/types.ts)、
   [backend/client](https://github.com/william0wang/zcode-acp/blob/dbb0addf60f8c69441dea575770c938aba10b441/src/backend/client.ts)。
   依据：私有帧没有 jsonrpc、create/resume/send/read/messages/subscribe 形态、
   runtime preferences 三个布尔值、permission 的 deny 响应。
2. tizerluo/zcode-open-bridge 的
   [0.16.5 复测记录](https://github.com/tizerluo/zcode-open-bridge/blob/main/docs/recheck-0.16.5.md)
   （本文审查日 2026-09-09）：交叉参考 native API、事件与反向请求；没有将作者的
   实测转述为本仓库的实测。
3. supermomonga/zcode-acp 与 xintaofei/deepseek-acp：借鉴窄接口、状态区分和负面测试思路，
   不引入 desktop host 路径或 DSH 运行依赖。

**特别保留的取消实验：**本候选只测 `session/stop`，没有静默增加 v4 停止补丁。
william0wang 的同一提交记录过该调用被部分后端忽略，需要 `v4/command` 的情况。
因此，真实 `cancel` 很可能揭示这个缺口：超时就是失败，停止后自然完成就是不充分证据。
它不表示“ZCode 无法取消”，而是本候选调用面尚不满足取消验收。后续应单独核对 v4
停止请求与终止事件的语义，再用新测试推进，不把传输关闭当成成功取消。

`seq`、`payload.turnId`、取消 `resultType`、messages 中 assistant/text 形态是本候选
依赖的观察面；缺字段/不识别状态须复核，不能据合成测试宣布兼容。正式 ACP 能力声明、
差异显示、文件读取、用户问答、Codeg MCP、更多操作系统实测均未完成。

## 通过标准与下一阶段

当前提交的门槛：离线测试＋三项定向 mutation 反向对照＋原启动层回归。CI 不装真实
ZCode、不调用模型。真实机器先运行 inspect/session/smoke，报告暴露的缺口由项目侧修复；
再补权限、取消、恢复证据。选定后端接入面后，才把合适模块迁入正式适配核心，并单独
提交 Codeg 的内置集成 PR。不要把本验证分支的绿色测试误当成正式内置已经交付。
