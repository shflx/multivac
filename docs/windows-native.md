# Windows 原生适配开发状态

目标环境：Windows 11 x64、NTFS、Node >=22.19.0、Windows PowerShell 5.1、Git for Windows。不包含 WSL2、ARM64、UNC 或网络共享。

本分支主要在 macOS 开发。2026-11-01 在 Windows 11 x64、Node 24.13.1、PowerShell 5.1、C: 与 E: NTFS 卷上完成依赖安装、类型检查、生产构建、contracts 68 项、Web 292 项及 Windows 定向回归。真实 Windows 覆盖 npm 启动路径、私有目录与凭据文件 ACL、文件占用、同卷及跨卷中文目录移动、PowerShell 输出和退出码、CIM 进程身份与停止、ConPTY 启动；Pi 最小 smoke 使用 deepseek/deepseek-flash 与 Anthropic Messages endpoint 成功完成真实模型回复。跨账号 ACL 读取按本次用户要求跳过，未计为通过。

新增 `.github/workflows/windows-native.yml`，以 Windows PowerShell 5.1 运行 Windows 检查，并保留 macOS 针对性回归；远程 CI 尚未执行。Windows x64 的启动、对话、文件工具、共用命令、任务独立目录执行、MCP stdio、本机项目终端、显式启用的远程入口、任务工具、Skill 副作用、受控 Git、Git 发布与托管进程已在本机开放。系统文件定位、系统程序打开资料和回收站仍不可用。M1 的跨账号 ACL 读取依用户要求跳过，不计为通过；完整应用恢复和路径故障场景仍有未验收项。

本轮补测在 Windows 11 x64 上完成共用命令、后台 HTTP 服务、取消、超时、输出额度、根退出后的子进程追踪、ConPTY 中文输入及停止、Node 与 `.cmd` MCP stdio 中文协议与停止。更新后的 Windows CI 同范围定向集 105 项通过、3 项按环境或平台条件跳过。`npm run check`、目录读取授权和会话命令准入回归通过。独立数据目录下的 Windows 浏览器 E2E 已让工作会话调用真实 PowerShell 工具并核对输出。第三方 CLI 的完整工作流仍未验收。

隔离开发数据下，11 个 Windows Chromium 浏览器 E2E 用例通过，覆盖会话目录、文件浏览与操作、归入项目及重启恢复、笔记加密、流式对话与刷新恢复；这些 E2E 使用假模型。独立应用实例还用真实 deepseek/deepseek-flash 完成全局对话，重启后在未注入密钥的情况下读回历史；工作会话中的真实模型 `write` 与 `read` 工具均成功，磁盘文件内容与回读一致。M2/M3 完整工作流尚未验收。

PDF 资源目录已改用本地文件 URL，Windows 实机的导入、目录与原页定向测试通过。全量服务端测试仍含依赖 POSIX bash 的用例，会失败或停滞；M2/M3 的浏览器 E2E 尚未完成。当前不能据此认定 Windows 全部能力的端到端验收完成。

## 文件持久性

POSIX 继续使用文件 fsync、rename 和目录 fsync。Windows 只使用文件 fsync 和同目录原子替换，不执行目录 fsync，断电保证弱于 POSIX，不能声称等同持久性。

Windows 可变文件替换前保留旧文件的唯一硬链接副本，替换后读回新内容并再次刷新文件，成功后才移除旧副本。替换被拒绝标记 not-committed；替换成功但核对、刷新或收尾失败标记 unknown，保留旧副本。不得自动重放或用旧副本覆盖新文件。文件占用、权限拒绝和 unknown 应先只读核对。

选模恢复记录继续独占发布，不覆盖既有记录。压缩证据先刷新文件后调用模型，证据失败不继续压缩；追加后失败保留结果未知。笔记转换在数据库持久状态保护下恢复，普通文件确认前保留密文记录。

NTFS 替换、真实文件占用、硬链接副本及旧文件保留已在实机核对；SQLite 重开、Pi 会话恢复、压缩和笔记加解密的定向测试通过。进程崩溃后的完整应用恢复及断电持久性未验证，不能据此声称断电安全。

## 安装与程序启动

