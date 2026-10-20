import type { IncomingMessage } from 'node:http';
import type { RequestAccess } from './remote-access.js';
import { isRemoteRequest } from './remote-policy.js';

/** 请求上下文来自 HTTP 身份识别，不接受正文中的“用户点击”声明。 */
export function localFileActionAllowed(request: IncomingMessage, access?: RequestAccess): boolean {
  if (access?.kind !== 'local' || !access.authenticated || isRemoteRequest(request)) return false;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return false;
  if (request.headers['sec-fetch-site'] !== 'same-origin' || request.headers['sec-fetch-dest'] !== 'empty' || !['cors', 'same-origin'].includes(String(request.headers['sec-fetch-mode']))) return false;
  try {
    const origin = new URL(request.headers.origin ?? '');
    return origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.origin === `http://${request.headers.host}`;
  } catch { return false; }
}
