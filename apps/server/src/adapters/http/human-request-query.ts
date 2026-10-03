import { Check } from 'typebox/value';
import { HumanRequestQuerySchema, type HumanRequestQuery } from '@multivac/contracts';
import { TaskServiceError } from '../../application/task-service.js';

/** 全局和单任务请求列表共用分页校验，拒绝重复参数与隐式数字转换。 */
export function humanRequestQuery(params: URLSearchParams, taskId?: string): HumanRequestQuery {
  const query: Record<string, unknown> = taskId ? { taskId } : {};
  for (const [key, value] of params) {
    if (Object.hasOwn(query, key)) throw new TaskServiceError('INVALID_REQUEST', '人工请求查询参数不能重复。');
    if (key === 'offset' || key === 'limit') {
      if (!/^[0-9]+$/.test(value)) throw new TaskServiceError('INVALID_REQUEST', '人工请求分页参数无效。');
      query[key] = Number(value);
    } else Object.defineProperty(query, key, { value, enumerable: true });
  }
  if (!Check(HumanRequestQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '人工请求查询条件无效。');
  return query;
}
