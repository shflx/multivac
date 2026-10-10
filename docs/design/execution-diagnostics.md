# 执行停滞诊断日志

为排查任务或普通会话长时间没有进展，后端在内部数据目录下追加 `diagnostics/execution.jsonl`。`MULTIVAC_DATA_DIR` 决定数据根目录，未设置时为 `~/.multivac`。启用需要加载新版后端；旧进程与已结束的历史请求无法补采这些信息。

本次只增加观测，不修改模型超时、自动重试、任务预算、暂停、恢复或 Inbox 策略。日志不是业务状态或停止证明，不驱动调度。

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
| `model.request.progress` | 每 15 秒记录活动请求的最后阶段、首末读取/事件/输出时间、读到的字节与块数、事件数、文本/思考/工具参数字符数 |
| `model.request.ended` | 原终态、墙钟/单调时长、用量和累计计数，失败时仅记录错误分类、有限错误码和状态 |
| `execution.*` | agent/turn 生命周期、工具开始/结束、SDK 重试及上下文压缩阶段 |
| `assistant.command.*` / `assistant.run.*` | 应用命令接受、交接与真实成功/失败/取消事件 |
| `task.state` | 任务状态、运行身份、暂停来源、停止确认、最后活动、待退出工具数和累计时长，不记录目标或原因正文 |

`lastStage` 是最后一次观测到的阶段，不等于已确定当前阻塞位置。`model.first_event` 可能只是 start 元数据；首个有效输出单独记录。`toolArgumentChars` 可以区分“工具尚未执行，但参数仍在生成”和完全没有模型输出。

HTTP 观测只注入已核对 SDK 支持 fetch 的 `openai-responses`、`openai-completions`、`anthropic-messages`。其他协议仍有 SDK 请求、输出和心跳记录，但 `httpObserved` 为 false，不能把正文计数为零理解成没有网络传输。认证刷新等 SDK fetch 钩子范围外的请求也不属于此传输记录。

正文计数发生在 SDK 实际读取 Response body/reader/异步迭代器时。不额外预读、缓存或主动拉取数据，不记录正文，不改变背压、信号、原取消原因、原异常或 callback 的返回值。它是消费观测，不是网络抓包；内核或 SDK 缓冲区内尚未消费的数据不可见，JSON/text/clone 便捷读取不纳入该流式正文计数。

## 进程心跳

`service.heartbeat` 每 15 秒记录墙钟与单调时间增量、两者差值、预期调度间隔偏差、CPU 增量、事件循环平均/p99/最大延迟和活动请求/执行数量。`execution.heartbeat` 标记已接入的活动 agent。

墙钟与单调时间差或调度延迟明显时，额外记录 `service.clock_gap`。它只能建立中断时间窗口，不能单独证明机器睡眠；系统时钟校正、宿主暂停和进程暂停等仍需对应证据。没有 heartbeat 的区间也不能直接归咎于模型。

## 排查方法

1. 保留 `execution.jsonl` 和 `execution.jsonl.1`，按任务/会话/运行及 `bootId` 找到对应 `model.request.started`。
2. 若服务心跳正常，查看请求最后停在准备、等待响应头、读取正文还是生成输出；对照首末时间和计数，不只看公开事件是否安静。
3. 若正文块增加但 SDK 输出没有增加，继续对照流解析或协议事件；若工具参数持续增加，查看参数生成阶段。计数只建立现象，不直接判定责任方。
4. 若多个请求与服务心跳同时出现时间间隙，按 UTC 窗口对照系统睡眠/唤醒、进程状态或服务日志；日志本身不会读取系统记录。
5. 使用 `model.http.headers.responseIds` 与上游日志对照。SDK 内部 HTTP 尝试与 agent 重试是两层不同事件，不能混为同一次重试。

## 留存与关闭

单文件最多 4 MiB，轮转保留一个 `.1`；最大保留量约 8 MiB，密集执行可能使较早记录淘汰。单条限制 16 KiB，文件权限 0600，创建目录权限 0700，文件打开不跟随符号链接。

日志不保存提示词、模型正文、思考内容、工具参数/结果、代码、原错误消息、完整响应头或凭据。写入失败只警告一次，不抛给执行流程。应用关闭时先沿用原执行收敛流程，再退订诊断、停止定时器和事件循环监视、关闭日志；`service.closed` 表示诊断实例收尾，不替代任务或进程退出证据。
