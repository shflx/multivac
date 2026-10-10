import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REMOTE_COOKIE = 'multivac_remote';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOGIN_TTL = 12 * 60 * 60 * 1000;
const RATE_WINDOW = 60_000;
const MAX_LOGINS = 256;

export interface RemoteAccessConfig {
  enabled: boolean;
  token: string;
  origin: string;
  host: string;
}
export interface RequestAccess {
  kind: 'local' | 'remote';
  authenticated: boolean;
  loginKey: string | null;
}
interface Login { expires: number; connections: Set<() => void>; timer: ReturnType<typeof setTimeout>; }
interface Attempt { start: number; count: number; }

function digest(value: string): Buffer { return createHash('sha256').update(value).digest(); }
function key(value: string): string { return digest(value).toString('hex'); }
function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}
export function validateRemoteConfig(config: RemoteAccessConfig): RemoteAccessConfig {
  if (config.enabled && (Buffer.byteLength(config.token) < 32 || !config.token.trim() || Buffer.byteLength(config.token) > 4096)) {
    throw new Error('开启远程访问需要 32 至 4096 字节的非空 token。');
  }
  if (config.enabled && !validOrigin(config.origin)) throw new Error('MULTIVAC_REMOTE_ORIGIN 必须是完整的 http/https origin，不含路径或凭据。');
  if (config.enabled && LOCAL_HOSTS.has(new URL(config.origin).hostname)) throw new Error('远程 origin 需使用局域网地址或专用域名，本机 localhost 入口保留完整功能。');
  if (config.enabled && !config.host.trim()) throw new Error('远程监听地址不能为空。');
  return { ...config };
}
export function remoteConfigFromEnvironment(environment: NodeJS.ProcessEnv): RemoteAccessConfig {
  const enabled = environment.MULTIVAC_REMOTE_ENABLED === '1';
  if (environment.MULTIVAC_REMOTE_ENABLED && !['0', '1'].includes(environment.MULTIVAC_REMOTE_ENABLED)) {
    throw new Error('MULTIVAC_REMOTE_ENABLED 只能是 0 或 1。');
  }
  return validateRemoteConfig({ enabled, token: environment.MULTIVAC_REMOTE_TOKEN ?? '',
    origin: environment.MULTIVAC_REMOTE_ORIGIN ?? '', host: environment.MULTIVAC_REMOTE_HOST?.trim() || '0.0.0.0' });
}
function cookieCredential(request: IncomingMessage): string | null {
  const entries = (request.headers.cookie ?? '').split(';').map(entry => entry.trim()).filter(entry => entry.startsWith(`${REMOTE_COOKIE}=`));
  if (entries.length !== 1) return null;
  const value = entries[0]!.slice(REMOTE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
function hasRemoteCookie(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? '').split(';').some(entry => entry.trim().startsWith(`${REMOTE_COOKIE}=`));
}
function localRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || hasRemoteCookie(request)) return false;
  try {
    if (!LOCAL_HOSTS.has(new URL(`http://${request.headers.host ?? ''}`).hostname)) return false;
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin);
      if (origin.protocol !== 'http:' || !LOCAL_HOSTS.has(origin.hostname)) return false;
    }
    return true;
  } catch { return false; }
}
export function accessError(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code, message } }));
}
function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** 浏览器登录只授予对话入口；模型工具及业务授权仍由原服务负责。 */
export class RemoteAccess {
  private config: RemoteAccessConfig;
  private readonly logins = new Map<string, Login>();
  private readonly attempts = new Map<string, Attempt>();
  private globalAttempts: Attempt = { start: 0, count: 0 };
  constructor(config: RemoteAccessConfig, private readonly now: () => number = Date.now) {
    this.config = validateRemoteConfig(config);
  }
  settings(): Readonly<RemoteAccessConfig> { return { ...this.config }; }
  configure(config: RemoteAccessConfig): void {
    const next = validateRemoteConfig(config);
    if (next.enabled !== this.config.enabled || next.token !== this.config.token || next.origin !== this.config.origin) this.revokeAll();
    this.config = next;
  }
  close(): void { this.config = { ...this.config, enabled: false }; this.revokeAll(); this.attempts.clear(); }
  private revoke(loginKey: string): void {
    const login = this.logins.get(loginKey);
    if (!login) return;
    this.logins.delete(loginKey);
    clearTimeout(login.timer);
    for (const close of login.connections) close();
    login.connections.clear();
  }
  private revokeAll(): void { for (const loginKey of this.logins.keys()) this.revoke(loginKey); }
  private sameOrigin(request: IncomingMessage): boolean {
    if (!this.config.enabled) return false;
    const expected = new URL(this.config.origin);
    if (request.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return false;
    const origin = request.headers.origin;
    // 图片与页面导航没有 Origin；写请求（包括登录/退出）必须精确同源。
    return origin === undefined ? ['GET', 'HEAD'].includes(request.method ?? '') : origin === this.config.origin;
  }
  identify(request: IncomingMessage): RequestAccess | null {
    if (localRequest(request)) return { kind: 'local', authenticated: true, loginKey: null };
    if (!this.sameOrigin(request)) return null;
    const credential = cookieCredential(request);
    const loginKey = credential ? key(credential) : null;
    const login = loginKey ? this.logins.get(loginKey) : undefined;
    if (login && login.expires <= this.now()) this.revoke(loginKey!);
    return { kind: 'remote', authenticated: Boolean(login && login.expires > this.now()), loginKey };
  }
  /** 各个 SSE 绑定具体登录，撤销时同步清理订阅及传输队列。 */
  bind(access: RequestAccess, close: () => void): () => void {
    if (access.kind === 'local') return () => {};
    const login = access.loginKey ? this.logins.get(access.loginKey) : undefined;
    if (!login || login.expires <= this.now()) { close(); return () => {}; }
    login.connections.add(close);
    return () => login.connections.delete(close);
  }
  private allowAttempt(address: string): boolean {
    const now = this.now();
    for (const [ip, attempt] of this.attempts) if (now - attempt.start >= RATE_WINDOW) this.attempts.delete(ip);
    if (now - this.globalAttempts.start >= RATE_WINDOW) this.globalAttempts = { start: now, count: 0 };
    if (this.globalAttempts.count >= 100) return false;
    this.globalAttempts.count++;
    let attempt = this.attempts.get(address);
    if (!attempt) {
      if (this.attempts.size >= 1024) return false;
      attempt = { start: now, count: 0 }; this.attempts.set(address, attempt);
    }
    return ++attempt.count <= 10;
  }
  private cookie(value: string, expired = false): string {
    return `${REMOTE_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : LOGIN_TTL / 1000}${this.config.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  async handle(request: IncomingMessage, response: ServerResponse, access: RequestAccess): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (['/api/access', '/api/access/login', '/api/access/logout'].includes(path) && url.searchParams.size) {
      accessError(response, 400, 'INVALID_REQUEST', '登录与身份接口不接受 URL 参数。'); return true;
    }
    if (path === '/api/access' && request.method === 'GET') {
      json(response, { kind: access.kind, authenticated: access.authenticated, loginEnabled: this.config.enabled }); return true;
    }
    if (!['/api/access/login', '/api/access/logout'].includes(path)) return false;
    if (access.kind !== 'remote' || request.method !== 'POST' || !this.sameOrigin(request)) {
      accessError(response, 403, 'ACCESS_DENIED', '该操作仅供同源远程登录入口使用。'); return true;
    }
    if (path.endsWith('/logout')) {
      if (access.loginKey) this.revoke(access.loginKey);
      response.setHeader('set-cookie', this.cookie('', true)); json(response, { ok: true }); return true;
    }
    if (!this.allowAttempt(request.socket.remoteAddress ?? 'unknown')) {
      response.setHeader('retry-after', String(Math.ceil(RATE_WINDOW / 1000)));
      accessError(response, 429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后重试。'); return true;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      accessError(response, 415, 'INVALID_REQUEST', '登录请求需要 application/json。'); return true;
    }
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.length;
        if (bytes > 8192) { accessError(response, 413, 'BODY_TOO_LARGE', '登录请求过大。'); return true; }
        chunks.push(data);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body !== 'object' || body === null || Object.keys(body).length !== 1 || !('token' in body) || typeof body.token !== 'string' || body.token.length > 4096) {
        accessError(response, 400, 'INVALID_REQUEST', '登录请求格式无效。'); return true;
      }
      // 读取正文会让出事件循环，关闭/切换地址后不能再签发登录。
      if (!this.sameOrigin(request)) {
        accessError(response, 403, 'ACCESS_DENIED', '外部访问已关闭或来源已变更。'); return true;
      }
      if (!timingSafeEqual(digest(body.token), digest(this.config.token))) {
        accessError(response, 401, 'LOGIN_FAILED', '访问 token 不正确。'); return true;
      }
      // 上限固定；清除已到期登录，不逐出其他有效用户的连接。
      for (const [loginKey, login] of this.logins) if (login.expires <= this.now()) this.revoke(loginKey);
      if (this.logins.size >= MAX_LOGINS) { accessError(response, 429, 'LOGIN_RATE_LIMITED', '有效登录数量已达上限。'); return true; }
      if (access.loginKey) this.revoke(access.loginKey);
      const credential = randomBytes(32).toString('base64url'); const loginKey = key(credential);
      const timer = setTimeout(() => this.revoke(loginKey), LOGIN_TTL); timer.unref();
      this.logins.set(loginKey, { expires: this.now() + LOGIN_TTL, connections: new Set(), timer });
      response.setHeader('set-cookie', this.cookie(credential)); json(response, { ok: true });
    } catch { accessError(response, 400, 'INVALID_REQUEST', '登录请求格式无效。'); }
    return true;
  }
}
