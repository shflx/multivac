# 项目终端

项目终端让用户在项目目录运行交互 shell、Claude Code、Codex 或自定义程序。首版支持 **macOS arm64 的本机桌面浏览器**。远程访问、手机和其他服务端平台没有启动入口，服务端也拒绝对应的 HTTP 和 WebSocket 请求。

## 创建与使用

1. 在工作区侧栏展开项目，点击 `+`。菜单分为会话和终端；终端包含空白终端、Claude Code、Codex、自定义命令。
2. 项目只有一个目录时，空白终端、Claude Code、Codex 直接在该目录启动；项目有多个目录时在创建卡中选择，默认主目录。修改主目录不移动已有终端；移除终端正在使用的目录会触发进程收尾。
3. 自定义命令写成一行，例如 `npm run dev`；Claude Code、Codex 可在创建卡中追加参数。命令按空白拆分，支持单双引号与反斜杠转义，不做变量展开或通配；拆出的各项参数逐项交给程序，不再拼成 shell 文本。要使用重定向或管道，可以显式运行 `/bin/sh -c '你的命令'`。自定义命令可以保存为常用命令，之后在创建卡中一键填入。
4. CLI 需要用户自行安装并登录。Multivac 使用登录交互 shell 启动程序；缺少程序、未登录及程序自己的确认界面均在终端中如实呈现。终端不替用户批准 CLI 的权限请求。

终端与会话按最近活动混排，启动预设决定图标；运行中不显示文字，有新输出显示圆点，终端发出通知显示铃铛，结束后显示退出码或信号。并排时终端与会话一起占用栏位：会话按工作区现场填入各栏，仍有空栏时自动放入本项目的终端（新建的在前）；并排时新建的终端进入第一栏。侧栏“更多”菜单可以把终端放进指定的栏，点击未显示的终端则单独查看。终端占用的栏位只在本窗口生效，不写入工作区现场；显示终端时不把栏位作为当前视图交给 Multivac。终端标题栏与会话一致：点击后成为当前对象，“更多”菜单中有全屏、结束进程与关闭终端；改名在侧栏“更多”菜单中。进程结束后画面保留，底部提供关闭与重新打开。普通聊天不会初始化 xterm。浏览器可复制选中的终端文字、粘贴输入并打开链接；链接使用独立窗口且不携带 opener。

终端标题下始终标注“**不受管控**”，悬停查看完整说明；新建菜单与创建卡同样说明终端是外部程序。目录只决定启动位置，不提供文件访问隔离。同目录的并发修改可能冲突。终端直接使用本机用户身份，不能将会话文件授权、任务隔离或 Multivac 模型工具规则理解为对终端程序的沙箱。

## 多窗口、刷新与通知

同一实例同一时刻只有一个窗口持有输入与尺寸。浏览器端吞掉所有会自动应答的终端查询（DA、DSR、DECRQM、XTVERSION、DECRQSS、颜色查询等），只由服务端权威画面应答，避免多窗口重复应答形成重绘与查询的循环。窗口聚焦终端或用户开始操作（按键、粘贴、点击、滚轮、输入法）时自动接管；程序自动产生的数据不触发接管，原子转移输入权并按该窗口同步尺寸，原窗口随即交出；接管确认前的输入暂存后按顺序发送。拥有者断开后释放权属，下一次接回可取得空闲输入权。关闭网页不结束程序。

刷新或短暂断网后，从服务端权威画面接回，再应用快照之后的输出。一个窗口过慢时暂停向该窗口发送，待它确认完已发送内容后补发当前画面快照；接回不依赖保存全部原始输出。服务端保留当前画面和最多 1000 行滚动历史；较早历史被裁剪后显示提示。半截 UTF-8 或控制序列尚未结束时，会等待完整边界；超过 2.5 秒仅中止本次画面接回，进程仍在运行时自动重新接回，原进程继续。

未读圆点表示有新输出；通知计数来自终端 BEL 或 OSC 9/777。通知不表示程序正在等待确认。查看终端会清除未读和通知，多窗口共享元数据。

## 结束、关闭和重新打开

