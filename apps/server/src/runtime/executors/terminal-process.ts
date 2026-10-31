import { childEnvironment, programLaunch } from '../program-launch.js';
import { win32 } from 'node:path';
import { WINDOWS_TERMINAL_ROOT, WINDOWS_TERMINAL_WATCHER } from './windows-terminal-supervisor.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import type { TerminalPreset, TerminalSize } from '@multivac/contracts';
const execute = promisify(execFile);
/** COLORFGBG 声明浅色背景（前景 0、背景 15），供不查询终端颜色的程序选择配色。 */
export function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...source, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: '0;15' })
    .filter((entry): entry is [string, string] => entry[1] !== undefined &&
      !/^(MULTIVAC_|PI_|CODEX_HOME$|NODE_OPTIONS$|NODE_PATH$|GOOGLE_APPLICATION_CREDENTIALS$|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$)|(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(entry[0])));
}
export function shellQuote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }
export function terminalCommand(preset: TerminalPreset): string | null {
  if (preset.kind === 'blank') return null;
  return ['exec', ...[preset.kind === 'custom' ? preset.executable : preset.kind, ...preset.argv].map(shellQuote)].join(' ');
}
export function windowsTerminalLaunch(preset: TerminalPreset, environment: NodeJS.ProcessEnv = process.env) {
  if (preset.kind === 'blank') return programLaunch(win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile'], 'win32', environment);
  return programLaunch(preset.kind === 'custom' ? preset.executable : preset.kind, preset.argv, 'win32', environment);
}
interface ProcessIdentity { pid: number; ppid: number; pgid: number; sessionReference: string; born: string; state: string }
async function processTable(): Promise<ProcessIdentity[]> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,sess=,lstart=,stat='], { maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) throw new Error('无法核对终端进程身份。');
    return { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), sessionReference: fields[3]!, born: fields.slice(4, 9).join(' '), state: fields[9]! };
  });
}