npm 脚本不再使用 POSIX 环境变量赋值。开发入口使用 `tsx` 加载 TypeScript 配置模块，等待 API ready 后启动 Web，启动失败终止已启动的服务。Windows PowerShell 5.1 下的 `npm run dev` 已使 API 与 Vite 均返回 200；`npm start` 在带空格的独立数据、工作与 Pi 目录下使生产页面及 API 均返回 200，停止后端口关闭。macOS 启动入口保留原有远程默认值；Windows 默认关闭远程。

默认开发实例中的旧调度 owner PID 已退出时，Windows Node 的 `process.kill(pid, 0)` 仍可能返回 `EPERM`。调度器在该分支只读查询 CIM；确认 PID 不存在后接管，查询失败仍保留冲突。修复后默认开发数据目录启动成功，不清空旧任务或会话。

共用 program-launch 区分原生 argv 与批处理。Windows npm/npx 使用 .cmd 并显式调用 cmd.exe /d /s /v:off /c，不触发 npm.ps1 或改变 PowerShell 执行策略；stdio 原样传输。批处理参数中的双引号、百分号、感叹号、换行及 NUL 无法在本实现中可靠表达，会明确拒绝，需改用 Node/原生程序 argv。

本地 node-pty 1.1.0 包包含 win32-x64/conpty.node、conpty_console_list.node、conpty.dll 与 OpenConsole.exe。补丁脚本原已仅对 darwin-arm64 spawn-helper 校验执行位，Windows 会跳过。sharp win32-x64 0.35.5 的实际归档已取得，SHA-512 与锁文件一致，包声明 win32/x64、Node >=20.9.0；其中 sharp-win32-x64-0.35.5.node、libvips-42.dll 与 libvips-cpp-8.18.7.dll 均为 PE x64。Windows 实机已从锁文件安装并加载 sharp 0.35.5、libvips 8.18.7 和 node-pty 1.1.0，并通过 ConPTY 启动 PowerShell 探针。

## 路径和目录移动

Windows 路径解析使用 node:path.win32，支持盘符绝对路径、普通相对路径、`~`、本地 `file:///C:/...`、中文与空格。拒绝盘符相对路径、当前盘根、UNC、设备/扩展长度路径、ADS、保留名称、非法字符与结尾点/空格。生成文件名避开 Windows 保留名称。配置与挂载仍要求绝对路径。

包含关系按平台路径规则判断，授权及挂载仍需真实路径核对；不能通过转小写代替 realpath 或 junction 校验。Windows 目录移动使用独占目标和逐项复制核对，兼容跨卷；当前 Windows/Node 24 的 `fs.cpSync` 在复制中文目录时会直接退出进程，同卷也会发生，因此 Windows 分支不使用该 API。副本内容与源身份/内容核对通过后才删除源。复制或文件占用失败保留源与部分副本，已存在目标连空目录也不覆盖。链接创建失败保留源。Windows 回收站不可用，清理保留临时目录。

跨卷和文件占用已在实机核对；NTFS 大小写目录、junction 越界的完整应用路径仍未实机核对。同账号并发修改在最终核对与删除间仍有残余竞态，不将 cwd 或路径钩子描述为文件系统隔离。

## 私有数据与 ACL

Windows 私有目录只保护 Multivac 实例数据根和明确配置的 Pi 凭据父目录（生产沿用 Pi agentDir，开发位于实例根内）。使用 PowerShell 5.1 的 .NET ACL API，经共用程序启动规则执行；不加载 profile，不改变执行策略，不使用本地化账号名。目录关闭外部继承并移除既有显式权限，允许当前 WindowsIdentity SID、SYSTEM（S-1-5-18）及 Administrators（S-1-5-32-544）FullControl，以 ContainerInherit/ObjectInherit 传给新子项。

Pi 可能已预建目录和 auth.json。适配只处理该明确父目录及指定的凭据文件：指定文件移除显式规则并恢复目录继承，写前写后核对；不扫描用户的整个 .pi、工作目录或逐文件所有者，不迁移 Multivac 历史 Windows 数据。MCP、网页设置、微信绑定、远程 token 和实例内模型临时文件都在私有目录中创建。临时文件与替换使用同目录继承，未把外部文件直接移入凭据存储。

