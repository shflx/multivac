import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolve } from 'node:path';
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const FILE_LIMIT = 4 * 1024 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
export type NativeTaskLease = (phase: 'starting' | 'settled', marker: string, bytes: number) => number;
const WORKER = `const fs=require('node:fs');const [op,path]=process.argv.slice(1);
if(op==='read'){const fd=fs.openSync(path,'r');try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>${FILE_LIMIT})throw Error('读取上限');const b=fs.readFileSync(fd);if(b.length>${FILE_LIMIT})throw Error('读取上限');process.stdout.write(b);}finally{fs.closeSync(fd);}}
else if(op==='write')fs.writeFileSync(path,fs.readFileSync(0));
else if(op==='mkdir')fs.mkdirSync(path,{recursive:true});
else if(op==='access')fs.accessSync(path,fs.constants.R_OK);
else if(op==='edit-access')fs.accessSync(path,fs.constants.R_OK|fs.constants.W_OK);
else throw Error('未知操作');`;

/** 原生任务工具禁止派生进程；等待已跟踪的单个进程退出即可确认本次工具停止。 */
export class NativeTaskTools {
  private readonly children = new Set<ChildProcess>();
  private readonly signals = new AsyncLocalStorage<AbortSignal | undefined>();
  private disposed = false;
  private constructor(readonly directory: string, private readonly profile: string, private readonly lease?: NativeTaskLease) {}

  /** 独立托管入口只放行指定回环监听，普通任务工具的网络策略不变。 */
  managedProfile(port: number | null): string {
    if (port === null) return this.profile;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('监听端口必须位于 1024–65535。');
    return `${this.profile}\n(allow network-bind network-inbound (local ip "localhost:${port}"))`;
  }

  static async create(directory: string, protectedPaths: readonly string[] = [], lease?: NativeTaskLease): Promise<NativeTaskTools> {
    if (process.platform !== 'darwin') throw new Error('当前平台尚无通过验证的原生任务工具隔离，未启动任务。');
    const root = await realpath(directory);
    const node = await realpath(process.execPath);
    const protectedRoots: string[] = [];
    for (const path of protectedPaths) {
      protectedRoots.push(resolve(path));
      try { protectedRoots.push(await realpath(path)); } catch { /* 缺失目录也按声明路径拒绝。 */ }
    }
    const reads = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple/System', '/opt/homebrew/Cellar', '/opt/homebrew/lib', '/opt/homebrew/opt', dirname(node), root];
    const profile = `(version 1) (deny default)
      (allow process-exec) (deny process-fork)
      (allow process-info* (target self))
      (allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.")
        (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osversion")
        (sysctl-name "kern.hostname") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.tcsm_enable")
        (sysctl-name "sysctl.proc_cputype") (sysctl-name "security.mac.lockdown_mode_state"))
      (allow file-read-metadata (vnode-type DIRECTORY))
      (allow file-read* (literal "/") ${reads.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')}
        (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd"))
      (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null") (subpath "/dev/fd"))
      ${protectedRoots.map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`).join('\n')}`;
    const tools = new NativeTaskTools(root, profile, lease);
    const probe = await tools.execute(process.execPath, ['-e', 'process.stdout.write("ready")']);
    if (probe.code !== 0 || probe.output.toString() !== 'ready') throw new Error('原生任务工具隔离探针失败，未启动任务。');
    return tools;
  }

  execute(executable: string, args: string[], options: { signal?: AbortSignal; input?: Buffer; limit?: number; timeoutMs?: number; onData?: (chunk: Buffer) => void; fenced?: boolean } = {}): Promise<{ code: number | null; output: Buffer }> {
    const signal = options.signal ?? this.signals.getStore();
    if (this.disposed || signal?.aborted) return Promise.reject(new Error('任务工具已停止。'));
    return new Promise((resolve, reject) => {
      const marker = randomUUID();
      let limit = options.limit ?? OUTPUT_LIMIT;
      if (options.fenced) {
        if (!this.lease) { reject(new Error('没有已核对的任务执行租约。')); return; }
        limit = Math.min(limit, this.lease('starting', marker, options.input?.length ?? 0));
      }
      const child = spawn('/usr/bin/sandbox-exec', ['-p', this.profile, executable, ...args], {
        cwd: this.directory, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: this.directory, TMPDIR: this.directory, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null' },
      });
      this.children.add(child);
      let size = 0;
      let overflow = false;
      const chunks: Buffer[] = [];
      const stop = () => { child.kill('SIGKILL'); };
      const timer = setTimeout(stop, options.timeoutMs ?? 60000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const receive = (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { overflow = true; stop(); return; }
        chunks.push(chunk);
        options.onData?.(chunk);
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.stdin.on('error', () => { /* 提前停止时由 close 给出真实执行结果。 */ });
      child.stdin.end(options.input);
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        this.children.delete(child);
        if (options.fenced) {
          try { this.lease!('settled', marker, size); }
          catch { reject(new Error('工具已退出，但停止事实未能提交，须核对执行租约。')); return; }
        }
        if (overflow) reject(new Error('任务工具输出超过上限，执行已停止。'));
        else resolve({ code, output: Buffer.concat(chunks) });
      });
    });
  }

  private async file(operation: string, path: string, content?: string): Promise<Buffer> {
    const result = await this.execute(process.execPath, ['-e', WORKER, operation, path], {
      ...(content === undefined ? {} : { input: Buffer.from(content) }), limit: FILE_LIMIT,
      fenced: true,
    });
    if (result.code !== 0) throw new Error('原生任务工具隔离拒绝文件访问，或本次文件操作已停止。');
    return result.output;
  }

  definitions(): ToolDefinition[] {
    const readFile = (path: string) => this.file('read', path);
    const writeFile = async (path: string, content: string) => { await this.file('write', path, content); };
    const definitions = [
      createReadToolDefinition(this.directory, { operations: { readFile, access: async (path) => { await this.file('access', path); } } }),
      createEditToolDefinition(this.directory, { operations: { readFile, writeFile, access: async (path) => { await this.file('edit-access', path); } } }),
      createWriteToolDefinition(this.directory, { operations: { writeFile, mkdir: async (path) => { await this.file('mkdir', path); } } }),
      createBashToolDefinition(this.directory, { exposeSessionEnvironment: false, operations: {
        exec: async (command, _cwd, options) => {
          const result = await this.execute('/bin/bash', ['--noprofile', '--norc', '-c', command], {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: Math.min((options.timeout ?? 60) * 1000, 60000), onData: options.onData,
            fenced: true,
          });
          return { exitCode: result.code };
        },
      } }),
    ];
    const portable = definitions as unknown as ToolDefinition[];
    for (const definition of portable) {
      const execute = definition.execute;
      // 读写 operations 本身不接收 signal，按调用隔离的异步上下文传入，支持并行工具调用。
      definition.execute = (...args: Parameters<typeof execute>) => this.signals.run(args[2], () => execute(...args));
    }
    return portable;
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill('SIGKILL');
  }
  get processesStopped(): boolean { return this.children.size === 0; }
}
