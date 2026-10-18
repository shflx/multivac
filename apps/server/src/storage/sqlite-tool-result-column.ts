import type { AssistantToolResult } from '@multivac/contracts';
import { AssistantToolResultSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { migrateLegacyManagementReceipt } from './legacy-management-receipt.js';

/** 内部工具公开的结果：读出时再按契约白名单校验一次，不合格的按没有结果处理。 */
export function toolResultFromJson(value: string | null): AssistantToolResult | null {
  if (value === null) return null;
  try {
    const parsed = migrateLegacyManagementReceipt(JSON.parse(value));
    return Check(AssistantToolResultSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}
