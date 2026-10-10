import type { IncomingMessage } from 'node:http';

const GLOBAL_SESSION = 'global-coordinator';
const remoteRequests = new WeakSet<IncomingMessage>();
export function markRemoteRequest(request: IncomingMessage): void { remoteRequests.add(request); }
export function isRemoteRequest(request: IncomingMessage): boolean { return remoteRequests.has(request); }

/** 默认拒绝；匹配方法与完整路径，图片仅允许准确的全局会话 ID。 */
export function remoteRouteAllowed(method: string, path: string): boolean {
  if (method === 'GET' && ['/api/assistant/session', '/api/assistant/page-state', '/api/assistant/tools',
    '/api/assistant/model-selection', '/api/assistant/events', '/api/assistant/authorizations',
    '/api/assistant/proposals', '/api/assistant/confirmations', '/api/events'].includes(path)) return true;
  const confirmation = /^\/api\/assistant\/confirmations\/([^/]+)(?:\/(decision|reconcile))?$/u.exec(path);
  if (confirmation) {
    try {
      if (!/^[A-Za-z0-9._:-]{1,512}$/u.test(decodeURIComponent(confirmation[1]!))) return false;
      return confirmation[2] ? method === 'POST' : method === 'GET';
    } catch { return false; }
  }
  if (method === 'GET' && /^\/api\/assistant\/(?:commands|tools)\/[^/%]+$/u.test(path)) return true;
  if (method === 'PUT' && path === '/api/assistant/page-state') return true;
  if (method === 'POST' && ['/api/assistant/turns', '/api/assistant/turns/current/cancel'].includes(path)) return true;
  if (method === 'POST' && /^\/api\/assistant\/(?:authorizations|proposals)\/[^/%]+\/decision$/u.test(path)) return true;
  if (method === 'POST' && path === `/api/sessions/${GLOBAL_SESSION}/images`) return true;
  if (method === 'GET' && /^\/api\/sessions\/global-coordinator\/images\/[a-f0-9]{64}(?:\/content)?$/u.test(path)) return true;
  return method === 'DELETE' && /^\/api\/sessions\/global-coordinator\/images\/[a-f0-9]{64}$/u.test(path);
}

/** 来源字段是直接请求的资源入口，不允许借正文指定其他会话或读取文件/书籍。 */
export function remoteBodyAllowed(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const value = body as Record<string, unknown>;
  if ('assistantSessionId' in value && value.assistantSessionId !== GLOBAL_SESSION) return false;
  if (value.currentView !== undefined && value.currentView !== null) return false;
  if (value.contextRefs !== undefined && (!Array.isArray(value.contextRefs) || value.contextRefs.length !== 0)) return false;
  const quote = value.quote;
  if (quote !== undefined && quote !== null) {
    if (typeof quote !== 'object') return false;
    const source = quote as Record<string, unknown>;
    if (source.sourceKind !== undefined && source.sourceKind !== 'message') return false;
    if ('sourceFile' in source || 'sourceBook' in source || 'sourceMessage' in source || 'sourceNote' in source) return false;
    if (source.sourceSessionId !== undefined && source.sourceSessionId !== GLOBAL_SESSION) return false;
  }
  return true;
}
