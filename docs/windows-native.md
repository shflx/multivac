# Windows 原生适配开发状态

目标环境：Windows 11 x64、NTFS、Node >=22.19.0、Windows PowerShell 5.1、Git for Windows。不包含 WSL2、ARM64、UNC 或网络共享。

本分支只在 macOS 开发和测试。Windows 所有能力由 PlatformCapabilities 统一关闭，应用在初始化数据前拒绝 Windows 启动。平台注入和故障替身不能证明 Windows 实机可用；逐项实机验证并修订文档和项目约束后才可开放。

## 文件持久性

POSIX 继续使用文件 fsync、rename 和目录 fsync。Windows 只使用文件 fsync 和同目录原子替换，不执行目录 fsync，断电保证弱于 POSIX，不能声称等同持久性。

Windows 可变文件替换前保留旧文件的唯一硬链接副本，替换后读回新内容并再次刷新文件，成功后才移除旧副本。替换被拒绝标记 not-committed；替换成功但核对、刷新或收尾失败标记 unknown，保留旧副本。不得自动重放或用旧副本覆盖新文件。文件占用、权限拒绝和 unknown 应先只读核对。

选模恢复记录继续独占发布，不覆盖既有记录。压缩证据先刷新文件后调用模型，证据失败不继续压缩；追加后失败保留结果未知。笔记转换在数据库持久状态保护下恢复，普通文件确认前保留密文记录。

待实机核对：NTFS 替换及文件占用行为、硬链接权限、断电/重启后的恢复、SQLite 与 Pi 的真实持久化。
