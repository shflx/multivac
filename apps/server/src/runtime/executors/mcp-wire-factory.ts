import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { McpWireFactory, McpConnectionContext } from '../../modules/mcp/connections.js';
import { McpHttpWire, McpStdioWire, type McpStdioChannel } from '../../modules/mcp/client.js';
import { McpError, mcpCanonical, type McpRepository } from '../../modules/mcp/mcp.js';
import { McpRules } from '../../modules/mcp/rules.js';
import type { McpExecutionHost } from '../../application/mcp-execution-service.js';
import type { McpAccountService } from '../../application/mcp-account-service.js';
import { MCP_STDIO_SUPERVISOR } from './mcp-stdio-supervisor.js';

/**
 * 服务端拥有的传输装配；账号只在私有边界注入。
 * stdio 使用工作会话 bash 同一托管方式，任务另加 Run 租约与额度，
 * 以用户身份运行在独立进程组中，可联网、可派生子进程，靠登记启用、连接确认与逐次调用许可把关。
 */
export function mcpWireFactory(host: McpExecutionHost, accounts: Pick<McpAccountService, 'credentials' | 'assertCurrent'>, protectedPaths: readonly string[], repository: McpRepository): McpWireFactory {
  const rules = new McpRules(repository);
  return { async assertCatalog(service, account, catalog) {
    const credentials = await accounts.credentials(account.accountId, account.revision), text = mcpCanonical(catalog);
    accounts.assertCurrent(service.serviceId, service.revision, account.accountId, account.revision);
    const secrets = [...Object.values(credentials.environment), ...Object.values(credentials.headers).flatMap(value => [value, value.replace(/^Bearer /u, '')])].filter(Boolean);
    if (secrets.some(value => text.includes(JSON.stringify(value).slice(1, -1)))) throw new McpError('credential-unavailable', '服务目录包含私有凭据，未保存或展示该目录。');
  }, async open(service, account, context, signal) {
    const initial = host.context(context.sessionId, null);
    const verify = () => {
      const current = host.context(context.sessionId, null);
      if (!host.transport(service, current) || current.workingDirectory !== initial.workingDirectory
        || current.projectId !== initial.projectId || current.runId !== initial.runId) throw new McpError('rule-denied', 'MCP 连接的宿主、目录或传输权限已变化。');
      // realpath 每次核对，不能在连接后换入目录外的符号链接。
      if (realpathSync(current.workingDirectory) !== current.workingDirectory) throw new McpError('identity-changed', 'MCP 执行目录真实路径已变化。');
      accounts.assertCurrent(service.serviceId, service.revision, account.accountId, account.revision);
      const effective = rules.resolve(service.serviceId, { ...current, accountId: account.accountId, transportAllowed: true });
      if (!effective.available) throw new McpError('rule-denied', effective.details.join('；'));
    };
    if (service.transport.kind === 'streamable-http') return new McpHttpWire(service.transport.url, {
      authorize: async url => { await verify(); if (service.transport.kind !== 'streamable-http' || url !== service.transport.url) throw new McpError('rule-denied', 'MCP 网络地址已变化。'); },
      credentials: async () => (await accounts.credentials(account.accountId, account.revision)).headers,
      assertCurrent: () => verify(),
    });
    if (service.transport.kind !== 'stdio') throw new McpError('unsupported-transport', '不支持旧 HTTP+SSE。');
    const transport = service.transport;
    return new McpStdioWire(async () => {
      await verify();
      if (transport.cwd !== null && await realpath(transport.cwd) !== initial.workingDirectory)
        throw new McpError('rule-denied', 'stdio 的 cwd 必须等于本会话实际工作目录。');
      const credentials = await accounts.credentials(account.accountId, account.revision);
      verify();
      if (signal?.aborted) throw new McpError('cancelled', 'MCP 连接已取消。');
      if (Object.keys(credentials.environment).some(key => !transport.environmentKeys.includes(key))) throw new McpError('credential-unavailable', 'MCP 私有环境不适用。');
      return supervisedChannel(transport.command, transport.args, initial.workingDirectory, credentials.environment, verify, initial.host === 'task' ? {host, context} : undefined);
    });
  } };
}
/** 工作会话与全局对话沿用 bash 的环境白名单，不继承服务端模型密钥；私有凭据不能覆盖这些运行环境。 */
const SESSION_ENVIRONMENT = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME', 'TERM'];

/** 经监护器启动的 stdio：关闭时等监护器确认整个进程组退出；单条消息上限由 McpStdioWire 约束。 */
function supervisedChannel(command: string, args: string[], directory: string, environment: Record<string, string>, verify: () => void, task?: { host: McpExecutionHost; context: McpConnectionContext }): McpStdioChannel {
  verify();
  const env: NodeJS.ProcessEnv = { ...environment };
  for (const key of SESSION_ENVIRONMENT) { delete env[key]; if (process.env[key]) env[key] = process.env[key]; }
  const marker = `mcp-connection:${randomUUID()}`;
  const limit = task?.host.lease(task.context.sessionId, 'starting', marker, 0);
  let bytes = 0;
  const child = spawn(process.execPath, ['-e', MCP_STDIO_SUPERVISOR, JSON.stringify({ command, args, cwd: directory, graceMillis: 1000 })], {
    cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let ended = false, failure: unknown;
  const dataListeners = new Set<(bytes: Uint8Array) => void>(), exits = new Set<() => void>();
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', () => { failure = new McpError('connection-failed', 'MCP stdio 监护器未启动。'); });
    child.once('close', (code, signal) => {
      ended = true; for (const exit of exits) exit();
      if (code === 127 && !failure) failure = new McpError('connection-failed', 'MCP stdio 命令未能启动，请核对命令与 PATH。');
      const proven = !signal && (code === 0 || code === 127);
      if (!proven) failure = new McpError('result-unknown', 'MCP 监护器未提供进程树停止证明，保留原运行占用。');
      if (proven) { try { task?.host.lease(task.context.sessionId, 'settled', marker, 0); } catch (error) { failure = error; } }
      if (failure) reject(failure); else resolve();
    });
  });
  void closed.catch(() => {});
  const count = (size: number) => {
    bytes += size;
    try {
      if (task && (task.host.lease(task.context.sessionId, 'progress', marker, size) <= 0 || bytes > limit!)) throw new Error('MCP 连接额度已耗尽。');
      return true;
    } catch { child.stdin.end(); child.kill('SIGTERM'); return false; }
  };
  child.stdout.on('data', (chunk: Buffer) => { if (count(chunk.length)) for (const data of dataListeners) data(chunk); });
  // stderr 只排空，不落入公开日志、事件或模型上下文。
  child.stderr.on('data', (chunk: Buffer) => { count(chunk.length); });
  child.stdin.on('error', () => {});
  return {
    listen(data, exit) { dataListeners.add(data); exits.add(exit); if (ended) queueMicrotask(exit); return () => { dataListeners.delete(data); exits.delete(exit); }; },
    async write(value, beforeSend) {
      verify();
      if (ended) throw new McpError('connection-failed', 'MCP stdio 已退出。');
      if (!count(Buffer.byteLength(value))) throw new McpError('cancelled', 'MCP 连接额度已耗尽。');
      beforeSend?.();
      await new Promise<void>((resolve, reject) => child.stdin.write(value, error => error ? reject(new McpError('connection-failed', 'MCP stdio 写入失败。')) : resolve()));
    },
    // 关闭输入并请求监护器停止进程组；只有监护器确认组内无存活成员后退出，才视为已停止。
    async close() { if (!ended) { child.stdin.end(); child.kill('SIGTERM'); } await closed; },
  };
}