ACL 设置失败、退出异常或回读不符时拒绝秘密操作，不生成替代凭据；写后失败仍须只读核对原结果。保留目录类型、链接、真实路径和文件身份检查，Windows 不以 POSIX mode 判定安全。威胁模型是其他普通账号，不包含管理员、SYSTEM 或同账号程序；不作逐文件 ACL 所有者替换审计。普通用户下的临时目录、凭据文件新建及重复核对已在 Windows 实机通过；独立普通账号读取测试按本次用户要求跳过。

## PowerShell 命令后端

CommandShell 先迁移现有 bash 私有握手包装，再独立增加 Windows PowerShell 5.1。工具身份仍为 bash，Windows 提示实际解释器与语法，前台输出不调用 SDK Bash 包装或探测。命令文本通过 UTF-8 内容和 UTF-16LE EncodedCommand 传入；原生 argv 与批处理使用 program-launch；命令文本中的 npm/npx 应显式写 npm.cmd/npx.cmd。不加载 profile、不改变执行策略。子进程环境使用白名单，不继承模型密钥。

PowerShell 在执行前解析语法。终止错误停止后续语句，非终止 Error 流和原生非零退出记录为失败，后续成功语句不能清除先前失败；只用最终 $? 不足以判断。顶层多语句逐条保留退出码。为避免误报，当前明确拒绝动态命令、外部 .ps1，以及循环/分支/嵌套表达式里的原生调用或同一管道的多次原生调用；应拆成单独的顶层语句。这是已知功能限制，不能当作任意 PowerShell 脚本兼容。

PowerShell 控制台与原生输入/输出协商设为 UTF-8（代码页 65001），Node 按 UTF-8 保留输出。忽略代码页设置而强行输出 OEM/ANSI 编码的旧程序仍需调用方显式转换，不保证自动识别任意中文代码页。Windows 实机已核对中文输出与原生命令非零退出不会被后续成功语句覆盖。
本轮实机进一步核对前后台命令、中文目录、非零退出、密钥环境隔离、取消、超时、输出额度及后台 HTTP 服务停止后端口释放。PowerShell 进度流已关闭，避免进度记录混入命令日志；Windows 正常 CIM 收尾允许完整等待，避免过早标记为恢复中。本机没有可用 Python，`python -m http.server` 仍无法启动；该场景应改用已安装的 Node 或先安装 Python。应用层 Windows x64 `command` 门禁已在完成实机验证并取得用户授权后开放。

## 进程监护与停止证明

ProcessSupervisor 先迁移现有 Node 监护装配，再增加 Windows CIM 分支；macOS 的 ps、进程组、私有握手及信号分支保留。Windows 根 PowerShell 在 stdin 握手前不执行用户命令，CIM 观察到 PID 与 CreationDate 后才放行。PowerShell 编码参数限制为 30,000 字符以内，超限要求拆分，且在监护进程启动前拒绝。

Windows 通过 Win32_Process 记录根和已观察后代，每次终止前核对 CreationDate，仅终止身份匹配的进程。CIM Terminate 返回成功不能证明退出，须等待根退出、输出管道关闭，并重新查询确认已观察范围全部消失；查询失败或缺少已知进程的创建身份时保留监护、租约及恢复状态。兼容退出凭据的 groupStopped 字段只随 treeStopped 一起生成，Windows 公共记录不伪造 processGroupId。没有使用 taskkill /T 成功作为证明。

Windows 无 POSIX SIGTERM 语义，CIM Terminate 不保证优雅退出。采样间已脱离且未观察到的后代不保证回收；初次身份无法确认时不放行命令也不宣称停止。当前不自动发现 Windows 后台子进程监听端口，port 保持 null。取消、超时和输出额度复用原服务协议，未知结果保留恢复。ProcessSupervisor 装配点可在后续实机证明确有需要时替换为 Job Object；本轮不增加原生辅助程序。

Windows 旧版 `managed()` 监护器仍拒绝创建 macOS 隔离进程；新任务托管脚本与兼容 `start` 入口复用共用后台命令，以当前 Windows 用户运行。实机已验证 Node HTTP 服务启动、停止和端口释放，不提供 macOS 的系统沙箱隔离。CIM 已核对临时 Node 进程的身份观察、终止和消失确认；detached 子孙进程在根退出后继续存活时，已观察身份仍可追踪并清理。采样间继续派生的后代与异常查询仍有监护边界，尚不足以决定是否引入 Job Object。
本轮还从共用命令服务验证根退出后仍运行的后台子进程、HTTP 端口释放和停止回执。采样前脱组的进程及监护器异常退出仍没有实机覆盖，Job Object 结论不变。

