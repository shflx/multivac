export type PlatformCapability = 'startup' | 'terminal' | 'mcpStdio' | 'taskTools' | 'command' | 'managedProcess' | 'controlledGit' | 'skillRun' | 'skillCopy' | 'reveal' | 'open' | 'trash' | 'remote';
export interface PlatformCapabilities {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  denial(capability: PlatformCapability): string | null;
}

/** 这里只描述已验证的平台能力；身份、目录授权及运行恢复仍由各入口核对。 */
export function createPlatformCapabilities(host: { platform: NodeJS.Platform; arch: string } = process): PlatformCapabilities {
  const mac = host.platform === 'darwin';
  const reasons: Record<PlatformCapability, string | null> = {
    startup: null,
    terminal: mac && host.arch === 'arm64' ? null : '项目终端仅支持 macOS arm64 本机桌面。',
    mcpStdio: host.platform === 'win32' ? '当前平台尚不支持 MCP stdio。' : null,
    taskTools: mac ? null : '当前平台尚无通过验证的原生任务工具隔离，未启动任务。',
    command: host.platform === 'win32' ? '当前共用 bash 后端尚不支持 Windows。' : null,
    managedProcess: mac ? null : '当前平台未验证托管隔离。',
    controlledGit: mac ? null : '当前平台尚未验证受控 Git 隔离，未执行。',
    skillRun: mac ? null : '当前平台尚无通过验证的原生任务工具隔离，未启动任务。',
    skillCopy: mac ? null : '当前平台尚无通过验证的原生任务工具隔离，未启动任务。',
    reveal: mac ? null : '系统文件定位仅支持本机 macOS Finder，当前平台不支持。',
    open: mac ? null : '用系统程序打开资料仅支持本机 macOS。',
    trash: host.platform === 'win32' ? 'Windows 的回收站暂不支持，到期的临时目录保留不动。' : null,
    remote: null,
  };
  return Object.freeze({ platform: host.platform, arch: host.arch,
    denial: (capability: PlatformCapability) => host.platform === 'win32'
      ? `Windows 能力（${capability}）尚待 Windows 11 x64 实机验证，当前不可用。`
      : reasons[capability] });
}
