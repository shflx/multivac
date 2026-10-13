import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageDays } from '@multivac/contracts';
import type { UsageStatisticsService } from '../../application/usage-statistics-service.js';

/** 查询仅接受时间范围和用户时区，拒绝项目筛选与未知参数。 */
export function usageQuery(parameters: URLSearchParams): { days: UsageDays; timeZone: string } {
  for (const key of parameters.keys()) {
    if (!['days', 'timeZone'].includes(key) || parameters.getAll(key).length !== 1) throw new RangeError('统计查询只接受 days 和 timeZone');
  }
  const value = parameters.get('days') ?? '30';
  if (!['7', '30', '90'].includes(value)) throw new RangeError('时间范围只能是近7、30或90天');
  const timeZone = parameters.get('timeZone') ?? 'UTC';
  if (!timeZone || timeZone.length > 100) throw new RangeError('无效时区');
  new Intl.DateTimeFormat('en', { timeZone }).format();
  return { days: Number(value) as UsageDays, timeZone };
}

export function createUsageRequestHandler(service: UsageStatisticsService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/usage') return false;
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    if (request.method !== 'GET') { json(405, { error: { code: 'INVALID_REQUEST', message: '统计只提供读取接口' } }); return true; }
    let query: ReturnType<typeof usageQuery>;
    try { query = usageQuery(url.searchParams); }
    catch { json(400, { error: { code: 'INVALID_REQUEST', message: '统计查询只接受近7/30/90天和有效时区，不支持项目筛选' } }); return true; }
    try { json(200, service.query(query.days, query.timeZone)); }
    catch { json(500, { error: { code: 'INTERNAL_ERROR', message: '用量统计暂时无法读取，请重试' } }); }
    return true;
  };
}
