# Windows 原生适配开发状态

目标环境：Windows 11 x64、NTFS、Node >=22.19.0、Windows PowerShell 5.1、Git for Windows。不包含 WSL2、ARM64、UNC 或网络共享。

本分支只在 macOS 开发和测试。Windows 所有能力由 PlatformCapabilities 统一关闭，应用在初始化数据前拒绝 Windows 启动。平台注入和故障替身不能证明 Windows 实机可用；逐项实机验证并修订文档和项目约束后才可开放。

## 文件持久性

POSIX 继续使用文件 fsync、rename 和目录 fsync。Windows 只使用文件 fsync 和同目录原子替换，不执行目录 fsync，断电保证弱于 POSIX，不能声称等同持久性。

Windows 可变文件替换前保留旧文件的唯一硬链接副本，替换后读回新内容并再次刷新文件，成功后才移除旧副本。替换被拒绝标记 not-committed；替换成功但核对、刷新或收尾失败标记 unknown，保留旧副本。不得自动重放或用旧副本覆盖新文件。文件占用、权限拒绝和 unknown 应先只读核对。

选模恢复记录继续独占发布，不覆盖既有记录。压缩证据先刷新文件后调用模型，证据失败不继续压缩；追加后失败保留结果未知。笔记转换在数据库持久状态保护下恢复，普通文件确认前保留密文记录。

待实机核对：NTFS 替换及文件占用行为、硬链接权限、断电/重启后的恢复、SQLite 与 Pi 的真实持久化。

## 安装与程序启动

npm 脚本不再使用 POSIX 环境变量赋值。开发入口仍等待 API ready 后启动 Web，启动失败终止已启动的服务。macOS 启动入口保留原有远程默认值；Windows 默认关闭远程，且仍受能力门禁阻止启动。

共用 program-launch 区分原生 argv 与批处理。Windows npm/npx 使用 .cmd 并显式调用 cmd.exe /d /s /v:off /c，不触发 npm.ps1 或改变 PowerShell 执行策略；stdio 原样传输。批处理参数中的双引号、百分号、感叹号、换行及 NUL 无法在本实现中可靠表达，会明确拒绝，需改用 Node/原生程序 argv。

本地 node-pty 1.1.0 包包含 win32-x64/conpty.node、conpty_console_list.node、conpty.dll 与 OpenConsole.exe。补丁脚本原已仅对 darwin-arm64 spawn-helper 校验执行位，Windows 会跳过。sharp win32-x64 0.35.5 的实际归档已取得，SHA-512 与锁文件一致，包声明 win32/x64、Node >=20.9.0；其中 sharp-win32-x64-0.35.5.node、libvips-42.dll 与 libvips-cpp-8.18.7.dll 均为 PE x64。包内容核对不等于安装加载验证；未在 macOS 加载 Windows 原生二进制。

## 路径和目录移动

Windows 路径解析使用 node:path.win32，支持盘符绝对路径、普通相对路径、`~`、本地 `file:///C:/...`、中文与空格。拒绝盘符相对路径、当前盘根、UNC、设备/扩展长度路径、ADS、保留名称、非法字符与结尾点/空格。生成文件名避开 Windows 保留名称。配置与挂载仍要求绝对路径。

包含关系按平台路径规则判断，授权及挂载仍需真实路径核对；不能通过转小写代替 realpath 或 junction 校验。Windows 目录移动使用独占目标和复制核对，兼容跨卷；副本内容与源身份/内容核对通过后才删除源。复制或文件占用失败保留源与部分副本，已存在目标连空目录也不覆盖。链接创建失败保留源。Windows 回收站不可用，清理保留临时目录。

未实机核对 NTFS 大小写目录、junction、跨卷及文件占用；同账号并发修改在最终核对与删除间仍有残余竞态，不将 cwd 或路径钩子描述为文件系统隔离。

## 私有数据与 ACL

Windows 私有目录只保护 Multivac 实例数据根和明确配置的 Pi 凭据父目录（生产沿用 Pi agentDir，开发位于实例根内）。使用 PowerShell 5.1 的 .NET ACL API，经共用程序启动规则执行；不加载 profile，不改变执行策略，不使用本地化账号名。目录关闭外部继承并移除既有显式权限，允许当前 WindowsIdentity SID、SYSTEM（S-1-5-18）及 Administrators（S-1-5-32-544）FullControl，以 ContainerInherit/ObjectInherit 传给新子项。

Pi 可能已预建目录和 auth.json。适配只处理该明确父目录及指定的凭据文件：指定文件移除显式规则并恢复目录继承，写前写后核对；不扫描用户的整个 .pi、工作目录或逐文件所有者，不迁移 Multivac 历史 Windows 数据。MCP、网页设置、微信绑定、远程 token 和实例内模型临时文件都在私有目录中创建。临时文件与替换使用同目录继承，未把外部文件直接移入凭据存储。

