import { isIP } from 'node:net';

/** 规范化同一个回环对端的 IPv6/映射写法；Host/Origin 仍只接受原有明确入口。 */
export function isLocalLoopbackPeer(address: string): boolean {
  if (isIP(address) === 4) return address === '127.0.0.1';
  if (isIP(address) !== 6 || address.includes('%')) return false;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname;
    return canonical === '[::1]' || canonical === '[::ffff:7f00:1]';
  } catch { return false; }
}
export function listenerHttpUrl(address: string, port: number): string {
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}
