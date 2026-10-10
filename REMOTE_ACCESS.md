# 受 token 保护的远程 Multivac

当前代码已实现，动态验收尚未完成：本次任务目录没有项目依赖，受控 Node 25.8.1 在测试开始前触发 GetOSInformation 原生断言。构建、类型检查、HTTP/浏览器/手机/模型及本机完整回归均没有通过证据。以下为实现对应的使用和验证步骤，不表示已在真实手机或公网部署验证。

## 访问与身份

外部访问默认关闭。本机原有 HTTP Host/Origin 规则与完整工作台保留。开启需 `MULTIVAC_REMOTE_ENABLED=1`、至少 32 字节非空 token、明确的 `MULTIVAC_REMOTE_ORIGIN`（仅 http/https 的 origin，不带路径、用户信息或查询）。远程监听地址由 `MULTIVAC_REMOTE_HOST` 指定，默认 `0.0.0.0`；本机关闭配置时继续监听 `127.0.0.1`。

本机身份必须同时满足真实 socket 对端为回环、Host 为原有本地主机名、Origin 符合原本本地规则，且不携带远程登录 cookie。远程 origin 不使用 localhost 或回环地址；localhost 保留本机完整入口。远程 cookie 始终保持远程身份，屏幕尺寸、windowId、转发头、客户端传来的会话 ID 都不能提升权限。反向代理必须固定上游 Host 为配置的远程 origin 的 Host，不允许客户端选择 localhost Host；不信任 X-Forwarded-For/Host/Proto。HTTPS origin 的 cookie 必须为 Secure，代理保持同源并关闭 SSE 缓冲。

登录只接受同源 JSON POST，token 在请求正文验证后换取随机 opaque HttpOnly、SameSite=Strict、Path=/ cookie；HTTPS 加 Secure。token 不进入 URL、cookie、日志或身份响应。认证状态保存在进程内，只存登录凭证摘要，固定 12 小时到期；重启使所有旧登录失效。基本限流按真实对端地址和全局总量共同控制，内存有界，错误登录不得无限耗时或创建登录。

关闭外部访问或轮换 token 使用配置变更后重启服务；关闭旧进程必须断开已有 SSE。统一访问服务同时提供配置更新的即时撤销机制，供同进程配置接入与测试：关闭、origin 或 token 变化清空登录并同步关闭远程连接。退出只撤销当前登录及其所有长连接，其他有效登录不受影响。失效后所有请求、重连及回放重新鉴权。

## 同源入口

构建后的 Web 页面从同一 HTTP 服务托管，资源根目录固定为构建目录，仅普通文件可读，拒绝符号链接、路径穿越与隐藏文件，不开放源码或工作目录。未登录只能访问公开登录页面依赖和登录/身份接口，API 默认拒绝。登录响应和包含数据的页面/API 使用 no-store。

身份接口 `GET /api/access` 返回 local 或 remote，远程仅返回是否登录和是否允许登录；本机不返回 token。`POST /api/access/login` 接受 `{token}`；`POST /api/access/logout` 撤销当前登录。远程写请求必须精确同源，读取带 Origin 时也必须精确匹配；页面导航和 img 无 Origin 时依旧执行 Host/cookie 检查。

## 远程服务端允许清单

所有未列出的 API 拒绝，包括工作区、书架、任务、运行、Inbox 总览、模型管理、偏好、项目、文件浏览、授权管理与 E2E 控制接口。允许清单以解析后的 path、方法、资源归属判定，不能用宽泛前缀代替。

| 方法 | 路径 | 边界 |
| --- | --- | --- |
| GET | `/api/assistant/session` | 全局历史与快照 |
| GET、PUT | `/api/assistant/page-state` | 全局草稿与阅读锚点；请求内引用不得借其他会话或文件读取 |
| POST | `/api/assistant/turns` | 固定 assistantSessionId=global-coordinator；不允许伪造其他面板上下文 |
| POST | `/api/assistant/turns/current/cancel` | 只停止当前全局对话 |
| GET | `/api/assistant/commands/:id` | 已有会话级命令服务校验 |
| GET | `/api/assistant/tools`、`/api/assistant/tools/:id` | 已有全局会话工具明细投影，无任意文件读取 |
| GET | `/api/assistant/model-selection` | 会话控制器发送门禁必需，只读全局会话选模状态；不开放模型管理或修改接口 |
| GET | `/api/events` | 只全局对话公共事件；无工作台事件、连接通知和窗口登记 |
| GET | `/api/assistant/events` | 按全局会话过滤的 JSON 补漏，与 SSE 采用同一会话范围 |
| GET | `/api/assistant/authorizations` | 全局对话请求 |
| POST | `/api/assistant/authorizations/:id/decision` | 服务端核对请求属于全局对话，原授权规则保持 |
| GET | `/api/assistant/confirmations`、`.../:id` | 当前全局对话的 Git 外发确认及结果，先按会话过滤再分页与计数，不开放 Inbox 总览 |
| POST | `/api/assistant/confirmations/:id/decision`、`.../:id/reconcile` | 先核对全局请求归属，再调用原外发批准/拒绝或只读对账；不能处理其他会话 |
| GET | `/api/assistant/proposals` | 全局对话提议及原有确认卡 |
| POST | `/api/assistant/proposals/:id/decision` | 服务端核对提议归属及原幂等、预览、状态、选项规则 |
| POST | `/api/sessions/global-coordinator/images` | 全局图片上传及原图片限额 |
| GET | `/api/sessions/global-coordinator/images/:hash`、`.../:hash/content` | 图片归属必须为全局对话 |
| DELETE | `/api/sessions/global-coordinator/images/:hash` | 原有草稿附件移除规则 |