- “结束进程”保留终端对象和本轮有界画面。结束先解除 PTY 读取暂停，向根进程及已观察到且身份仍匹配的后代发送 TERM，宽限后发送 KILL，再核对实际退出。界面显示真实退出码、信号和原因。
- 运行中的“关闭终端”需要确认，核对进程结束后才写入关闭状态。无法确认退出时显示“结束未确认”，保留对象并禁止关闭或重新打开，可以重试结束。
- “重新打开终端”重新校验项目与原目录，用原命令创建新实例。旧画面、连接和水位不属于新实例。
- coding agent 终端记录会话 ID，重开时接回同一会话；会话内容由 CLI 自己保存，Multivac 只保存 ID，不读取会话。
  - Claude Code：创建时由 Multivac 生成 UUID，以 `claude --session-id <id>` 启动，接回时用 `claude --resume <id>`。跟踪之前创建、没有 ID 的终端用 `claude --continue` 继续该目录最近的会话。在 CLI 内 `/clear` 或切换会话后，记录的仍是启动时的会话。
  - Codex：Multivac 按需启动并管理一个 Codex app-server（`codex app-server --listen ws://127.0.0.1:<空闲端口>`，与终端相同的登录 shell 环境），所有 Codex 终端共用。新建时先经 app-server 的 `thread/start` 创建会话、`thread/name/set` 以终端标题命名（命名使会话立即写入磁盘，未发消息也能按 ID 打开，不调用模型），随后控制连接退订该会话，审批等交互留给终端；终端以 `codex resume <id> --remote <地址>` 接入。重开与自动接回同样按 ID 接入，“新会话”在 app-server 中新建会话。启动 Codex 不加 `-c`、`--profile`、`--no-daemon`：这些参数会让 Codex 在终端进程内运行服务，实测在部分用户配置下收到输入即持续空转。app-server 不可用时以普通方式启动 Codex（有 ID 则 `codex resume <id>`），不跟踪新会话。app-server 由看门狗随 Multivac 退出而结束，避免遗留进程占用会话导致接回时提示“open in another app”。终端内 `/new`、`/clear` 或切换会话后，Multivac 仍记录最初的会话。app-server 协议标为实验性，升级 Codex 后需复验。
  - 因 Multivac 重启或服务退出而结束的终端，在界面上显示时自动接回（每个实例只自动尝试一次，不在服务启动时批量拉起进程）；其他原因结束时由“继续原会话”手动接回，“新会话”开始新的会话。
  - 参数已自行指定会话时不注入也不跟踪：Claude Code 的 `--resume`、`--continue`、`--session-id`、`--fork-session`、`--print`；Codex 的 `resume`、`fork`、`exec` 等子命令。
- 关闭即移除：关闭后的终端不再出现在侧栏与工作区，也不进入归档。
- 正常服务退出会收尾所有终端，再关闭数据库。服务重新启动只把遗留运行元数据标为“Multivac 重启”结束；不恢复原进程和画面，不读取或操作旧 PID。

进程归属使用 forkpty 的初始 SID、当前进程组及观察到的父子关系，PID 同时核对启动时间。macOS `ps sess` 是内核引用，不能将它当作数值 SID。不能保证发现并回收在观察前就主动脱组、重新归属的后代；系统 PID 核对与发送信号之间也存在操作系统级竞态。不能将发信号成功描述为全部结束。

当前项目服务没有项目归档/删除的用户入口。`TerminalService.endProject()` 提供项目失效时的统一收尾方法，测试覆盖该方法；将来增加项目归档操作时必须在归档提交前等待它成功。目录移除与正常服务退出已经接入实际生命周期。

## 数据、来源与资源边界

SQLite 只保存终端元数据和启动参数；自定义预设保存在偏好。PTY 输出、输入、画面、PID、连接和 ACK 水位只存在服务进程内存中，不进入工作台持久事件、会话历史或模型上下文。终端不创建 Task/Run、Inbox、成果或工具授权，不提供引用到对话的入口。验证脚本显式保存的截图和测试日志属于开发验收材料，不是运行期终端日志。

HTTP 和 WebSocket 在查终端、创建进程或附着之前共同核对：macOS arm64、本机桌面身份、实际回环对端，以及完整 Host/Origin 的协议、主机和端口。终端读取也使用带 JSON 正文的 POST，缺 Origin 不放行。生产登记 API 端口；开发另登记 5173 代理入口，不接受任意 localhost 端口或转发头伪装。远程 `/api/events` 不投递终端工作台事件。