## 远程访问

Windows 默认关闭远程；Windows x64 可显式开启。系统网卡拥有 Tailscale 地址时优先只绑定该地址。sing-box 的用户态 Tailscale endpoint 未把 Tailnet 地址注册为 Windows 网卡，直接绑定会返回 `EADDRNOTAVAIL`；本机验收改为监听所有网卡，由 sing-box 提供 Tailnet 入站：

```powershell
$env:MULTIVAC_REMOTE_ENABLED = '1'
$env:MULTIVAC_REMOTE_HOST = '0.0.0.0'
npm.cmd start
```

`0.0.0.0` 同时监听局域网；仍需 token 登录，可按部署环境用防火墙限制来源。服务打印实际监听地址（IPv6 使用方括号）；不自动更改 Windows 防火墙或网络。token 自动生成前依赖私有 ACL，失败不生成/轮换，损坏不静默重建。手动 token 保持优先且不打印。`MULTIVAC_REMOTE_ORIGIN` 可选，设置时须与手机实际访问的协议、主机和端口完全一致。

远程仍只提供已有全局对话与 Inbox，手机登录不授予终端、工作会话、目录或其他本机能力。保留完整 Host/Origin、实际回环对端、来源绑定和登录撤销；不信任转发头。IPv4、IPv6 和映射 IPv6 仅规范化原有回环身份，Tailscale IPv4/IPv6 不判为本机。
本轮手机经 sing-box Tailnet 地址打开构建页面，以保存的 token 登录，并完成全局对话和 Inbox 浏览。当前服务的临时远程登录、全局会话读取、终端接口拒绝与登出分别得到 200、200、403、200；定向测试覆盖错误 token、Origin、越界路由、SSE 和旧 cookie 撤销。手机端 MagicDNS、服务重启后的重新登录及连接撤销仍未单独实测。

## 新任务和 Git 工作目录

TaskWorkingDirectories 在读取项目来源或创建目录、分支前核对 taskExecution/command 能力。任务绑定的项目首个目录是 Git 仓库根目录时，Windows 通过 Git for Windows 的 git.exe、本地路径、独立空 hooks 目录和 NUL 全局配置，从固定 HEAD 创建任务专用分支与独立 worktree，不改写 dirty 来源工作树。非 Git 项目使用独立快照，未绑定项目使用空的独立目录；这两种情况不是 Git worktree。共用命令与监护分别接 CommandShell 和 ProcessSupervisor，旧隔离 Run 不自动迁移。

Windows 任务提示明确使用 PowerShell 5.1 与 npm.cmd/npx.cmd。非 macOS 不使用 APFS 克隆，依赖未自动准备时如实说明，可经共用命令安装。专用受控 Git 已在 Windows 独立 worktree 实机验证只读查询、状态、提交和租约结算；命令仍可直接操作仓库元数据，任务提示优先使用专用工具。

Git 发布继续固定提交、HTTPS 远端与新分支，经真实单次批准再执行；未知结果只读核对，不重推。Windows 凭据环境保留 Git for Windows 所需用户路径，禁用交互登录，不继承模型秘密；准备 worktree 不读取用户全局 Git 配置。当前仓库的 `origin` 是 GitHub SSH 远端，GCM 的 `manager` helper 位于 Git 系统配置中；发布进程禁用系统配置后显式指定 GCM，并清空仓库可能配置的其他 helper。本机 HTTPS 夹具已验证受信证书、凭据提供、申请、拒绝、批准、固定版本推送、重复决定、分支冲突和未知结果核对。真实 GitHub HTTPS/GCM 验收又在临时克隆的任务 worktree 中完成受控提交、拒绝不发布、批准后固定提交推送、重放及中断恢复的只读核对；浏览器 Inbox 也完成了实际点击批准、远端 SHA 核对。两条验收分支均按固定 SHA 删除，远端复核无遗留；`gitPublish` 已开放。
本轮在临时 Git 仓库由真实 Pi 会话配合本机脚本化模型完成准备失败后的继续执行、独立 worktree、`npm.cmd ci` 与测试、文件写入、本地提交、成果登记及停止结算；源仓库的固定 HEAD 和脏文件均保持原样。任务调度、暂停、取消和预算已有跨平台替身回归。Windows 真实模型任务及运行中停止后的恢复仍未实机验收，不能从 Git 发布结果推断这些场景已通过。`taskExecution` 与 `gitPublish` 门禁均已开放。

