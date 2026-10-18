import type { McpManagementList, McpService } from '@multivac/contracts';

export class McpRequestError extends Error {
  constructor(message: string, readonly unknown: boolean) { super(message); }
}
export async function mcpApi<T>(path = '', input?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch('/api/mcp' + path, input === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); }
  catch { throw new McpRequestError('请求响应未知；请先读取当前事实，勿重新执行。', true); }
  let body: unknown;
  try { body = await response.json(); } catch { throw new McpRequestError('响应无法核对，请先读取当前事实。', true); }
  if (!response.ok) {
    const error = (body as { error?: { message?: string; code?: string } }).error;
    throw new McpRequestError(error?.message ?? 'MCP 请求未完成。', response.status >= 500 || error?.code === 'result-unknown');
  }
  return body as T;
}
export const mcpCommand = () => crypto.randomUUID();
export async function listMcpServices(): Promise<McpService[]> {
  const result: McpService[] = [];
  let offset: number | null = 0;
  do { const page: McpManagementList = await mcpApi(`?offset=${offset}`); result.push(...page.services); offset = page.nextOffset; } while (offset !== null);
  return result;
}
export function mcpStateLabel(value: string): string {
  return ({ connecting: '正在连接', connected: '已连接', disconnected: '已断开', closing: '正在关闭', closed: '本地已关闭',
    prepared: '等待许可', running: '正在调用', succeeded: '成功', failed: '失败', 'cancel-requested': '已请求取消', cancelled: '已取消', unknown: '结果未知',
    ready: '就绪', unconfigured: '未配置', 'login-required': '需要登录', 'refresh-required': '需要刷新', revoked: '已撤销' } as Record<string, string>)[value] ?? value;
}
export const MCP_EFFECTS = ['read', 'local-write', 'external-write', 'data-transfer'] as const;
export const MCP_EFFECT_LABELS = { read: '读取', 'local-write': '本地写入', 'external-write': '外部写入', 'data-transfer': '数据外传' };
