import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpWireFactory, McpConnectionContext } from '../../modules/mcp/connections.js';
import { McpHttpWire, McpStdioWire, type McpStdioChannel } from '../../modules/mcp/client.js';
import { McpError, mcpCanonical, type McpRepository } from '../../modules/mcp/mcp.js';
import { McpRules } from '../../modules/mcp/rules.js';
import type { McpExecutionHost } from '../../application/mcp-execution-service.js';
import type { McpAccountService } from '../../application/mcp-account-service.js';
import { NativeTaskTools } from './native-task-tools.js';

/** 服务端拥有的传输装配；stdio 一律复用原生隔离，账号只在私有边界注入。 */
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
      if (!isAbsolute(transport.command) || transport.cwd !== null && await realpath(transport.cwd) !== initial.workingDirectory)
        throw new McpError('rule-denied', 'stdio 需要绝对可执行路径，cwd 必须等于本会话实际工作目录。');
      const native = await NativeTaskTools.create(initial.workingDirectory, protectedPaths);
      const credentials = await accounts.credentials(account.accountId, account.revision);
      await verify();
      if (signal?.aborted) { native.dispose(); throw new McpError('cancelled', 'MCP 连接已取消。'); }
      if (Object.keys(credentials.environment).some(key => !transport.environmentKeys.includes(key))) { native.dispose(); throw new McpError('credential-unavailable', 'MCP 私有环境不适用。'); }
      try { return channel(transport.command, transport.args, credentials.environment, context, host, native, verify); }
      catch (error) { native.dispose(); throw error; }
    });
  } };
}
function channel(command: string, args: string[], environment: Record<string, string>, context: McpConnectionContext, host: McpExecutionHost, native: NativeTaskTools, verify: () => void): McpStdioChannel {
  verify();
  const marker = `mcp-connection:${randomUUID()}`, limit = Math.min(2_000_000, host.lease(context.sessionId, 'starting', marker, 0));
  const child = spawn('/usr/bin/sandbox-exec', ['-p', native.managedProfile(null, host.context(context.sessionId, null).host === 'coordinator'), command, ...args], {
    cwd: native.directory, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: native.directory, TMPDIR: native.directory, LANG: 'en_US.UTF-8', OPENSSL_CONF: '/dev/null', ...environment },
  });
  let bytes = 0, ended = false, failure: unknown;
  const dataListeners = new Set<(bytes: Uint8Array) => void>(), exits = new Set<() => void>();
  const count = (size: number) => { bytes += size; if (bytes > limit) child.kill('SIGKILL'); return bytes <= limit; };
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', () => { failure = new McpError('connection-failed', 'MCP stdio 进程未启动。'); });
    child.once('close', () => {
      ended = true; native.dispose(); for (const exit of exits) exit();
      try { host.lease(context.sessionId, 'settled', marker, bytes); } catch (error) { failure = error; }
      if (failure) reject(failure); else resolve();
    });
  });
  void closed.catch(() => {});
  child.stdout.on('data', (chunk: Buffer) => { if (count(chunk.length)) for (const data of dataListeners) data(chunk); });
  // stderr 只计额度并排空，不落入公开日志、事件或模型上下文。
  child.stderr.on('data', (chunk: Buffer) => { count(chunk.length); });
  child.stdin.on('error', () => {});
  return {
    listen(data, exit) { dataListeners.add(data); exits.add(exit); if (ended) queueMicrotask(exit); return () => { dataListeners.delete(data); exits.delete(exit); }; },
    async write(value, beforeSend) {
      verify();
      if (ended || !count(Buffer.byteLength(value))) throw new McpError('connection-failed', 'MCP stdio 已退出或超过额度。');
      beforeSend?.();
      await new Promise<void>((resolve, reject) => child.stdin.write(value, error => error ? reject(new McpError('connection-failed', 'MCP stdio 写入失败。')) : resolve()));
    },
    async close() { if (!ended) child.kill('SIGKILL'); await closed; },
  };
}