## MCP stdio

Windows stdio 启动复用 program-launch：Node、uvx 等原生 argv 直接运行，npm/npx 与配置的 .cmd/.bat 经 cmd.exe；不把协议或命令送入 PowerShell 格式化管道。独立 Node 根先等待 CIM 身份握手，再启动服务；协议 stdout/stderr 字节直通，退出事实走单独 IPC。根在目标结束后继续保留，直到已观察后代消失才释放；连接停止需再次确认整个观察范围退出。

连接前沿用账号、目录、项目、分类和逐次许可核对，取消及未知调用不重发。Windows 关闭连接通过结束输入请求监护清理，不强杀监护器后冒充服务已退出。CIM 查询失败、异常退出等无法证明停止时保留原租约和恢复事实。私有凭据只注入配置声明的环境，不进入公开日志；Windows 按大小写保护执行环境，拒绝覆盖 PATH、ComSpec、NODE_/OPENSSL_ 等监护运行变量。未自动继承服务端模型密钥。

Windows x64 MCP stdio 已开放。Node 本地夹具经原生 argv 与 `.cmd` 启动器完成中文 JSON 请求响应和进程树退出确认；真实 `npx.cmd --call` 离线启动本地 MCP 服务，工作会话与任务会话均完成连接、账号许可、调用、取消、版本核对及后代停止。Windows 的 `npx.cmd` 位置参数形式在离线缓存缺失时尝试访问 registry，因此本地夹具使用 `--call`。`uvx.exe --version` 已通过，uvx 托管的 MCP 服务链路仍未实测。采样遗漏边界同 ProcessSupervisor。

## 项目终端与 CLI

Windows 分支使用 node-pty ConPTY，空白终端实际启动 Windows PowerShell 5.1（不加载 Profile）。Claude Code、Codex、自定义程序沿用 argv；共用启动规则按 Windows PATH 查找原生 .exe/.com 或 .cmd/.bat，批处理参数仍受前述限制，不写入 CLI 用户配置。macOS 仍使用原登录 shell、forkpty 和原进程核对。

ConPTY 的 Node 根先等 CIM 身份握手，再以继承控制台方式启动所选程序。监护器通过独立 IPC 传启动/停止事实，终端输入等待观察到 CLI 子进程后再放行，等待期间最多缓存 64 KiB。终端正文沿原画面通道传输，不进入数据库或模型上下文。停止必须同时取得 PTY 根退出与监护器确认观察范围消失；查询失败或监护器异常时保持 stop-unconfirmed，不能按旧 PID 清理、恢复旧 PID 或恢复画面。宿主 IPC 断开会请求监护器继续清理。

自管 Codex app-server 仅监听动态 127.0.0.1 WebSocket 地址，与终端共用 Windows CLI 启动；复用 CIM 根握手监督，宿主输入管道关闭即请求停止。连接异常、初始化/就绪超时及正常退出均请求清理；原实例未确认停止时拒绝启动新实例，停止超时明确失败。macOS 看门狗保持原行为。终端身份、Host/Origin、远程拒绝、刷新/重开和会话 ID 跟踪规则保持原样。

Windows 11 x64 的本机项目终端已开放。实机 ConPTY 空白 PowerShell 终端完成中文输入及进程树停止证明；终端生命周期验证了目录卸载、停止未确认保护与项目收尾。HTTP/WS 验证了来源拒绝、输入与快照、双窗口接管、结束及重开；真实应用验证了正常退出先收尾终端、重启后只恢复结束元数据。Chromium 浏览器从项目菜单新建终端后完成输入、刷新、第二窗口接管与停止。Codex app-server 经回环 WebSocket 创建并命名会话，停止时确认进程退出；Codex CLI 已通过临时只读模型请求，ConPTY 预设启动与停止通过。Claude CLI 的账号返回订阅无效；两个 CLI 的完整浏览器交互和会话接回仍未实测。锁定版本 node-pty 的控制台列表辅助脚本只对已退出目标的 `AttachConsole failed` 返回空列表，升级仍须复验。
