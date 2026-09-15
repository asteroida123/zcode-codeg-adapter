# 恢复历史不等于恢复可推理状态

## 本机 CLI 0.16.5 包内证据（2026-09-15 本地只读检查）

对本机安装的 `zcode.cjs`（0.16.5，与 `EXPECTED_CLI` 一致）做只读字符串检查，
得到 `-32031` 的四个抛出点，其中与本阻塞直接相关的是：

- **恢复守卫**：cold resume 时若会话持久化/历史推导出的模型在当前可用模型目录
  中解析不到（内部原因标记 `runtime_model_unavailable`），会话对象会挂上
  `restoreWarning = { message: "历史任务使用的模型已不可用，请从当前模型列表中
  选择一个可用模型后继续", type: "ZCODE_RUNTIME_MODEL_UNAVAILABLE" }` 和一个
  deferred model adapter。`session/send` 在尝试重新应用会话 runtime 模型后若
  警告仍在，即抛 `-32031`，`details.code` 为警告类型。这正是用户报告的
  恢复后第二轮 send 返回 -32031 的原生机制。
- 另一处 `-32031`：`headersApplied` 为假时抛 "Provider runtime headers were
  not applied before model request attempt."（provider runtime 头未应用）。
  两者可用 `--local-error` 本机原文区分。

三个关键推论：警告文本本身就是原生给出的补救指引（请选择一个可用模型）；
应用会话模型 runtime 的路径会清空警告（`modelRuntime=r, restoreWarning=void 0`），
即 `session/setModel` 重选正是原生的解除通道；快照响应顶层带 `lastError`，
客户端可以在**不花费任何模型调用**的情况下在 send 前检测到被阻塞状态。

以上是包内静态证据，不是真实运行的根因证明：为何恢复进程中存储模型解析失败
（模型目录惰性加载、provider runtime 头、workspace 身份差异）仍需真实实验区分。

## 已实现的窄诊断（本轮）

- `inspect()` 现在返回 `restoreWarning`，仅取分类：`runtime-model-unavailable` /
  `unclassified` / `null`；原文与符号不进入报告。
- resume 场景在续聊 send 前记录 `resumeProgress.restoreWarningBeforeSend`
  （`resumeEvidenceRevision: 2`）。重选成功后应为 `null`；守卫仍在时保持分类值，
  不得视为已修复。
- `--local-error` 覆盖范围扩到 `session/resume` 与 `session/send`（仍然一次性、
  有界、仅本地 0600 文件、明确开启），并允许与 `--rebind-resume-model` 组合：
  若重选后仍 `-32031`，本机原文可区分恢复守卫与 provider runtime 头两种抛出点。
  `--local-error --scenario resume` 必须搭配 `--live --allow-model`；仍不得与
  `--allow-file-test` 或 session 场景的 `--allow-model` 组合。

## 本轮证据（历史）

用户反馈（macOS arm64 / Node 22 / CLI 0.16.5）中，第二个进程已完成
`session/resume`、`session/subscribe`、`session/read`、`session/messages`，
随后 `session/send` 返回 `-32031`。按当时探测控制流，第一轮回答标记及恢复后的
历史标记/消息计数检查已经通过；第二轮的上下文续接没有通过。
这些是用户本机反馈，不是本仓库 CI 的真实模型验收。本轮包内证据已将该错误码
关联到恢复守卫机制（见上），但重选是否在真实环境解除阻塞仍未验证。

参考 `zai-org/feedback#223` 将此错误码与 `ZCODE_RUNTIME_MODEL_UNAVAILABLE` 恢复警告
关联；本机包内证据支持该方向，但该报告来自较早的 Linux 构建，路径尾斜杠等
细节不能直接当作本机根因。另一个参考实现也将 `-32031` 用于无法补充 provider
runtime headers 的失败——本机包内确认该抛出点真实存在。

## 保留分阶段证据

所有 resume 探测增加 `resumeProgress`，包括 `firstTurn`、`firstProcessClosed`、
`nativeResumeAccepted`、`historyRetained`、`restoreWarningBeforeSend`、可用时的
`continuedTurn` 与 `secondTurnRetainedContext`。每一步完成后立即记录，后续失败
仍保留；`stage` 指向失败时所在阶段。没有进行的检查不伪装为通过。

