import { isLocalLoopbackPeer } from './loopback-peer.js';
import type { IncomingMessage } from 'node:http';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;

export interface LocalEntry {
  hostOrigin: string;
  browserOrigin: string;
}

/** 完整入口白名单：生产只使用当前 API 端口；开发另登记保留 Host 的 Vite 代理入口。 */
export function localEntries(mode: 'development' | 'production', port: number): LocalEntry[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本机入口端口无效。');
  return [...new Set(mode === 'development' ? [port, 5173] : [port])].flatMap(entryPort => LOCAL_HOSTS.map(host => {
    const origin = new URL(`http://${host}:${entryPort}`).origin;
    return { hostOrigin: origin, browserOrigin: origin };
  }));
}

function originUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !LOCAL_HOSTS.includes(url.hostname as typeof LOCAL_HOSTS[number]) || url.origin !== value || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

/** 不使用转发头推断实际对端、协议或端口。HTTP 与 upgrade 共用此规则。 */
export class LocalEntryPolicy {
  private readonly entries: readonly LocalEntry[];

  constructor(entries: readonly LocalEntry[] = []) {
    this.entries = entries.map(entry => {
      if (!originUrl(entry.hostOrigin) || !originUrl(entry.browserOrigin)) throw new Error('本机入口必须是完整的回环 HTTP origin。');
      return { ...entry };
    });
  }

  allows(request: IncomingMessage, requireOrigin = false): boolean {
    if (!isLocalLoopbackPeer(request.socket.remoteAddress ?? '')) return false;
    for (const name of ['host', 'origin']) {
      const occurrences = (request.rawHeaders ?? []).filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
      if (occurrences > 1) return false;
    }
    // 当前服务是原生 HTTP；不依据 X-Forwarded-Proto 接受 HTTPS 本机身份。
    if ((request.socket as { encrypted?: boolean }).encrypted) return false;
    const host = request.headers.host;
    if (!host) return false;
    let endpoint: URL;
    try {
      endpoint = new URL(`http://${host}`);
      if (!LOCAL_HOSTS.includes(endpoint.hostname as typeof LOCAL_HOSTS[number]) || endpoint.username || endpoint.password ||
          endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
          (host.toLowerCase() !== endpoint.host && host.toLowerCase() !== `${endpoint.host}:80`)) return false;
    } catch { return false; }
    const listenerPort = request.socket.localPort;
    const endpointPort = Number(endpoint.port || 80);
    // 动态监听端口也只允许 Host 指向这个真实监听器；额外代理入口必须明确登记。
    const direct = listenerPort !== undefined && endpointPort === listenerPort;
    const registered = this.entries.filter(entry => entry.hostOrigin === endpoint.origin);
    if (!direct && !registered.length) return false;
    const origin = request.headers.origin;
    if (origin === undefined) return !requireOrigin;
    if (!originUrl(origin)) return false;
    return (direct && origin === endpoint.origin) || registered.some(entry => entry.browserOrigin === origin);
  }
}
