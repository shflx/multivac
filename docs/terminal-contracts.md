# 项目终端数据与传输契约

PTY、HTTP/WebSocket 与独立界面已接入。使用方式、固定依赖和验证入口见 [项目终端](terminals.md)；本文件维护数据与传输契约。

## 对象与持久化

`ProjectTerminal` 独立于会话和任务，以 `terminalId` 标识用户看到的终端，以 `instanceId` 标识一次进程运行。SQLite 的 `project_terminal` 表只接受 `ProjectTerminalSchema` 白名单字段：项目、原目录、标题、启动预设与 argv、状态、创建及活动时间、关闭时间、最近退出、未读与通知计数。不保存 PID、连接、水位、输入、输出或快照。自定义命令预设通过全局偏好的 `terminalCommandPresets` 保存。

`blank` 只开交互 shell；`claude` 与 `codex` 保存各自 argv；`custom` 分别保存 executable 与 argv。调用层必须逐参数转义后在 shell 内执行，不能把 argv 直接拼为命令文本。图标始终取预设，不识别前台程序。

状态为 `starting`、`running`、`stopping`、`stop-unconfirmed`、`exited`、`failed`。关闭是独立的 `closedAt` 标记，不替代进程停止核对。只有 `exited` 或 `failed` 才能标记关闭；`stop-unconfirmed` 仍占用运行实例，禁止重开。

退出记录分别保存 code、signal、reason、occurredAt 和对应 instanceId。只有 reason 为 `process-exit`、code 为 0 且 signal 为 null 才表示正常成功。用户结束、项目移除、目录移除、服务退出、Multivac 重启和启动失败分别保留原因。

仓储更新按 expectedInstanceId 比较，旧实例回调无法改写重开后的记录。重开保持 terminalId、项目、原目录、原命令，创建新的 instanceId；创建时间保留，instanceStartedAt 更新，可保留上一实例的 lastExit 供查看。终态必须携带属于当前实例的退出记录。`endInterrupted()` 只把遗留活动元数据改为 exited / multivac-restarted，清除未读与通知，无 PID 操作；服务启动由 TerminalService 调用。

## HTTP 操作约定

已注册的路由采用以下约定。所有请求必须先过本机守卫，再查终端或创建进程。操作错误使用项目现有 error 响应结构，缺对象为 404、无效参数为 400、实例/状态冲突为 409、本机访问拒绝为 403。

| 路径与方法 | 参数 | 返回与语义 |
| --- | --- | --- |
| POST /api/terminals/list | ListTerminalsSchema；includeClosed 默认 false | `{ terminals }`，按 lastActivityAt 降序、terminalId 稳定排序；重连必须重读 |
| POST /api/terminals/:id/get | GetTerminalSchema（空对象） | `{ terminal }` |
| POST /api/terminals | CreateTerminalSchema | `{ terminal }`；默认项目第一个目录，只能选择当前登记目录；实际存在性在启动时复核 |
| PATCH /api/terminals/:id | RenameTerminalSchema | `{ terminal }`；更新标题 |
| POST /api/terminals/:id/end | EndTerminalSchema | `{ terminal }`；实例匹配且未关闭；终态不可再次结束；信号发出后仍是 stopping，无法证实退出为 stop-unconfirmed |
| POST /api/terminals/:id/close | CloseTerminalSchema | `{ terminal }`；运行中必须 confirmRunning=true，经结束及停止核对后才能写 closedAt；失败保留未关闭状态 |
| POST /api/terminals/:id/reopen | ReopenTerminalSchema | `{ terminal }`；旧实例已结束，再校验项目、原目录，创建新实例；不是恢复 CLI 会话 |
| POST /api/terminals/:id/read | ReadTerminalSchema | `{ terminal }`；实例匹配且未关闭，清除未读和通知 |

浏览器同源 GET 可能不发送 Origin，且脚本不能自行设置该请求头。因此终端列表、详情也使用 application/json 的 POST，通过浏览器自动携带 Origin；仍拒绝所有缺 Origin 的终端请求。

本机入口同时核对实际回环对端、本机登录身份及完整 Host/Origin。生产登记当前 API 端口，开发另登记保留浏览器 Host 的 5173 代理入口；不放行其他 localhost 端口、远程登录身份、转发头伪装、手机标识或非 macOS arm64 服务端。普通会话导航仍允许无 Origin，终端守卫始终要求 Origin。HTTP 守卫位于路由分发前；upgrade 在 handleUpgrade 和终端读取之前调用同一来源守卫。

目录登记只定义启动 cwd，不提供文件访问隔离。输入尺寸必须为 10–240 列、4–100 行。HTTP 正文最大 32 KiB；自定义预设偏好请求也使用 32 KiB 上限，重复预设 ID 拒绝。

## 运行期传输

`ws` 使用 noServer 接入 `/api/terminals/:id/stream`，禁用压缩。升级前通过与 HTTP 相同的本机守卫。每个 JSON 帧的实际 UTF-8 编码不得超过 16 KiB，接收端也须校验该大小，不能只按字符串长度判断。

服务端 `attached` 分配 connectionId 并给出当前 instanceId、ownerConnectionId。后续双向消息均绑定该连接和实例。客户端消息为 `input`、`resize`、`takeover`（含接管尺寸）、`ack`（绝对字节水位）和 `read`。服务端拒绝失效连接、旧实例、非拥有者输入和 resize。takeover 必须在同一串行操作中更换唯一拥有者并设置尺寸；校验函数本身不执行接管。

服务端先发送 `snapshot-begin`（snapshotId、尺寸、绝对水位、historyTrimmed），再依序发送 `snapshot-data`（序列化画面字节的 Base64 与从零起算的片段 offset），最后发送 `snapshot-end`。每个片段 Base64 最多 12 KiB，发送端还须核对包含元数据后的整个帧上限。快照完整后才衔接其 watermark 之后的 `output`；output 包含原始字节 Base64、from 和 watermark，必须满足解码字节数等于 watermark-from。不能把快照序列化字节数作为输出水位。退出与拥有者变更分别使用 `exit` 与 `owner` 消息。

输出绝对水位从当前实例的第零字节起算。浏览器只有在 term.write 回调完成后才能 ACK；整个快照应用完成后确认快照水位，增量逐次确认。服务端按窗口记录 sent 与 acknowledged，拒绝倒退、超前及非安全整数的 ACK。快照期间应保留其水位之后的增量，直到完成衔接；任何缓冲超限都明确断开该次接回，不能悄悄丢字节。单窗口未确认超过 256 KiB 只断该慢窗口。

每终端 headless 权威画面在统一队列解析输出、尺寸与快照。scrollback 1000 行。仅在 UTF-8/控制序列完整边界生成快照，等待不能阻塞解析；2.5 秒超时只结束本次接回。解析积压超过 256 KiB 暂停 PTY，低于 64 KiB 恢复；结束进程前解除暂停。BEL/OSC 通知不能解释为等待确认。

列表、改名、状态、未读、通知通过本机 `/api/events` 同步；事件流不含输出、输入或快照，远程不投递终端元数据。断线后重读列表。服务重启不能接回原画面和进程，不能按旧 PID 发信号。

## 本阶段验证范围

契约测试覆盖严格字段、预设参数边界、尺寸与消息限制、退出语义；仓储测试覆盖 SQLite 重开、偏好、排序、关闭门禁、实例隔离和重启元数据；连接校验测试覆盖 ACK 倒退/超前、失效连接与非拥有者控制。上述均不替代真实 PTY、帧传输、接管原子性、画面还原和界面验收。
