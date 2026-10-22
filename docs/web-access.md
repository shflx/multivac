# 网页搜索与读取

Multivac 通过两个独立内部工具提供网页能力：

- `web_search`：输入简短查询，返回标题、URL、摘要和可用的发布日期。默认 5 条，最多 10 条。
- `web_fetch`：输入明确的 URL，返回网页标题和 Markdown 正文。无需先搜索，不支持登录、浏览器点击或表单操作。

## 启用 DeepSeek

在当前实例的服务端启动环境中配置，然后重启服务：

```sh
export MULTIVAC_WEB_PROVIDER=deepseek
export MULTIVAC_WEB_API_KEY='<DeepSeek API Key>'
npm run dev
```

生产使用相应实例的启动命令。不要将真实密钥提交到仓库。配置不依赖会话所选模型，不自动读取 `DEEPSEEK_API_KEY` 或 Pi 中的模型认证。首版未提供设置页面；省略 `MULTIVAC_WEB_PROVIDER` 时关闭能力，不向模型声明这两个工具。未知服务商或已启用但缺少密钥会在启动时明确报错。

启用后，全局 Multivac、工作会话和后台任务可使用这两个工具。书伴及笔记讨论不增加网页工具。查询或 URL 会发送给配置的服务商，网页内容会进入模型上下文；不要在参数中包含秘密。

## 读取边界

- 本机只请求固定的 DeepSeek HTTPS API，禁止跟随 API 重定向。目标网页由 DeepSeek 获取，本机不直接访问目标 URL。
- Fetch 只接受无用户名和密码的 HTTP/HTTPS 公网域名及标准端口；拒绝 IP 字面量、localhost 和常见内部域名。域名实际解析、目标访问及目标重定向由服务商控制，本机校验不保证目标可用，也不保证阻止服务商侧所有私网解析。
- 每次请求最长 30 秒，响应最多 512 KiB。后台任务还受剩余时间和输出预算限制，记录调用租约及实际读取字节，取消和服务关闭会中止请求，收敛后释放租约。
- Fetch 最多交付 24000 个 UTF-16 码元正文，搜索每条摘要最多 2000，标题最多 300。截断明确返回 `truncated: true`；不会拆开代理对。响应本身超过读取上限时明确失败。
- 网页内容是不可信数据，不能改变工具权限。工具公开事件只保留摘要；远端错误正文、认证头和底层错误不进入公开结果。不自动重试收费请求。

## 服务商抽象

`modules/web/web-provider.ts` 定义独立的 `WebSearchProvider`、`WebFetchProvider` 和组合的 `WebProvider`。服务商负责 API 参数映射、响应校验及规范化；`WebAccessService` 负责公共输入、输出限额、取消及任务租约；`web-tools.ts` 负责模型工具声明和公开回执。

后续增加服务商时，实现相同端口，在服务端配置工厂中显式选择即可，不必更改工具名称、调用方或前端展示。网络适配器必须遵守信号和读取上限，并通过 `received` 回报实际读取字节。首版不引入自动路由、降级或多供应商并发。

DeepSeek 搜索使用 `/v1/tools/search`，查询最多 128 个 Unicode 字符，`need_content: false`，避免搜索直接附带大量全文。指定 URL 的正文由 `/v1/tools/fetch` 获取。API 规范参考 [DeepSeek Search & Fetch](https://api-docs.deepseek.com/guides/search/)。
