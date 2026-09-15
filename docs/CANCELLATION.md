# 取消的真实语义（CLI 0.16.5 实证）

三次授权真实运行（2026-09-15 本机，`--scenario cancel`，诊断字段
`cancelProgress`）一致表明：

## 事实

1. `session/stop` 处理器存在且应答正常（请求式与通知式都完成，`hadActivePrompt`
   日志在处理器内部）。
2. 但它对 in-flight `session/send` 回合**没有任何效果**：stop 后 75 秒内
   `session/read` 持续 `projection.status != "idle"`，期间没有到达任何终止类
   事件（未知事件类型仅有 `session.updated`、`session.titleUpdated`）。
3. 方法面没有替代通道：`session/cancelBackgroundTask` 不适用前台 send
   （send 响应无 taskId），`workspace/cancelGenerateText` 是 workspace 级。
4. 包内证据：stop 处理器依赖 `activeAbortController?.abort(...)`，abort 后的
   取消终止事件机制存在（`resultType:"cancelled"` 发射点），但本构建中该链路
   对 send 发起的回合不生效。

结论：**协议级取消在该构建上是坏的**。TASKBOOK 引用的参考项目报告（部分构建
stop 不起作用）在本机得到复现。

## 对适配器（T4）的契约

- `session/cancel`（ACP）→ 发送 `session/stop` 请求（带 ack 记录）→ 有界等待
  关联终止事件（`cancelled` 判定只来自 correlated terminal）→ 超时即
  `E_CANCEL_UNCONFIRMED` 并毒化传输，进程回收由 close() 兜底。
- 向 ACP 客户端上报的取消结果必须区分三态：`cancelled`（终止事件证实）、
  `unconfirmed`（stop 无效，进程已回收）、`failed`。不伪造 `cancelled`。
- 取消后的会话续聊依赖跨进程 resume；该路径目前被运行时定义供给缺口阻塞
  （见 RESTORE-READINESS.md），T4 配置来源落地后一并解除。

## 已验证不受影响的部分

- 待审批权限的取消语义在探测端以显式 deny 结算（`flushPermissions`），不会
  悬挂反向请求，也绝不默认允许；合成回归覆盖（`permissionMode: 'hold'`）。
- 取消后的下一回合、重复取消幂等、关闭期间结算、后端崩溃中拒绝：合成套件
  全覆盖（backend-contract.test.js）。
