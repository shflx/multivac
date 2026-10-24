# 执行停滞诊断日志

为排查任务或普通会话长时间没有进展，后端在内部数据目录下追加 `diagnostics/execution.jsonl`。`MULTIVAC_DATA_DIR` 决定数据根目录，未设置时为 `~/.multivac`。后端加载新版后，可在“设置 · 偏好 · 诊断”开启或关闭执行诊断。默认开启，沿用原行为；缺失或非法的历史存储值按默认值处理。开关保存在全局偏好中，所有会话与任务共享，修改立即生效，服务重启后保持。

关闭时记录一次关闭标记，然后停止采集、周期采样和事件循环监视、关闭日志文件并清理活动观测；保留已有文件，不影响任务或模型执行。新请求直接走原 SDK 调用，关闭期间不创建日志文件。开启时重新采样，完整模型阶段从新请求开始记录；不会补采已开始的请求，不接收旧观测的迟到事件，不把关闭时长误判为服务时间间隙。旧进程与已结束的历史请求无法补采这些信息。

诊断本身不修改模型超时、自动重试、任务预算、暂停、恢复或 Inbox 策略。日志不是业务状态或停止证明，不驱动调度。Responses 协议收尾修复独立于诊断开关，见下文。

## 关联与范围

每行是独立 JSON，含 `bootId`、UTC `at`、单调时钟读数 `monoMs` 和 `event`。模型请求含独立 `requestId`，并尽可能关联服务端的 `sessionId`、命令 `executionId`、`taskId`、`runId` 和会话 `kind`。任务树沿用实际父运行的身份，不创建新的执行。

普通工作、任务、全局和书伴的默认 Pi 运行时共用观测代理。创建和重新打开会话均接入；选模 activate/rollback 仍使用原运行时并保持原会话。Fake 或外部注入的协调器只留下应用命令与任务状态日志，不伪造模型网络数据。

## 模型阶段

| 事件 | 记录内容 |
| --- | --- |
| `model.request.started` | provider、modelId、api，以及该协议是否接入 HTTP fetch 观测 |
| `model.payload.ready` | 原 payload 回调执行完成的时间，不记录 payload |
| `model.http.started` | HTTP 尝试次数及 host，不记录 URL 路径、查询、用户信息、请求头或正文 |
| `model.http.headers` | HTTP 状态及白名单响应 ID，用于对照上游请求；不是完整响应头 |
| `model.http.first_body` | SDK 首次读到正文块的时间 |
| `model.first_event` / `model.first_output` | 首个 SDK 事件，以及首段文本、思考或工具参数输出的时间与类别 |
| `model.protocol.terminal` | Responses 解析器已处理有效终止事件；只记录终止类别及 `protocolTerminalAt`，不保存响应正文 |
| `model.http.body_ended` | 下游读取到正文 EOF；与协议完成、SDK 终结分开 |
| `model.http.body_cancel_requested` / `body_cancelled` / `body_cancel_failed` | 取消读取已请求、取消 Promise 已返回或取消失败；请求不冒充释放完成 |
| `model.sdk.terminal` | 消费到 SDK done/error 事件，记录 `sdkTerminalAt`；不消费流而只调用 result 的路径以 `model.request.ended` 核对 |
| `model.request.progress` | 每 15 秒记录活动请求的最后阶段、首末读取/事件/输出时间、读到的字节与块数、事件数、文本/思考/工具参数字符数 |
| `model.request.ended` | 原终态、墙钟/单调时长、用量和累计计数，失败时仅记录错误分类、有限错误码和状态 |
| `execution.*` | agent/turn 生命周期、工具开始/结束、SDK 重试及上下文压缩阶段 |
| `assistant.command.*` / `assistant.run.*` | 应用命令接受、交接与真实成功/失败/取消事件 |
| `task.state` | 任务状态、运行身份、暂停来源、停止确认、最后活动、待退出工具数和累计时长，不记录目标或原因正文 |

`lastStage` 是最后一次观测到的阶段，不等于已确定当前阻塞位置。`model.first_event` 可能只是 start 元数据；首个有效输出单独记录。`toolArgumentChars` 可以区分“工具尚未执行，但参数仍在生成”和完全没有模型输出。

HTTP 观测只注入已核对 SDK 支持 fetch 的 `openai-responses`、`openai-completions`、`anthropic-messages`。其他协议仍有 SDK 请求、输出和心跳记录，但 `httpObserved` 为 false，不能把正文计数为零理解成没有网络传输。认证刷新等 SDK fetch 钩子范围外的请求也不属于此传输记录。

正文计数发生在 SDK 实际读取 Response body/reader/异步迭代器时。不额外预读、缓存或主动拉取数据，不记录正文，不改变背压、信号、原取消原因、原异常或 callback 的返回值。它是消费观测，不是网络抓包；内核或 SDK 缓冲区内尚未消费的数据不可见，JSON/text/clone 便捷读取不纳入该流式正文计数。