ACL 设置失败、退出异常或回读不符时拒绝秘密操作，不生成替代凭据；写后失败仍须只读核对原结果。保留目录类型、链接、真实路径和文件身份检查，Windows 不以 POSIX mode 判定安全。威胁模型是其他普通账号，不包含管理员、SYSTEM 或同账号程序；不作逐文件 ACL 所有者替换审计。真实 SID、继承传播和 Pi 替换行为尚待 Windows 实机验证。

## PowerShell 命令后端

CommandShell 先迁移现有 bash 私有握手包装，再独立增加 Windows PowerShell 5.1。工具身份仍为 bash，Windows 提示实际解释器与语法，前台输出不调用 SDK Bash 包装或探测。命令文本通过 UTF-8 内容和 UTF-16LE EncodedCommand 传入；原生 argv 与批处理使用 program-launch；命令文本中的 npm/npx 应显式写 npm.cmd/npx.cmd。不加载 profile、不改变执行策略。子进程环境使用白名单，不继承模型密钥。

PowerShell 在执行前解析语法。终止错误停止后续语句，非终止 Error 流和原生非零退出记录为失败，后续成功语句不能清除先前失败；只用最终 $? 不足以判断。顶层多语句逐条保留退出码。为避免误报，当前明确拒绝动态命令、外部 .ps1，以及循环/分支/嵌套表达式里的原生调用或同一管道的多次原生调用；应拆成单独的顶层语句。这是已知功能限制，不能当作任意 PowerShell 脚本兼容。

PowerShell 控制台与原生输入/输出协商设为 UTF-8（代码页 65001），Node 按 UTF-8 保留输出。忽略代码页设置而强行输出 OEM/ANSI 编码的旧程序仍需调用方显式转换，未经实机验证不保证自动识别任意中文代码页。替身只核对编码与包装、中文输出及失败呈现，未执行 PowerShell。

## 进程监护与停止证明

ProcessSupervisor 先迁移现有 Node 监护装配，再增加 Windows CIM 分支；macOS 的 ps、进程组、私有握手及信号分支保留。Windows 根 PowerShell 在 stdin 握手前不执行用户命令，CIM 观察到 PID 与 CreationDate 后才放行。PowerShell 编码参数限制为 30,000 字符以内，超限要求拆分，且在监护进程启动前拒绝。

Windows 通过 Win32_Process 记录根和已观察后代，每次终止前核对 CreationDate，仅终止身份匹配的进程。CIM Terminate 返回成功不能证明退出，须等待根退出、输出管道关闭，并重新查询确认已观察范围全部消失；查询失败或缺少已知进程的创建身份时保留监护、租约及恢复状态。兼容退出凭据的 groupStopped 字段只随 treeStopped 一起生成，Windows 公共记录不伪造 processGroupId。没有使用 taskkill /T 成功作为证明。

Windows 无 POSIX SIGTERM 语义，CIM Terminate 不保证优雅退出。采样间已脱离且未观察到的后代不保证回收；初次身份无法确认时不放行命令也不宣称停止。当前不自动发现 Windows 后台子进程监听端口，port 保持 null。取消、超时和输出额度复用原服务协议，未知结果保留恢复。ProcessSupervisor 装配点可在后续实机证明确有需要时替换为 Job Object；本轮不增加原生辅助程序。

托管进程首轮是否提供仍待决定，Windows managed() 拒绝，managed-process-supervisor 的隔离实现保持原样。以上均只经 macOS 替身验证，未在 Windows 执行 CIM 或停止真实进程。

## 远程访问（后续实机验证用）

Windows 默认关闭远程；当前即使显式开启也会在生成 token 前被 PlatformCapabilities 拒绝。下列为后续验证时的 PowerShell 5.1 配置写法，不代表当前已开放：

```powershell
$env:MULTIVAC_REMOTE_ENABLED = '1'
# 将下面地址换成这台 Windows 机器实际的 Tailscale 地址。
$env:MULTIVAC_REMOTE_HOST = '100.101.102.103'
# 可选，仅限制该手机访问来源；协议、主机、端口须与实际访问完全一致。
$env:MULTIVAC_REMOTE_ORIGIN = 'http://100.101.102.103:4317'
npm.cmd start
```

建议绑定 Tailscale 地址，不默认绑定全部网卡。服务打印实际监听地址（IPv6 使用方括号）；不自动更改 Windows 防火墙或网络。token 自动生成前依赖私有 ACL，失败不生成/轮换，损坏不静默重建。手动 token 保持优先且不打印。