/** 只操作本实例观察到且身份仍匹配的 PID；不宣称能捕获观察前就脱组的进程。 */
export class TerminalProcess {
  readonly pty: pty.IPty;
  private owned = new Map<number, ProcessIdentity>();
  private root: ProcessIdentity | undefined;
  private observation = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private windows: { watcher: ChildProcess; started: boolean; stopping: boolean; proven: boolean; failed: boolean; pending: Buffer[]; bytes: number; closed: Promise<boolean>; rootClosed: Promise<void> } | undefined;
  private rootExited = false;
  private windowsStopTimeout = 15000;
  /** forkpty 为子进程建立新会话，初始会话首领 PID 即 SID。macOS ps sess 是内核引用，不能当成 SID。 */
  readonly sessionId: number;
  private stopping: Promise<boolean> | undefined;
  private exit: { exitCode: number; signal?: number } | undefined;
  onOutput: (data: Buffer) => void = () => {};
  onExit: (exit: { exitCode: number; signal?: number }) => void = () => {};
  private listeners: pty.IDisposable[];
  constructor(directory: string, preset: TerminalPreset, size: TerminalSize, platform: NodeJS.Platform = process.platform,
    dependencies: { spawnPty?: typeof pty.spawn; spawnWatcher?: typeof spawn; stopTimeoutMillis?: number } = {}) {
    if (platform === 'win32') {
      const launch = windowsTerminalLaunch(preset);
      this.pty = (dependencies.spawnPty ?? pty.spawn)(process.execPath, ['-e', WINDOWS_TERMINAL_ROOT, JSON.stringify({ ...launch, cwd: directory })], {
        cwd: directory, ...size, name: 'xterm-256color', env: terminalEnvironment(process.env), encoding: 'utf8', useConpty: true,
      });
    } else {
      const command = terminalCommand(preset);
      this.pty = (dependencies.spawnPty ?? pty.spawn)(process.env.SHELL || '/bin/sh', ['-l', '-i', ...(command ? ['-c', command] : [])], {
        cwd: directory, ...size, name: 'xterm-256color', env: terminalEnvironment(process.env), encoding: null,
      });
    }
    let rootClosed!: () => void;
    const rootClosedPromise = new Promise<void>(resolve => { rootClosed = resolve; });
    this.windowsStopTimeout = dependencies.stopTimeoutMillis ?? 15000;
    this.sessionId = this.pty.pid;
    // 根进程退出后 PTY 写入会以 EIO 失败（例如退出前后到达的输入或终端查询应答），直接丢弃。
    const write = this.pty.write.bind(this.pty);
    const resize = this.pty.resize.bind(this.pty);
    this.pty.write = (data: string | Buffer) => {
      if (this.rootExited) return;
      const state = this.windows;
      if (state?.stopping) return;
      if (state && !state.started) {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (state.bytes + bytes.length > 64 * 1024) throw new Error('终端仍在核对启动或停止，暂不能继续输入。');
        state.pending.push(bytes); state.bytes += bytes.length; return;
      }
      write(data);
    };
    this.pty.resize = (cols: number, rows: number) => { if (!this.rootExited) resize(cols, rows); };
    this.listeners = [this.pty.onData(data => this.onOutput(Buffer.isBuffer(data) ? data : Buffer.from(data))), this.pty.onExit(exit => {
      this.rootExited = true; this.exit = exit; rootClosed(); this.onExit(exit);
    })];
    if (platform === 'win32') {
      const watcher = (dependencies.spawnWatcher ?? spawn)(process.execPath, ['-e', WINDOWS_TERMINAL_WATCHER, String(this.pty.pid)], {
        env: childEnvironment(process.env, platform), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let closed!: (proof: boolean) => void;
      const state: NonNullable<TerminalProcess['windows']> = this.windows = { watcher, started: false, stopping: false, proven: false, failed: false, pending: [] as Buffer[], bytes: 0,
        closed: new Promise<boolean>(resolve => { closed = resolve; }), rootClosed: rootClosedPromise };
      watcher.on('message', (message: { ready?: boolean; started?: boolean; stopped?: boolean; queryFailed?: boolean; observed?: boolean }) => {
        if (message.observed) state.failed = false;
        if (message.queryFailed) state.failed = true;
        if (message.ready && !state.stopping && !this.rootExited) write('\r');
        if (message.started && !state.stopping && !this.rootExited) {
          state.started = true;
          for (const data of state.pending) write(data);
          state.pending = []; state.bytes = 0;
        }
        if (message.stopped) state.proven = true;
      });
      watcher.once('error', () => { state.failed = true; });
      watcher.once('close', (code, signal) => { closed(state.proven && code === 0 && !signal); });
      return;
    }
    this.timer = setInterval(() => { void this.observe().catch(() => {}); }, 200);
    this.timer.unref();
    void this.observe().catch(() => {});
  }
  observe(): Promise<void> {
    if (this.windows) return this.windows.failed ? Promise.reject(new Error('Windows 终端进程身份尚未确认。')) : Promise.resolve();
    const next = this.observation.then(async () => {
      const table = await processTable();
      const root = table.find(item => item.pid === this.pty.pid);
      if (!this.root && !this.rootExited && root) { this.root = root; this.owned.set(root.pid, root); }
      const current = new Map(table.map(item => [item.pid, item]));
      const belongs = (pid: number) => { const previous = this.owned.get(pid); return previous && current.get(pid)?.born === previous.born; };
      for (const [pid, previous] of this.owned) if (current.get(pid)?.born !== previous.born) this.owned.delete(pid);
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of table) {
          if (belongs(item.pid)) continue;
          if (belongs(item.ppid) || this.root && belongs(this.root.pid) && item.pgid === this.root.pgid && item.sessionReference === this.root.sessionReference) {
            this.owned.set(item.pid, item); changed = true;
          }
        }
      }
    });
    this.observation = next.catch(() => {});
    return next;
  }
  private async survivors(): Promise<ProcessIdentity[]> {
    await this.observe();
    const table = await processTable();
    // 僵尸也不假报消失；交由系统回收后再确认。
    return table.filter(item => this.owned.get(item.pid)?.born === item.born);
  }
  stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    this.pty.resume();
    if (this.windows) {
      const state = this.windows;
      state.stopping = true; state.pending = []; state.bytes = 0;
      try { if (state.watcher.connected) state.watcher.send({ stop: true }); } catch { state.failed = true; }
      this.stopping = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([state.closed.then(proof => proof ? state.rootClosed.then(() => this.rootExited) : false),
            new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.windowsStopTimeout); })]);
        } finally { clearTimeout(timer); this.stopping = undefined; }
      })();
      return this.stopping;
    }
    this.stopping = (async () => {
      try {
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          for (const item of await this.survivors()) {
            try { process.kill(item.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          }
          // 根还未出现在 ps 时不能据此报成功，也不能按未经核对的旧 PID 操作。
          for (let attempt = 0; attempt < 15; attempt++) {
            if (this.rootExited && (await this.survivors()).length === 0) return true;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        return false;
      } catch { return false; }
      finally { this.stopping = undefined; }
    })();
    return this.stopping;
  }
  get result() { return this.exit; }
  dispose(): void {
    clearInterval(this.timer);
    if (this.windows && !this.windows.proven && this.windows.watcher.connected) {
      try { this.windows.watcher.send({ stop: true }); } catch { /* 未确认时不按旧 PID 操作，保留监护事实。 */ }
    }
    for (const listener of this.listeners) listener.dispose();
    this.listeners = [];
  }
}
