import { UsageStatisticsSchema, type UsageDays, type UsageStatistics } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

export function getUsageStatistics(days: UsageDays, signal: AbortSignal): Promise<UsageStatistics> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const parameters = new URLSearchParams({ days: String(days), timeZone });
  return fetchJson(`/api/usage?${parameters}`, { signal }, UsageStatisticsSchema);
}
