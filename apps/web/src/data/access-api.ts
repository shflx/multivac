export interface AccessIdentity { kind: 'local' | 'remote'; authenticated: boolean; loginEnabled: boolean; }

export class AccessIdentityError extends Error {
  constructor(readonly status: number) { super('远程入口不可用，请检查外部访问配置和访问地址。'); }
}
export async function readAccessIdentity(): Promise<AccessIdentity> {
  const response = await fetch('/api/access', { cache: 'no-store' });
  if (!response.ok) throw new AccessIdentityError(response.status);
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || !('kind' in value) || !['local', 'remote'].includes(String(value.kind)) ||
    !('authenticated' in value) || typeof value.authenticated !== 'boolean' || !('loginEnabled' in value) || typeof value.loginEnabled !== 'boolean') {
    throw new Error('访问身份响应无效。');
  }
  return value as AccessIdentity;
}
export async function loginRemote(token: string): Promise<void> {
  const response = await fetch('/api/access/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  if (response.ok) return;
  throw new Error(response.status === 429 ? '登录尝试过于频繁，请稍后再试。' : response.status === 401 ? '访问 token 不正确。' : '登录失败，请检查访问地址和配置。');
}
export async function logoutRemote(): Promise<void> {
  const response = await fetch('/api/access/logout', { method: 'POST' });
  if (!response.ok) throw new Error('退出结果尚未确认，请重试。');
}
export function notifyAccessFailure(response: Response): void {
  if (response.status === 401 || response.status === 403) window.dispatchEvent(new Event('multivac.access-check'));
}
