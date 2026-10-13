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
    const warning = this.usage.warning;
    const repo = this.usage.repository;
    return aggregateUsage(repo.records(from, generatedAt), { days, timeZone, now: generatedAt,
      collectionStartedAt: repo.collectionStartedAt(), collectionReliable: warning === null,
      warnings: warning ? [warning] : [], sessionTitle: this.sessionTitle });
  }
}