每终端独立 headless，解析输出、resize 和快照使用同一队列及内部顺序号。尺寸为 10–240 列、4–100 行。待解析超过 256 KiB 暂停读取，低于 64 KiB 恢复；解析缓存硬限 1 MiB，超过则收尾当前实例。WebSocket 每帧不超过 16 KiB，禁用压缩；每窗口未确认输出超过 256 KiB 时暂停向该窗口发送，等它确认完已发内容后补发当前画面快照（跳过中间输出），不断开连接，输入照常；接回期间积压超过上限同样改为快照结束后再补发一次。正在查看的终端不标记未读，活动时间最多 5 秒更新一次，状态不变时不发布工作台事件。根进程退出后不再写入 PTY。控制消息队列及浏览器写入队列也有上限。不设固定终端数量上限。

浏览器在 xterm 写入回调结束后才 ACK，服务端拒绝倒退、超前、旧连接和旧实例水位。快照使用序列化画面；原始增量字节不代替快照。输出与拥有者/尺寸事件在同一顺序下衔接，避免接回期间 resize 先于旧画面或落后于新输出。

启动继承用户环境，清除 `MULTIVAC_*`、`PI_*`、服务端模型密钥和凭据环境、Node 注入变量，以及服务端 `CODEX_HOME`，设置 `TERM=xterm-256color`、`COLORTERM=truecolor`。用户 shell 启动文件仍按 shell 本身的行为运行，CLI 可使用自己的用户登录；这不是凭据或文件隔离。

## 固定依赖与升级复验

| 依赖 | 版本 |
| --- | --- |
| node-pty | 1.1.0 |
| ws | 8.21.0 |
| @xterm/xterm、@xterm/headless | 6.0.0 |
| @xterm/addon-serialize | 0.14.0 |
| @xterm/addon-fit | 0.11.0 |
| @xterm/addon-web-links | 0.12.0 |

`npm ci` 的 postinstall 执行 `scripts/patch-terminals.mjs`。它修复 macOS arm64 `spawn-helper` 执行位，并对 serialize 的 CJS/ESM 构建应用确定性补丁：bold/dim 共享 SGR 22 后重设两个属性；进入备用屏前后清空颜色，避免首屏空白单元继承正常屏颜色。隐藏光标由 `terminal-screen.ts` 的序列化封装补齐。服务端 dev/build/check/test/start 的前置检查拒绝遗漏或不匹配的补丁。

| 构建文件 | 上游 SHA-256 | 修正后 SHA-256 |
| --- | --- | --- |
| addon-serialize.js | `65d8dd7c2b3b37a77f583ea5e0d14a23bbcc846e4ae0d6bb534ae12a380aea0d` | `705eb858848b2be7e4a0dff778b9d9dde0194cc1bcd470e342e467a29fa69687` |
| addon-serialize.mjs | `6c93dff90bef3b7aac8664fa4c1cb4026bf4b701f3014a1fb88edde943dab906` | `9d950ef44c40b920e5decbc8aa68add6bff50fa0689ae596642edc9d461a48b7` |

headless CJS 构建 SHA-256 为 `17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed`。私有字段仅由 `terminal-screen.ts` 访问：`_core._inputHandler._parser.currentState`、`_utf8Decoder.interim` 和 `coreService.isCursorHidden`。启动时核对结构，安装/服务前置检查核对构建哈希。升级必须重审补丁及字段，并重新验证 UTF-8/CSI/OSC/DCS 分块、bold/dim、光标、备用屏颜色、快照/resize 排序、裁剪、背压和真实 CLI 接回；不能仅修改版本和哈希。

## 验证入口

先构建 contracts 和 web，再运行终端专用 Playwright 配置。该配置使用静态页面和独立 API 端口，不占用 Vite 的 5173：

```sh
npm ci
npm run build -w @multivac/contracts
npm run check -w @multivac/server
npm run check -w @multivac/web
npm run build -w @multivac/web
node_modules/.bin/tsx --test apps/server/tests/terminal-*.test.ts apps/server/tests/terminals.test.ts packages/contracts/tests/terminal.test.ts
MULTIVAC_MODE=development MULTIVAC_E2E_API_PORT=4329 npx playwright test -c playwright.terminals.config.ts
```

真实 CLI 验证需要本机安装并登录，显式增加 `MULTIVAC_TERMINAL_CLI_E2E=1`。它启动真实 CLI 并使用 `/help` 测试交互、刷新、第二窗口和接管；不调用模型执行文件或命令工作。第一次进入测试创建的目录时，CLI 可能显示自己的目录信任页。安装、登录、目录确认或其他 CLI 前置条件缺失时，应保留失败/未完成记录，不能以模拟 CLI 替代真实通过。Vite 已有漏洞评估属于独立维护范围，本功能不升级 Vite。