已有 `terminalIdMatched` 与 pass/inconclusive 判定没有放宽。正确恢复历史、选模
成功、状态 idle 都不能单独证明第二轮实际回答成功，更不能证明原生回合 ID 关联
正确。

错误分类器只在发现明确的 `ZCODE_RUNTIME_MODEL_UNAVAILABLE` 符号或对应已知文字时
输出 `runtime-model-unavailable` 分类；仅有 `-32031` 仍保持未知。不输出原始错误。

## 显式的“原模型重新选择”实验

```sh
node scripts/probe-zcode.mjs --live --zcode "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" --allow-model --scenario resume --rebind-resume-model
```

这是一个**候选修复实验，不是已确认适用于真实 ZCode 的修复**。它通过原生
`session/setModel` 重新选择同一个模型，不伪造模型可用性，不清除原生 guard。
原生后端仍负责校验模型、provider 和认证。仅靠模型引用可能不足以重建 runtime；
此时错误保持失败，后续需要明确评审其他方案，而不是追加自动 fallback。
本机包内证据（警告文本、应用 runtime 清警告、快照 `lastError` 可读）支持该接缝，
但真实解除仍以 `secondTurnRetainedContext: true` 为准。

执行顺序（重选分支）：第一轮回答并读取快照 → 保留原生 provider/model 引用（仅内存）→
关闭进程并恢复同一会话 → 核对历史 → 核对原模型和 plan 模式、确认状态 idle →
调用一次 `session/setModel` → 读回核对模型/plan/idle/历史 → 记录
`restoreWarningBeforeSend` → 发送第二轮提示。

`session/setModel` 只携带 `sessionId`、`model: {providerId, modelId}`、
`persistAsWorkspaceLastUsed: false`；不附带 runtimeModel/provider 定义、密钥、环境
或其他参数。没有默认模型/第一项回退，不重新创建会话，不重发已失败的提示。
`--rebind-resume-model` 必须同时有 `--live --allow-model --scenario resume`，
不允许与文件测试组合；可与 `--local-error` 组合用于采集重选后仍失败的本机原文。
未提供该参数时仍走原始恢复路径。

模型引用仅从原生 `session/read` 的 `settings.model.current` 提取。原模型不完整、
恢复模型变化、非 idle、plan 模式变化或原生选模失败都会停止；未知字段布局不猜测。
工具不会读取桌面或 CLI 配置，不需要重跑 setup，不复制或导出凭据。

此操作会请求原生服务重新选择会话模型，可能更新其会话元数据；`false` 参数用于
请求不更新工作区最近使用模型，不是“原生服务绝无磁盘写入”的保证。
会发最多两次模型提示（不重试），可能消耗额度。临时目录不是系统沙箱；原生
网络/MCP/状态初始化副作用与原探测相同。

`modelRebind.verified` 只表示选模请求获得响应后读回同一模型、plan 与 idle，
不是实际推理已验证。只有 `secondTurnRetainedContext: true` 才证明本次第二轮
回忆测试通过；即使如此，没有原生回合 ID 匹配时整体仍为 inconclusive。
不输出模型/provider/session ID、提示、密钥或原生日志；只反馈 JSON 摘要。

## 验证与来源

`test/resume-readiness.test.js` 使用合成 guard 和真实子进程，覆盖默认不重选、显式
授权、原模型一致性、权限模式、忙状态、拒绝/假成功、历史损失、失败保留阶段证据、
无 ID 仍 inconclusive、错误分类和输出不泄漏。它不是真实 ZCode 的故障复现。

- 错误线索（用户提交的缺陷报告，非厂商兼容承诺）：https://github.com/zai-org/feedback/issues/223
- 原生选模参数参考（使用其中的 model ref + persist 标志，不复制 provider 构造代码）：
  https://github.com/william0wang/zcode-acp/blob/f26a72ca6eeb0cb42d414b17a590021302385da9/src/config/runtime-model.ts
- 另一种 -32031 使用场景：
  https://github.com/william0wang/zcode-acp/blob/f26a72ca6eeb0cb42d414b17a590021302385da9/src/handlers/server-requests.ts

此实验独立于正式启动器，不进入包的 scripts/spikes 分发内容，不修改 main 或 Codeg。
