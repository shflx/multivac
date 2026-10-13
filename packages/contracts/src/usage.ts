/** 统计页只接受日历天范围；项目仅是分布维度。 */
export const USAGE_DAYS = [7, 30, 90] as const;
export type UsageDays = (typeof USAGE_DAYS)[number];
export type UsageSource = 'multivac' | 'session' | 'task' | 'unknown';
export type UsageCoverage = 'complete' | 'partial' | 'uncovered';

/** 三段可加总的 token；input 含缓存写入，output 已含推理。 */
export interface UsageTokens {
  input: number;
  cacheRead: number;
  output: number;
  total: number;
}
export interface UsageTotals extends UsageTokens {
  requests: number;
  measuredRequests: number;
  missingRequests: number;
  cacheHitRate: number | null;
}
export interface UsageDaily extends UsageTotals {
  date: string;
  coverage: UsageCoverage;
}
export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
  share: number | null;
}
export interface UsageStatistics {
  days: UsageDays;
  timeZone: string;
  generatedAt: string;
  startDate: string;
  endDate: string;
  summary: UsageTotals;
  previous: UsageTotals;
  delta: number | null;
  dailyAverage: number | null;
  daily: UsageDaily[];
  distributions: { model: UsageGroup[]; project: UsageGroup[]; source: UsageGroup[] };
  topSessions: UsageGroup[];
  coverage: {
    current: UsageCoverage;
    previous: UsageCoverage;
    collectionStartedAt: string;
    history: 'pending' | 'partial' | 'scanned';
    unplacedRequests: number;
    reasons: string[];
  };
}
