# 仅在本机查看未知会话错误

适用于会话探测已经报告 `E_REMOTE`、`rpcMethod: session/create`，但 `remoteHints: []`
的情况。这个组合不能证明未登录或缺少模型；偏好反向请求被处理，也不证明后端
认可了所有设置。版本通过并不保证会话创建通过。

## 这次修改与边界

`diagnosticRevision: 3` 补上字符串形式 `data.details` / `cause` 等错误包装的分类；
默认报告依旧只有白名单分类，不返回文本。不添加猜测的自动修复、认证注入或重试。

新增 `--local-error` 是**另一个明确授权的隐私边界**，不是安全脱敏开关。它只允许
`--live --scenario session`，不能与模型或文件测试授权一起使用。仅保存第一个已知
会话 RPC 错误的有限说明文字；没有远端错误时不创建文件。

```sh
node scripts/probe-zcode.mjs --live --zcode "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" --scenario session --local-error
```

原有运行时、版本、权限和临时工作区规则不变；不发送模型提示。ZCode 自身仍可能
初始化网络/MCP、写入原生会话状态，临时 cwd 不是沙箱。本工具不读取或复制 ZCode
配置、凭据，也不改变模型、模式或原生请求参数。

## 文件在哪里、怎么查看

原始错误的 `message` 和有限的 `cause/error/data/detail/details/issues` 文本保存在系统
临时目录下新建的 `zcode-probe-private-*/session-error.json` 中，不在代码仓库或报告里。
POSIX（包括 macOS）目录权限 0700、文件权限 0600，以独占创建方式写入，不覆盖文件；
Windows 访问隔离取决于用户临时目录的 ACL，不能把 POSIX mode 当成 Windows ACL。
设置到本仓库内的 TMPDIR 会被拒绝用于保存本机错误。

stdout 仍是可分析的 JSON。开启本选项时 stderr 会给出本机文件路径；macOS 还会给出
一条已引用路径的 `open -t ...` 命令。**复制这条命令在本机文本编辑器查看即可，不会
自动打开应用。不要使用 cat 把整个文件粘贴回聊天，也不要提交 Git 或上传该文件。**

文件内的 `messages[].text` **可能包含 API key、token、地址或路径**，即使本工具不直接
读取认证文件。这里只截取错误文字，不是通用脱敏器；单独的 stack、原生日志、请求
参数和其他任意字段不收集，但不能保证 message 本身不含这些内容。最多检查 32 个
节点、三层嵌套、保存 8 条文字，每条最多 2048 字符；不是完整的错误转储。

先自行检查文字，只反馈去掉敏感值的一小段错误描述。错误若只剩 `Internal error`，
如实说明没有更深层内容即可。排查后手动删除该本机文件和它所在的新建临时目录；
不自动上传，也不保证系统临时目录何时自行清理。

`localErrorCapture` 只包含 enabled/attempted/saved/failed 布尔值，不含文件路径或错误
原文。写入失败不会将原来的后端失败改成别的根因或成功；以 saved/failed 判断是否
真的保存。程序化调用也必须显式指定 localError，不能绕过范围检查。

## 验证证据

新增测试使用合成错误和假子进程，不是本机故障的复现。覆盖嵌套字符串分类、采集
上限、默认不保存、成功不保存、限定场景、文件权限、只保存第一条、晚到响应过滤、
命令行输出不含原始错误，以及文件落入仓库的拒绝。定向 mutation 同时验证默认关闭
采集和 details 分类的测试确实能抓到反向修改。

参考差异：`william0wang/zcode-acp` 的 `src/backend/credentials.ts`（来源提交
`dbb0addf60f8c69441dea575770c938aba10b441`）会读取桌面配置并注入后端环境，而本探测
不会。这个差异值得核验，但不是将当前错误判定为认证/模型故障的证据。