远程仍只提供已有全局对话与 Inbox，手机登录不授予终端、工作会话、目录或其他本机能力。保留完整 Host/Origin、实际回环对端、来源绑定和登录撤销；不信任转发头。IPv4、IPv6 和映射 IPv6 仅规范化原有回环身份，Tailscale IPv4/IPv6 不判为本机。真实 Windows 启动、ACL、手机 Tailscale 登录和连接撤销尚待实机验证。

## 新任务和 Git 工作目录

TaskWorkingDirectories 在读取项目来源或创建目录、分支前核对 taskExecution/command 能力。Windows 分支为 Git for Windows 使用 git.exe、本地路径、独立空 hooks 目录和 NUL 全局配置；保持固定 HEAD 的独立 worktree，不改写 dirty 来源工作树。共用命令与监护分别接 CommandShell 和 ProcessSupervisor，旧隔离 Run 不自动迁移。

Windows 任务提示明确使用 PowerShell 5.1 与 npm.cmd/npx.cmd。非 macOS 不使用 APFS 克隆，依赖未自动准备时如实说明，可经共用命令安装。专用受控 Git 继续限 macOS，不能借任务开放。

Git 发布继续固定提交、HTTPS 远端与新分支，经真实单次批准再执行；未知结果只读核对，不重推。Windows 凭据环境保留 Git for Windows 所需用户路径，禁用交互登录，不继承模型秘密；准备 worktree 不读取用户全局 Git 配置。gitPublish 能力同样关闭，当前不会在 Windows 运行 Git。NUL/hooks、Git Credential Manager 和真实 worktree 行为仍待实机验证。

## MCP stdio

Windows stdio 启动复用 program-launch：Node、uvx 等原生 argv 直接运行，npm/npx 与配置的 .cmd/.bat 经 cmd.exe；不把协议或命令送入 PowerShell 格式化管道。独立 Node 根先等待 CIM 身份握手，再启动服务；协议 stdout/stderr 字节直通，退出事实走单独 IPC。根在目标结束后继续保留，直到已观察后代消失才释放；连接停止需再次确认整个观察范围退出。

连接前沿用账号、目录、项目、分类和逐次许可核对，取消及未知调用不重发。Windows 关闭连接通过结束输入请求监护清理，不强杀监护器后冒充服务已退出。CIM 查询失败、异常退出等无法证明停止时保留原租约和恢复事实。私有凭据只注入配置声明的环境，不进入公开日志；Windows 按大小写保护执行环境，拒绝覆盖 PATH、ComSpec、NODE_/OPENSSL_ 等监护运行变量。未自动继承服务端模型密钥。

MCP stdio 能力仍关闭。替身核对握手、字节传输、取消前不启动与查询失败不提供证明；macOS 真实 stdio/HTTP、任务/工作会话许可和版本回归通过。Windows npx/uvx 与真实服务协议、后代退出均待实机验证，采样遗漏边界同 ProcessSupervisor。

## 项目终端与 CLI

Windows 分支使用 node-pty ConPTY，空白终端实际启动 Windows PowerShell 5.1（不加载 Profile）。Claude Code、Codex、自定义程序沿用 argv；共用启动规则按 Windows PATH 查找原生 .exe/.com 或 .cmd/.bat，批处理参数仍受前述限制，不写入 CLI 用户配置。macOS 仍使用原登录 shell、forkpty 和原进程核对。

ConPTY 的 Node 根先等 CIM 身份握手，再以继承控制台方式启动所选程序。监护器通过独立 IPC 传启动/停止事实，终端输入等待观察到 CLI 子进程后再放行，等待期间最多缓存 64 KiB。终端正文沿原画面通道传输，不进入数据库或模型上下文。停止必须同时取得 PTY 根退出与监护器确认观察范围消失；查询失败或监护器异常时保持 stop-unconfirmed，不能按旧 PID 清理、恢复旧 PID 或恢复画面。宿主 IPC 断开会请求监护器继续清理。

自管 Codex app-server 仅监听动态 127.0.0.1 WebSocket 地址，与终端共用 Windows CLI 启动；复用 CIM 根握手监督，宿主输入管道关闭即请求停止。连接异常、初始化/就绪超时及正常退出均请求清理；原实例未确认停止时拒绝启动新实例，停止超时明确失败。macOS 看门狗保持原行为。终端身份、Host/Origin、远程拒绝、刷新/重开和会话 ID 跟踪规则保持原样。

4 项平台替身核对默认程序、参数、输入握手、PID 复用、查询失败和停止凭据；现有真实 macOS PTY、画面与 CLI 会话跟踪定向回归通过。ConPTY、CLI 安装路径、组合键/中文输入、真实 Codex app-server 协议和服务退出仍待 Windows 实机测试。terminal 能力关闭，PROJECT_CONSTRAINTS.md 的 macOS arm64 开放边界保持不变。
