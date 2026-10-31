import { createPlatformCapabilities } from '../../runtime/platform-capabilities.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { RemoteAccess, accessError } from './remote-access.js';
import { isRemoteRequest } from './remote-policy.js';

export function isTerminalPath(path: string): boolean {
  return path === '/api/terminals' || path.startsWith('/api/terminals/');
}

/** 必须在读取终端、创建进程或附着前调用。HTTP 与 upgrade 采用相同身份及来源门禁。 */
export function terminalEntryDenial(request: IncomingMessage, access: RemoteAccess,
  platform: Pick<NodeJS.Process, 'platform' | 'arch'> = process): string | null {
  const denial = createPlatformCapabilities(platform).denial('terminal');
  if (denial) return denial;
  const identity = access.identify(request);
  if (identity?.kind !== 'local' || !identity.authenticated || isRemoteRequest(request) || !access.allowsLocalEntry(request, true)) {
    return '项目终端只允许有效的本机桌面来源。';
  }
  if (request.headers['sec-ch-ua-mobile'] === '?1' || /Android|iPhone|iPad|iPod|Mobile/iu.test(request.headers['user-agent'] ?? '')) {
    return '项目终端仅支持本机桌面。';
  }
  return null;
}

export function guardTerminalHttp(request: IncomingMessage, response: ServerResponse, access: RemoteAccess): boolean {
  const denial = terminalEntryDenial(request, access);
  if (denial === null) return true;
  accessError(response, 403, 'ACCESS_DENIED', denial);
  return false;
}

/** ws 的 noServer 升级回调须先调用此守卫，通过后才查 terminalId 或调用 handleUpgrade。 */
export function guardTerminalUpgrade(request: IncomingMessage, socket: Duplex, access: RemoteAccess): boolean {
  const denial = terminalEntryDenial(request, access);
  if (denial === null) return true;
  const body = JSON.stringify({ error: { code: 'ACCESS_DENIED', message: denial } });
  socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  return false;
}
