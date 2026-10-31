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

本地 node-pty 1.1.0 包包含 win32-x64/conpty.node、conpty_console_list.node、conpty.dll 与 OpenConsole.exe。补丁脚本原已仅对 darwin-arm64 spawn-helper 校验执行位，Windows 会跳过。锁文件登记 sharp win32-x64 0.35.5；本轮下载包内容检查超时，未核实该包的实际归档，须在 Windows 安装时核对。未在 macOS 加载 Windows 原生二进制。

## 路径和目录移动

Windows 路径解析使用 node:path.win32，支持盘符绝对路径、普通相对路径、`~`、本地 `file:///C:/...`、中文与空格。拒绝盘符相对路径、当前盘根、UNC、设备/扩展长度路径、ADS、保留名称、非法字符与结尾点/空格。生成文件名避开 Windows 保留名称。配置与挂载仍要求绝对路径。

包含关系按平台路径规则判断，授权及挂载仍需真实路径核对；不能通过转小写代替 realpath 或 junction 校验。Windows 目录移动使用独占目标和复制核对，兼容跨卷；副本内容与源身份/内容核对通过后才删除源。复制或文件占用失败保留源与部分副本，已存在目标连空目录也不覆盖。链接创建失败保留源。Windows 回收站不可用，清理保留临时目录。

未实机核对 NTFS 大小写目录、junction、跨卷及文件占用；同账号并发修改在最终核对与删除间仍有残余竞态，不将 cwd 或路径钩子描述为文件系统隔离。
