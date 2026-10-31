import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { win32 } from 'node:path';

/** 原生 argv 不经命令语言；批处理仅由 cmd.exe 解析，不使用 PowerShell profile 或执行策略。 */
export function programLaunch(file: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== 'win32') return { file, args: [...args] };
  if (/^(npm|npx)$/iu.test(win32.basename(file))) file += '.cmd';
  if (!/\.(cmd|bat)$/iu.test(file)) return { file, args: [...args] };
  // cmd 的百分号展开不能用 argv 引号关闭。拒绝无法无歧义表达的参数，不能悄悄执行不同内容。
  const quote = (value: string) => {
    if (/["%!\r\n\0]/u.test(value)) throw new Error('批处理路径或参数包含不能安全传递给 cmd.exe 的字符。请改用 Node 或原生程序 argv。');
    return `"${value}"`;
  };
  const command = [file, ...args].map(quote).join(' ');
  return { file: environment.ComSpec || environment.COMSPEC || win32.join(environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', `"${command}"`], windowsVerbatimArguments: true };
}
export function spawnProgram(file: string, args: readonly string[], options: SpawnOptions = {}, platform: NodeJS.Platform = process.platform) {
  const launch = programLaunch(file, args, platform, options.env);
  return spawn(launch.file, launch.args, { ...options, shell: false,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}
export function runProgramSync(file: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding,
  platform: NodeJS.Platform = process.platform) {
  const launch = programLaunch(file, args, platform, options.env);
  return spawnSync(launch.file, launch.args, { ...options, shell: false,
    ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

/** 子进程只接收执行所需环境，不自动继承服务端模型或连接器秘密。 */
export function childEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const keys = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'TERM'];
  if (platform === 'win32') keys.push('SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'USERNAME');
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && keys.some(allowed => platform === 'win32' ? key.toUpperCase() === allowed.toUpperCase() : key === allowed)) result[key] = value;
  }
  return result;
}
