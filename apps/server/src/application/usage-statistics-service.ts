import type { UsageDays, UsageStatistics } from '@multivac/contracts';
import type { ModelUsageService } from './model-usage-service.js';
import { aggregateUsage, shiftUsageDate, usageCalendar } from '../modules/usage/aggregate-usage.js';

export class UsageStatisticsService {
  constructor(private readonly usage: ModelUsageService, private readonly sessionTitle: (id: string) => string | undefined,
    private readonly now = () => new Date().toISOString()) {}
  query(days: UsageDays, timeZone: string): UsageStatistics {
    const generatedAt = this.now();
    const calendar = usageCalendar(timeZone);
    const today = calendar.dateKey(Date.parse(generatedAt));
    const from = new Date(calendar.midnight(shiftUsageDate(today, 1 - days * 2))).toISOString();
    this.usage.touch();
    const repo = this.usage.repository;
    const history = repo.meta('history');
    const reasons: string[] = [];
    try {
      const value: unknown = JSON.parse(repo.meta('historyReasons') ?? '[]');
      if (Array.isArray(value)) reasons.push(...value.filter((item): item is string => typeof item === 'string'));
    } catch { reasons.push('历史覆盖说明暂时不可读取'); }
    for (const key of ['collectionFailure', 'markerFailure']) { const reason = repo.meta(key); if (reason) reasons.push(reason); }
    const installed = repo.meta('collectorInstalled') === 'yes';
    if (!installed) reasons.push('当前适配器没有接入真实模型用量采集');
    if (history === 'pending') reasons.push('历史用量仍在核对和回补');
    return aggregateUsage(repo.records(from, generatedAt), { days, timeZone, now: generatedAt,
      collectionStartedAt: repo.meta('collectionStartedAt')!, intervals: installed ? repo.intervals() : [],
      collectionReliable: installed && !repo.meta('collectionFailure') && !repo.meta('markerFailure'),
      history: history === 'scanned' ? 'scanned' : history === 'partial' ? 'partial' : 'pending', reasons,
      unplacedRequests: repo.unplacedCount() + Number(repo.meta('historyUnplaced') ?? 0), sessionTitle: this.sessionTitle });
  }
}
