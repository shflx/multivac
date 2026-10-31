import { programLaunch } from '../program-launch.js';
import { WINDOWS_STDIO_SUPERVISOR } from './windows-stdio-supervisor.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import type { CodexThreads } from '../../modules/terminals/codex-threads.js';
import { shellQuote, terminalEnvironment } from './terminal-process.js';

const READY_TIMEOUT_MILLIS = 15_000;
const REQUEST_TIMEOUT_MILLIS = 15_000;

/** 选取一个本机空闲端口；只监听回环地址。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('无法分配端口。'))));
    });
  });
}

const sleep = (millis: number) => new Promise(resolve => setTimeout(resolve, millis));

interface Connection {
  child: ChildProcess;
  endpoint: string;
  socket: WebSocket;
  pending: Map<number, (message: { result?: unknown; error?: { message?: string } }) => void>;
  next: number;
}

/**
 * Multivac 自管的 Codex app-server（WebSocket，仅回环地址）。
 *
 * - 按需启动一个实例，所有 Codex 终端共用；与终端使用同一登录 shell 环境找到同一个 codex。
 * - 控制连接只用于创建并命名会话，随后退订，审批等交互留给终端里的 Codex。
 * - 只停止自己启动的进程，不接管桌面应用或其他程序启动的 daemon。
 * app-server 协议标为实验性，消息不带 jsonrpc 字段；升级 Codex 后需复验。
 */