路径 `/api/sessions/:id/*` 除上表全局图片之外均拒绝，即使客户端把 id 伪装为全局 ID 也不开放额外别名。路径、查询、正文中对象 ID 不得绕过归属校验。远程发送仅接受全局视图，不允许构造工作区、管理或书伴 currentView/contextRefs；消息引用只能来自全局对话，拒绝文件、书籍和其他会话引用。这个限制针对客户端直接提交的来源，不限制 Multivac 模型原有工具查询、执行或提议能力。

提议可能涉及项目、任务或外发，仍由原有工具创建和原授权确认流程执行；远程不会因此获得对象管理接口。需要全局列表查询才能填写的管理卡片选项不初始化范围外列表，保留已有默认值或允许取消；涉及来源未能核对的选项不能假装可用。

## 事件与失效

实时与持久回放只允许 assistantSessionId=global-coordinator。保留全局递增游标，不改写事件身份；扫描回放时用已扫描的游标推进，避免连续过滤事件导致循环或遗漏。JSON 补漏已经使用会话仓库过滤，继续在统一鉴权后执行。

远程不订阅 workbench 事件，不登记远程窗口为工作台导航目标，不发送 workbench.connected。前端对话内提议通过只读轮询刷新，避免依赖工作台事件。注销、到期、关闭或 token 变化同步关闭相应 SSE、清空待写队列并取消订阅。不能只在握手鉴权或只靠心跳终止连接。

## 远程浏览器入口

先读取 `/api/access`，再选择本机完整 Provider 树或远程精简树。远程登录后复用全局会话控制器与 AssistantView，只挂载对话、事件、提议及确认组件；不挂载工作区、任务、Inbox、授权管理或运行总览 Provider。不提供对象管理跳转和模型管理入口。

401、登录失效或事件流断连后重新核对身份；回到登录页前保留尚未发送的文字草稿，使用本设备 sessionStorage，不存 token。重登后恢复草稿，未知发送命令仍走原幂等对账，不能自动重发。小屏保留历史、图片、输入、发送、停止、确认和退出操作。

## 验证要求

分别验证配置默认值、无效配置、Host/Origin、错误 token、限流、cookie 属性、注销及多连接失效、过期、token 更新、访问关闭、默认拒绝路由、替换会话和资源 ID、实时/回放/重连一致、小屏流程及本机回归。验证必须注明运行环境、fake 与真实模型的区别；没有浏览器证据不得声称手机端到端已通过。

## 构建与本机使用

在具备项目依赖和常规开发执行能力的环境中，使用 Node 22.19 或更高版本，运行 `npm ci`、`npm run build`，再 `npm start`。构建目录 `apps/web/dist` 由服务固定托管，不能用 URL 读取源文件或会话工作目录。保持外部配置未设置，服务继续监听 `127.0.0.1:4317`，本机可以打开完整工作台。

本项目不自动读取 `.env`；需要将配置导入启动服务的环境，或使用 Node 的 `--env-file` 启动方式。凭证文件应留在仓库外并仅允许本机用户读取，不提交真实 token。开发热更新入口 `5173` 不作为远程入口。

## 显式开启与访问

先在本机完成模型配置。用密码管理器生成至少 32 字节的高熵 token，再将它作为 `MULTIVAC_REMOTE_TOKEN` 传给服务。不要把 token 拼进地址、命令行参数或日志。下面的 Bash 示例用隐藏输入，地址替换为实际本机局域网 IP：

```bash
export MULTIVAC_REMOTE_ENABLED=1
export MULTIVAC_REMOTE_HOST=0.0.0.0
export MULTIVAC_REMOTE_ORIGIN=http://192.168.1.10:4317
read -r -s -p '访问 token: ' MULTIVAC_REMOTE_TOKEN
export MULTIVAC_REMOTE_TOKEN
npm start
```

