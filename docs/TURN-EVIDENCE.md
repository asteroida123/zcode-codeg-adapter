# 回答成立，不等于原生回合身份已验证

本页对应增量字段 `turnEvidenceRevision: 1`；现有 `schemaVersion: 1` 和
`diagnosticRevision: 3` 不变。不修改原生请求、配置、认证、权限或取消策略。

## 本次真实反馈说明了什么

用户提供的 macOS arm64 / Node 22 / CLI 0.16.5 运行摘要显示：会话检查通过；
smoke 收到 8 条流式事件、一个终止事件，但 `turnIdObserved` 和
`terminalIdMatched` 均为 false，场景结果为 inconclusive。

旧版代码在写出该 smoke 结果前已经检查过助手历史包含本次随机标记，否则会报
`E_MODEL_EXPECTATION`。因此能确认这次基本回答链路成立；不能确认终止事件通过
原生回合 ID 与当前请求匹配。此前 CLI 模型配置错误没有在这两次反馈中重现。
这些结论来自用户提供的运行反馈，不冒充维护环境自行完成的真实 E2E。

当前实现只用 `payload.turnId` 做身份匹配；它缺失不能证明事件其他位置没有 ID。
不生成一个本地 ID 冒充原生 ID，不把 `foregroundExecutionId` 直接当成 `turnId`，
也不把“收到任意终止事件”升级成严格关联成功。所有场景原有通过判定保持不变。

## 增量证据

smoke 的 observed 新增：

- `responseMarkerMatched`：已读取的助手历史包含本次随机标记。
- `stateIdleAfterTurn`：已读取的 projection.status 是否为 idle。
- `turnCorrelation`：只有原条件满足才是 matched-payload-turn-id，否则 unverified。
- `identityEvidence`：处理到的 start 数量，以及第一个 start / 终止事件中三个固定
  位置的字段形态：envelopeTurnId、payloadTurnId、foregroundExecutionId。

每个形态只可能是 absent、string 或 invalid。string 只表示有界非空字符串，
**不表示两个值相等、也不证明该位置属于稳定协议**。不输出 ID、长度、哈希、
输入文本、工具内容、配置或任意原生字段名。

resume 的 observed 保留 historyRetained、secondTurnRetainedContext，同时增加
firstTurn / continuedTurn 的上述证据。第二次请求不会再次提供第一轮随机标记。
这使一次恢复验证同时检查历史、后端上下文及两轮事件形态，不必再单独重复 smoke。

即使 responseMarkerMatched 和 stateIdleAfterTurn 都为 true，只要原生回合关联
不成立，整体仍为 inconclusive，productionReady 仍为 false。没有削弱断言换绿灯。
临时单会话中的回答正确也不能直接推广成并发、后台回合和取消竞争都正确。

unknownNotifications / unknownEvents 是尚未消费的通知/事件计数，不是后端错误次数。
本补丁没有解析或分类这些内容；只有计数无法断言它们全部是遥测或可安全忽略。

## 下一次本机验证

更新验证分支后直接做恢复验证，不再运行 setup，也不必重新跑单独 smoke：

```sh
node scripts/probe-zcode.mjs --live --zcode "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" --allow-model --scenario resume
```

会发送两次模型提示，可能消耗所选账户额度。使用新的临时工作区和测试会话；
仍不是 OS 沙箱，原生配置、工具/MCP 的初始化副作用不变。不要加 --local-error，
不要上传原生日志或配置；只需提供 JSON 摘要。如果再次 inconclusive，分别查看
historyRetained、secondTurnRetainedContext 和两轮 identityEvidence。

后续若要支持没有 payload.turnId 的构建，必须先证实替代关联规则，再用迟到终止、
后台回合、重复事件、订阅积压、并发和取消竞争等回归验证它。此次没有启用猜测回退。

## 参考与测试边界

- william0wang/zcode-acp，提交 f26a72ca6eeb0cb42d414b17a590021302385da9 的
  src/translators/event-translator.ts 明确考虑无 turnId 后端，并解释内部回合导致的
  错误提前完成。这是参考实现的观察，不证明本机具体采用哪种事件布局。
- tizerluo/zcode-open-bridge 的 docs/recheck-0.16.5.md 记录的终止 payload 字段清单
  不包含 turnId。不能据此推广到所有 CLI 0.16.5 桌面构建。
- test/turn-evidence.test.js 使用独立合成子进程，覆盖无 ID、payload ID、顶层 ID、
  execution ID、报告边界、两轮恢复证据。合成字段不是捕获的真实事件样本。

参考源码仅用于理解协议边界，本补丁没有复制参考项目的实现。
