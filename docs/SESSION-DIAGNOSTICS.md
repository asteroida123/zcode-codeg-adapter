# 会话失败的诊断（diagnosticRevision: 2）

本说明补充 [后端探测指南](BACKEND-PROBE.md)，不改变探测授权和副作用边界。

旧报告只有 `E_REMOTE` / `rpcCode: -32603`，不能据此判定未登录、缺少模型或协议
不兼容，也不能区分创建、订阅、读状态和读历史哪一步失败。先更新验证分支，
重新执行原来的 `--scenario session`；不需要重新安装 npm 依赖或更改 ZCode 配置。

新增字段均为增量诊断；`schemaVersion` 仍为 1，`diagnosticRevision` 为 2：

- `runtime`：运行探测的 Node 版本、系统和架构，不含可执行文件路径。
- `checks[].error.rpcMethod`：真正失败的本地已知请求名，如 `session/create`、
  `session/subscribe`、`session/read` 或 `session/messages`；非白名单方法不输出。
- `remoteMessagePresent`：后端是否提供了可检查的错误消息；不会输出原文。
- `remoteHints`：只从有限错误字段和固定模式得到的分类线索。可能有多个或为空，
  不代表已定位根因；不能仅依据分类就自动改配置或处理凭据。
- `failureContext`：失败前收到成功响应的 RPC 列表、白名单内反向调用的名称/计数、
  未知反向调用的计数、协议帧/日志字节计数和交互计数。该快照不再发起任何后端调用。

`completedRpcMethods` 只表示请求收到非错误响应，不保证后续语义检查通过，也不是
可重放的完整时间线。它按方法去重，最多保存本候选固定的七个 RPC 名称。

分类固定为 `model-configuration`、`authentication`、`filesystem-access`、
`file-missing`、`runtime-dependency`、`state-store`、`request-schema`、`network`。
`remoteHints: []` 表示没有识别出线索；不要默认解释成认证问题。模式最多查看 32 个
错误节点、三层嵌套、每条消息前 2048 字符；不遍历任意载荷、不返回匹配的子串，
不保留错误文本、stack、cause 对象、原始日志、文件路径或凭据。

例如以下只是**合成**示例，不是已定位的本机故障：

```json
{
  "code": "E_REMOTE",
  "rpcCode": -32603,
  "rpcMethod": "session/create",
  "remoteMessagePresent": true,
  "remoteHints": ["model-configuration"]
}
```

白名单内的 `interaction/requestOfficialMcpAuthHeaders` 等反向调用仅被计数，本次
仍未实现其认证逻辑。不支持的交互照常拒绝；新增计数不能被解释为已认证成功。
这次只增加失败诊断，不修改原生请求参数、不读取/复制原生配置或凭据、不重试
`session/create`/`session/send`，不修改取消策略，也不把失败转成成功。

新增测试覆盖四个会话 RPC 的独立失败、未知错误、嵌套错误类别、凭据不泄漏、
有界消息检查、未知方法名抑制、并发失败方法隔离，以及失败前的未支持认证回调。
所有新增后端错误均由假进程生成；它们不构成真实 ZCode 的故障原因证明。