export class CodexAppServer implements CodexThreads {
  private connection: Promise<Connection> | null = null;
  private closed = false;
  private windowsChildren = new Map<ChildProcess, Promise<void>>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  private registerWindowsChild(child: ChildProcess): void {
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', () => { /* close 事件前不据此认定观察范围已停止。 */ });
      child.once('close', (code, signal) => {
        if ((code === 0 || code === 127) && !signal) { this.windowsChildren.delete(child); resolve(); }
        else reject(new Error('Codex app-server 的停止尚未确认。'));
      });
    });
    this.windowsChildren.set(child, closed);
    void closed.catch(() => {});
  }

  private async stopWindowsChild(child: ChildProcess): Promise<void> {
    child.stdin?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.windowsChildren.get(child), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex app-server 的停止尚未确认。')), READY_TIMEOUT_MILLIS);
      })]);
    } finally { clearTimeout(timer); }
  }

  async endpoint(): Promise<string> {
    return (await this.connect()).endpoint;
  }

  async createThread(cwd: string, name: string): Promise<string> {
    const connection = await this.connect();
    const started = await this.request(connection, 'thread/start', { cwd, ephemeral: false }) as { thread?: { id?: unknown } };
    const threadId = started.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex app-server 未返回会话 ID。');
    await this.request(connection, 'thread/name/set', { threadId, name });
    await this.request(connection, 'thread/unsubscribe', { threadId }).catch(() => {});
    return threadId;
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = await this.connection?.catch(() => null);
    this.connection = null;
    if (this.platform === 'win32') {
      connection?.socket.close();
      await Promise.all([...this.windowsChildren.keys()].map(child => this.stopWindowsChild(child)));
      return;
    }
    if (!connection) return;
    connection.socket.close();
    if (connection.child.exitCode === null) connection.child.kill('SIGTERM');
  }

  private connect(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('Codex app-server 已停止。'));
    if (!this.connection && this.windowsChildren.size) return Promise.reject(new Error('原 Codex app-server 的停止尚未确认，暂不能启动新实例。'));
    this.connection ??= this.start().catch(error => { this.connection = null; throw error; });
    return this.connection;
  }

  private async start(): Promise<Connection> {
    const endpoint = `ws://127.0.0.1:${await freePort()}`;
    // 看门狗：Multivac 异常退出（未走正常关闭）时也在 1 秒内结束 app-server，避免遗留进程继续占用会话，
    // 导致下次接回时提示会话已在别处打开。结束看门狗（SIGTERM）时一并结束 app-server。
    // 外壳以 detached 方式启动，成为独立进程组的组长，app-server（npm 启动器与 codex 本体）都在这一组中；
    // 结束时按组发送信号。仍有终端连接时 app-server 可能不响应 SIGTERM，5 秒后改用 SIGKILL。
    const script = [
      `codex app-server --listen ${shellQuote(endpoint)} & server=$!`,
      'stop() { trap "" TERM INT HUP; kill -TERM 0 2>/dev/null; i=0; while kill -0 "$server" 2>/dev/null && [ $i -lt 5 ]; do sleep 1; i=$((i + 1)); done; kill -KILL 0 2>/dev/null; }',
      'trap \'stop; exit 0\' TERM INT HUP',
      `while kill -0 ${process.pid} 2>/dev/null && kill -0 "$server" 2>/dev/null; do sleep 1; done`,
      'stop',
    ].join('\n');
    const environment = terminalEnvironment(process.env);
    const child = this.platform === 'win32'
      ? spawn(process.execPath, ['-e', WINDOWS_STDIO_SUPERVISOR, JSON.stringify({ ...codexAppServerLaunch(endpoint, environment), cwd: homedir() })], {
          cwd: homedir(), env: environment, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
        })
      : spawn(process.env.SHELL || '/bin/sh', ['-l', '-c', script], {
          detached: true, cwd: homedir(), env: environment, stdio: ['ignore', 'ignore', 'ignore'],
        });
    if (this.platform === 'win32') this.registerWindowsChild(child);
    let exited = false;
    child.once('exit', () => { exited = true; });
    const deadline = Date.now() + READY_TIMEOUT_MILLIS;
    let socket: WebSocket | null = null;
    while (!socket) {
      if (exited) throw new Error('Codex app-server 启动后立即退出，请确认已安装并登录 codex。');
      if (Date.now() > deadline) {
        if (this.platform === 'win32') await this.stopWindowsChild(child);
        else child.kill('SIGTERM');
        throw new Error('Codex app-server 启动超时。');
      }
      socket = await new Promise<WebSocket | null>(resolve => {
        const candidate = new WebSocket(endpoint);
        candidate.once('open', () => resolve(candidate));
        candidate.once('error', () => resolve(null));
      });
      if (!socket) await sleep(200);
    }
    const connection: Connection = { child, endpoint, socket, pending: new Map(), next: 1 };
    socket.on('message', raw => {
      let message: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(String(raw)); } catch { return; }
      // 只处理本连接请求的响应；通知与服务端请求不在控制连接上处理（会话创建后即退订）。
      if (typeof message.id === 'number' && message.method === undefined) {
        connection.pending.get(message.id)?.(message);
        connection.pending.delete(message.id);
      }
    });
    // 服务或连接断开后丢弃本次连接，未完成的请求以失败结束，下次使用时重新启动。
    const reset = () => {
      this.connection = null;
      for (const resolve of connection.pending.values()) resolve({ error: { message: 'Codex app-server 连接已断开。' } });
      connection.pending.clear();
    };
    socket.once('close', () => {
      reset();
      if (this.platform === 'win32') void this.stopWindowsChild(child).catch(() => {});
      else if (child.exitCode === null) child.kill('SIGTERM');
    });
    child.once('exit', () => { reset(); socket?.close(); });
    try {
      await this.request(connection, 'initialize', { clientInfo: { name: 'multivac', title: 'Multivac', version: '0.1.0' } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    } catch (error) {
      if (this.platform === 'win32') { socket.close(); await this.stopWindowsChild(child); }
      throw error;
    }
    return connection;
  }

  private request(connection: Connection, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = connection.next++;
      const timer = setTimeout(() => { connection.pending.delete(id); reject(new Error(`Codex app-server 请求超时：${method}`)); }, REQUEST_TIMEOUT_MILLIS);
      connection.pending.set(id, message => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`Codex app-server ${method} 失败：${message.error.message ?? '未知错误'}`));
        else resolve(message.result);
      });
      connection.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

/** app-server 只监听本机；程序与终端 CLI 共用 Windows PATH/批处理启动规则。 */
export function codexAppServerLaunch(endpoint: string, environment: NodeJS.ProcessEnv = terminalEnvironment(process.env)) {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('Codex app-server 必须使用本机回环地址。');
  return programLaunch('codex', ['app-server', '--listen', endpoint], 'win32', environment);
}