手机与本机处在可直接访问的网络，打开准确的 origin 首页，输入 token 登录。远程仅提供全局历史、消息、流式回复、停止、图片和当前对话必要确认；没有工作区、书架、任务、Inbox 总览、管理设置及对象跳转。退出入口位于顶栏。未发送的文字草稿保存在当前标签页 sessionStorage，失效重登后恢复；清理浏览器存储或关闭标签页可能移除该本设备备份。图片和未知发送继续沿用原控制器恢复与对账规则，不自动重发消息。

HTTP 局域网传输没有加密；需要传输保护时使用已有 HTTPS 反向代理。应用不自动配置域名、证书、穿透或多用户账号。HTTP 页面没有 `crypto.randomUUID` 时使用 `getRandomValues` 生成命令 ID，不因为缺少该接口阻断发送或停止。

## 关闭、轮换与退出

- 退出：点击当前浏览器“退出登录”，服务撤销该 cookie 对应登录及其全部 SSE；其他有效登录保留。
- 关闭外部访问：在本机正常停止旧服务（例如前台 Ctrl+C），设置 `MULTIVAC_REMOTE_ENABLED=0` 或移除启用项，再启动。新的服务回到回环监听。旧进程停止时释放 SSE，重启不恢复旧 cookie。
- 轮换 token：在本机停止旧服务，替换启动环境中的 token，再重新启动。旧 token 不可登录，旧 cookie 不在新进程登录表中，需要重新登录；所有旧长连接随旧进程结束。
- 登录最长 12 小时，到期撤销登录并关闭已有连接，使用 token 重新登录。服务端统一 `configure` 方法还支持同进程 token/origin/启用状态变更时立即撤销；当前产品配置入口采用本机环境变更和重启，不提供远程管理设置或持久化热更新 UI。

基本尝试限流：同一真实对端每分钟最多 10 次，进程总计每分钟最多 100 次；固定登录最多 256 个。无效请求和成功尝试都计数，429 带 Retry-After。经代理的客户端共用代理对端的限流桶，忽略客户端伪造的转发 IP。

## 已有 HTTPS 代理

若已有配置好证书与域名的代理，示例 origin 为 `https://multivac.example.com`，本机服务可显式启用并将 `MULTIVAC_REMOTE_HOST=127.0.0.1`，仅让代理转发到本机 `4317`。以下只是已有 Nginx TLS server 内的 location 片段：

```nginx
location / {
    proxy_pass http://127.0.0.1:4317;
    proxy_http_version 1.1;
    proxy_set_header Host multivac.example.com;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

上游 Host 必须固定为配置 origin 的 Host，不能使用客户端任意 Host 或 localhost；保留客户端 Origin，不把跨源 Origin 伪装为同源。全部页面、API、图片和 `/api/events` 都走同一 origin。HTTPS cookie 自动带 Secure，代理需关闭 SSE 缓冲与缓存，并保留长连接。代理及防火墙按已有部署管理，不由应用自动调整。

## 待补齐的验证

已编写以下测试，当前任务环境没有执行成功：

- `scripts/validate-remote-access.mjs`：单 Node 进程、无网络/子进程，验证登录状态、cookie、限流、撤销、路径/正文、SSE、本机流及构建资源。SSE literal 读取真实契约源码，WindowId Check 使用明确替身，不代替完整共享 schema 集成。成功执行后将产生 `artifacts/remote-native-validation.json`；本次崩溃未生成该文件。
- `apps/server/tests/remote-access-http.test.ts`：真实 Node HTTP、Fake 应用、SQLite，验证未登录、登录、越界、正文 ID、实时/回放/JSON 补漏、退出多连接、token 更新、关闭及本机接口/流。
- `apps/server/tests/remote-confirmations.test.ts`：验证当前对话外发请求先过滤再分页、计数与跨会话请求拒绝，不执行 Git 外发。
- `apps/web/tests/command-id.test.ts`：无 randomUUID 的命令 ID 回退。
- `tests/e2e/remote-access.spec.ts`：390px 浏览器入口、错误 token、历史、发送/流式/停止/退出、失效草稿、必要目录授权及无范围外初始化；身份接口使用浏览器替身，不宣称真实 LAN、HTTPS cookie 或服务端鉴权已通过。

恢复具备依赖的开发验证环境后，依次运行 `npm run check`、`npm run build`、上述服务与前端测试、`npm run test:e2e -- tests/e2e/remote-access.spec.ts`，并回归已有 `app-shell`、`global-event-stream`、`tool-authorization-card`、`proposal-cards`、`images`、工作区、读书、任务和 Inbox 测试。最后用实际手机、真实模型和部署网络完成全流程，记录浏览器版本、viewport、代理、Node、提交与测试输出。动态验收完成前不能声称本机无回归或远程隔离已验证。

