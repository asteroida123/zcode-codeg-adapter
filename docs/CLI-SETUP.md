# 一次性配置 ZCode CLI（与适配器运行时分离）

适用于真实后端在 `session/create` 返回以下错误的情况：

> Model config is missing. Create <home>/.zcode/cli/config.json with an explicit model provider before running ZCode.

这证明当前阻塞点是 **CLI 没有可用的显式模型配置**，不证明文件一定不存在、账号未登录或密钥失效。仅有 CLI 版本检查通过不能证明配置和认证可用。错误分类器已补充这句原生错误的回归测试，仍不把所有 `-32603` 都归类为配置错误。

## 与现有探测的边界不同，需显式确认

`node scripts/setup-zcode-cli.mjs` 默认只读检查，不写文件。

`node scripts/setup-zcode-cli.mjs --apply` 是**一次性本机配置工具**，不是探测工具自动修复：

1. 读取本机 `~/.zcode/v2/config.json` 和已有 `~/.zcode/cli/config.json`。桌面 provider 配置可能含 API key；本工具会在内存中接触这些配置，但不打印其值。
2. 在本机终端列出已启用 provider 的模型 ID，由用户输入编号。没有默认第一项，不硬编码 GLM 型号、provider ID 或服务地址。
3. 用户输入 `APPLY` 才写入：复制**一个选定的 provider 条目**，设置字符串形式的 `model.main = "provider-id/model-id"`。不复制桌面的 hooks、MCP、模式等其他顶层设置。
4. 目标不存在时以不覆盖方式创建；已有配置缺少模型引用时，保留其他字段、先以独占方式备份原字节，再替换目标文件。原桌面配置不修改。

**这是比原探测更宽的一次性授权：明确同意在同一台机器的两个原生配置文件之间复制 provider 数据，其中可能包含密钥。**`bin/zcode-codeg.js` 和 `scripts/probe-zcode.mjs` 均不调用这个工具；正常启动不会自动读取或同步桌面配置。

不读取 `credentials.json`，不解密、不刷新或申请令牌，不联网，不启动 ZCode，不调用模型。provider 没有内嵌 key 时保留其原生设置，不伪造 key；能否由 CLI 解析原生认证需要后续会话/模型检查。

## 操作

先退出 ZCode App 和其他 ZCode CLI，避免同时写原生配置。在验证分支目录执行：

```sh
node scripts/setup-zcode-cli.mjs --apply
```

选择希望用于 Codeg 的模型编号，再输入 `APPLY`。其他输入取消，退出码非零，不写配置。`--apply` 必须交互式运行，不能通过管道自动确认。

成功后运行原会话探测（不加 `--allow-model` 或 `--local-error`）：

```sh
node scripts/probe-zcode.mjs --live --zcode "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" --scenario session
```

配置写入成功**不是认证/会话通过**。这一步探测不发送 prompt，但原生后端仍可能初始化网络/MCP、写原生会话状态。只反馈其 JSON 摘要，不发送原生配置、备份或密钥。

## 保留与停止规则

- 不覆盖已有非空 `model.main`：那可能是引用无效、其他 schema 问题或独立认证问题，不能随意换模型。
- 不覆盖内容不同的同 ID CLI provider，不重置无效 JSON 或结构异常文件。
- 拒绝已有符号链接/非普通文件/落入本仓库的配置路径。
- 保存前重查来源和目标是否变化；两个本工具进程之间有独占锁。**这不是与 ZCode 的跨进程事务或原子 compare-and-swap**，因此执行前必须关闭 ZCode。它也不是针对恶意本机并发进程的安全隔离层。
- POSIX 下新文件/备份权限 0600，新建 CLI 目录 0700；Windows 仍依赖用户目录 ACL，不把 mode 视为 Windows 访问控制。
- 备份名 `~/.zcode/cli/config.json.before-codeg-<随机值>.bak`。备份可能含秘密，不能上传/提交。确认修复后由用户决定保留或删除；回滚应在关闭 ZCode 后在本机恢复备份，不通过聊天传递。
- 发现冲突、目录异常或不完整 provider 时直接退出，未进入模型探测。不要反复强行运行、导出密钥或删除配置绕过。

未找到可用桌面 provider 时，这条配置复用路径没有成立。应重新评估桌面 host 接入或原生配置流程，不能把适配器扩展成自动获取凭据的服务。

## 来源和验证

原生错误描述来自用户本机运行反馈，路径已泛化，不提交原始文件。

CLI 模型引用格式和桌面/CLI 配置差异的交叉参考：
- Q00/ouroboros 的 `docs/runtime-guides/zcode.md`（Model provider configuration），以及 issue #2148：https://github.com/Q00/ouroboros/issues/2148
- ZCode 官方 FAQ 的本地文件说明：https://zcode.z.ai/en/docs/qa

本工具为独立编写的配置引导，没有复制这些项目源码。测试使用合成 provider、临时 HOME 和假密钥，覆盖只读默认、显式确认、字段保留、备份、冲突、变化检测、路径规则和日志不回显秘密。不是用户的真实修复结果。

运行新增测试：`node --test test/cli-setup.test.js`。已接入主测试和语法检查；无新增 npm 依赖，不进入 CLI 包的 scripts 发布内容。