## Responses 收尾与依赖补丁

当前固定 `@earendil-works/pi-coding-agent` / `pi-ai` 0.85.1，OpenAI 客户端为 6.40.0。原 Responses 解析器在 completed/incomplete 后继续等待 HTTP EOF，可能阻塞 SDK done 和下一步工具执行。`scripts/patch-pi-responses.mjs` 对 `openai-responses` 在首个有效终止事件后退出迭代；共用解析器的 Azure/Codex 保留原迭代及状态映射行为；OpenAI 客户端负责取消流，空闲保护层等待取消返回并释放 reader。终态后的事件不再处理，不重发请求或工具。

completed 保留原成功/工具调用语义；incomplete 保留 length 或具体失败原因；failed 先保存终态用量再传播错误；cancelled 保存用量与 rawStopReason 并明确报告服务端取消。用户 AbortSignal 仍报告 aborted。终止事件的类型和 response.status 必须一致；无终态的 EOF 明确失败。终结不等同于成果固定或任务验收。

补丁仅修改上述固定版本的三个 JS 文件，逐文件校验完整原始 SHA-256；重复执行可核对已修改内容，未知版本、上下文或哈希拒绝处理。安装根包的 postinstall 自动应用；服务端 dev/build/check/test/start 的前置脚本只核对，不静默带着未修复的 SDK 运行。升级 SDK 时须重新审查补丁与受控测试，不能跳过校验。

禁用安装脚本、复制预装依赖或直接执行构建产物时，需要在部署目录明确执行：

```bash
node scripts/patch-pi-responses.mjs
node scripts/patch-pi-responses.mjs --check
```

脚本只处理本项目解析到的依赖，不联网、不启动子进程，不新增或升级依赖。部署必须包含脚本和对应依赖；直接调用 `node dist/main.js` 不会执行 npm 前置检查。验收可使用 `artifacts/probe-responses-terminal.mjs` 的内存流，无需模型服务。

模型正文空闲保护仍为三分钟，仅在下游等待数据时计时。任务层五分钟提示疑似无进展，三十分钟无执行活动才保存阶段并请求暂停；在途工具、原生工具和待处理人工请求豁免。暂停须等待原命令、工具和依赖资源停止，不能确认则进入 recovery 并保留租约；恢复只核对原记录，不自动重发。持续有效输出会刷新活动时间。协议终止后若取消 Promise 挂起，也通过原执行的同一停止门禁处理，不以终止事件单独确认停止。

针对性测试见 `pi-responses-terminal.test.ts`、`task-responses-finalization.test.ts` 和现有 `task-request-timeout.test.ts` / `task-finalization.test.ts`。它们区分协议、流、SDK、执行返回、资源停止、成果候选、固定成果及审核；受控复现不能替代旧故障的网络证据。

## 进程心跳

`service.heartbeat` 每 15 秒记录墙钟与单调时间增量、两者差值、预期调度间隔偏差、CPU 增量、事件循环平均/p99/最大延迟和活动请求/执行数量。`execution.heartbeat` 标记已接入的活动 agent。

墙钟与单调时间差或调度延迟明显时，额外记录 `service.clock_gap`。它只能建立中断时间窗口，不能单独证明机器睡眠；系统时钟校正、宿主暂停和进程暂停等仍需对应证据。没有 heartbeat 的区间也不能直接归咎于模型。

## 排查方法

1. 保留 `execution.jsonl` 和 `execution.jsonl.1`，按任务/会话/运行及 `bootId` 找到对应 `model.request.started`。
2. 若服务心跳正常，查看请求最后停在准备、等待响应头、读取正文、生成输出还是协议终结；对照首末时间和计数，不只看公开事件是否安静。协议终止已记录、取消尚未返回时，核对原流清理，不能推断 SDK 或执行循环已结束。
3. 若正文块增加但 SDK 输出没有增加，继续对照流解析或协议事件；若工具参数持续增加，查看参数生成阶段。计数只建立现象，不直接判定责任方。
4. 若多个请求与服务心跳同时出现时间间隙，按 UTC 窗口对照系统睡眠/唤醒、进程状态或服务日志；日志本身不会读取系统记录。
5. 使用 `model.http.headers.responseIds` 与上游日志对照。SDK 内部 HTTP 尝试与 agent 重试是两层不同事件，不能混为同一次重试。

## 留存与关闭

单文件最多 4 MiB，轮转保留一个 `.1`；最大保留量约 8 MiB，密集执行可能使较早记录淘汰。单条限制 16 KiB，文件权限 0600，创建目录权限 0700，文件打开不跟随符号链接。

日志不保存提示词、模型正文、思考内容、工具参数/结果、代码、原错误消息、完整响应头或凭据。写入失败只警告一次，不抛给执行流程。应用关闭时先沿用原执行收敛流程，再退订诊断、停止定时器和事件循环监视、关闭日志；`service.closed` 表示诊断实例收尾，不替代任务或进程退出证据。
