import { execFile } from 'node:child_process';

export type RevealCommand = (executable: string, args: readonly string[]) => Promise<void>;

/** 固定系统程序，不使用 shell，不继承模型凭据，等待退出后再报告命令结果。 */
export const runRevealCommand: RevealCommand = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { shell: false, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' } }, error => {
    if (error) reject(new Error('系统定位请求失败或超时，无法确认 Finder 是否显示。'));
    else resolve();
  });
});

export function finderArguments(absolute: string, kind: 'file' | 'directory'): string[] {
  // 目录指定 Finder，避免把 .app 等目录当作应用启动；绝对路径不能成为命令选项。
  return kind === 'file' ? ['-R', absolute] : ['-a', '/System/Library/CoreServices/Finder.app', absolute];
}
