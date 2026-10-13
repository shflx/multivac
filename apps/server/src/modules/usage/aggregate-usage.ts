import type { UsageCoverage, UsageDays, UsageDaily, UsageGroup, UsageStatistics, UsageTotals } from '@multivac/contracts';
import type { UsageRecord } from './model-usage.js';

const empty = (): UsageTotals => ({ input: 0, cacheRead: 0, output: 0, total: 0, requests: 0, measuredRequests: 0, missingRequests: 0, cacheHitRate: null });
const sourceLabels = { multivac: 'Multivac 协调', session: '会话', task: '任务执行', unknown: '未知来源' };
const add = (sum: UsageTotals, record: UsageRecord) => {
  sum.requests++;
  if (!record.tokens) { sum.missingRequests++; return; }
  sum.measuredRequests++;
  for (const field of ['input', 'cacheRead', 'output', 'total'] as const) {
    sum[field] += record.tokens[field];
    if (!Number.isSafeInteger(sum[field])) throw new Error('用量累计超出安全整数范围');
  }
  const prompt = sum.input + sum.cacheRead;
  sum.cacheHitRate = prompt > 0 ? sum.cacheRead / prompt : null;
};
export function shiftUsageDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 使用日历日而非24小时窗口；二分寻找该IANA时区日期首次出现的时刻，兼容DST。 */
export function usageCalendar(timeZone: string) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateKey = (time: number): string => {
    const parts = format.formatToParts(new Date(time));
    const part = (kind: string) => parts.find(item => item.type === kind)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const midnight = (key: string): number => {
    const center = Date.parse(`${key}T00:00:00.000Z`);
    let low = center - 36 * 60 * 60 * 1000, high = center + 36 * 60 * 60 * 1000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (dateKey(middle) < key) low = middle + 1; else high = middle;
    }
    return low;
  };
  return { dateKey, midnight };
}

export interface AggregateUsageOptions {
  days: UsageDays;
  timeZone: string;
  now: string;
  collectionStartedAt: string;
  intervals: { start: string; end: string }[];
  history: UsageStatistics['coverage']['history'];
  reasons: string[];
  collectionReliable: boolean;
  unplacedRequests?: number;
  sessionTitle?: (id: string) => string | undefined;
}

export function aggregateUsage(records: readonly UsageRecord[], options: AggregateUsageOptions): UsageStatistics {
  const { days, timeZone, now } = options;
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error('无效统计时刻');
  const calendar = usageCalendar(timeZone);
  const endDate = calendar.dateKey(at), startDate = shiftUsageDate(endDate, 1 - days);
  const previousStart = shiftUsageDate(startDate, -days);
  const dates = Array.from({ length: days * 2 }, (_, index) => shiftUsageDate(previousStart, index));
  const byDay = new Map(dates.map(date => [date, empty()]));
  const current: UsageRecord[] = [], previousRecords: UsageRecord[] = [];
  let unplaced = options.unplacedRequests ?? 0;
  for (const record of records) {
    const timestamp = record.startedAt === null ? NaN : Date.parse(record.startedAt);
    if (!Number.isFinite(timestamp)) { unplaced++; continue; }
    if (timestamp > at) continue;
    const date = calendar.dateKey(timestamp);
    const day = byDay.get(date);
    if (!day) continue;
    add(day, record);
    (date >= startDate ? current : previousRecords).push(record);
  }
  const intervals = options.intervals.map(interval => ({ start: Date.parse(interval.start), end: Math.min(at, Date.parse(interval.end)) })).sort((a, b) => a.start - b.start);
  const dailyAll: UsageDaily[] = dates.map(date => {
    const value = byDay.get(date)!;
    const start = calendar.midnight(date), end = Math.min(at, calendar.midnight(shiftUsageDate(date, 1)));
    let reached = start, overlaps = false;
    for (const interval of intervals) {
      if (interval.end <= start || interval.start >= end) continue;
      overlaps = true;
      if (interval.start <= reached) reached = Math.max(reached, interval.end);
    }
    const complete = options.collectionReliable && unplaced === 0 && reached >= end && value.missingRequests === 0;
    const coverage: UsageCoverage = complete ? 'complete' : overlaps || value.requests > 0 ? 'partial' : 'uncovered';
    return { date, ...value, coverage };
  });
  const periodCoverage = (period: UsageDaily[]): UsageCoverage => period.every(day => day.coverage === 'complete') ? 'complete' : period.every(day => day.coverage === 'uncovered') ? 'uncovered' : 'partial';
  const daily = dailyAll.slice(days), previousDaily = dailyAll.slice(0, days);
  const coverageCurrent = periodCoverage(daily), coveragePrevious = periodCoverage(previousDaily);
  const summarize = (items: readonly UsageRecord[]) => { const sum = empty(); for (const record of items) add(sum, record); return sum; };
  const summary = summarize(current), previous = summarize(previousRecords);
  const group = (dimension: 'model' | 'project' | 'source' | 'session'): UsageGroup[] => {
    const groups = new Map<string, UsageGroup>();
    for (const record of current) {
      const key = dimension === 'model' ? JSON.stringify([record.provider, record.modelId])
        : dimension === 'project' ? !record.projectKnown ? 'unknown' : record.projectId === null ? 'none' : `project:${record.projectId}`
        : dimension === 'source' ? record.source : record.sessionId;
      const label = dimension === 'model' ? record.modelId ? `${record.provider ?? '未知提供方'} / ${record.modelId}` : '未知模型'
        : dimension === 'project' ? !record.projectKnown ? '未知项目归属' : record.projectId === null ? '日常（无项目）' : record.projectName ?? record.projectId
        : dimension === 'source' ? sourceLabels[record.source] : options.sessionTitle?.(record.sessionId) ?? record.sessionTitle;
      const item = groups.get(key) ?? { key, label, share: null, ...empty() };
      add(item, record); groups.set(key, item);
    }
    return [...groups.values()].map(item => ({ ...item, share: summary.total > 0 ? item.total / summary.total : null }))
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  };
  const reasons = [...options.reasons];
  if (coverageCurrent !== 'complete') reasons.push('所选日期包含未覆盖时段或缺失 usage，总量仅代表已记录用量');
  if (summary.missingRequests) reasons.push(`${summary.missingRequests} 次已观测请求没有可确认的 usage`);
  if (unplaced) reasons.push(`${unplaced} 条历史记录无法按可信时间定位`);
  return { days, timeZone, generatedAt: now, startDate, endDate, summary, previous,
    delta: coverageCurrent === 'complete' && coveragePrevious === 'complete' && previous.total > 0 ? (summary.total - previous.total) / previous.total : null,
    dailyAverage: coverageCurrent === 'complete' ? summary.total / days : null,
    daily, distributions: { model: group('model'), project: group('project'), source: group('source') },
    topSessions: group('session').filter(item => item.measuredRequests > 0).slice(0, 5),
    coverage: { current: coverageCurrent, previous: coveragePrevious, collectionStartedAt: options.collectionStartedAt,
      history: options.history, unplacedRequests: unplaced, reasons: [...new Set(reasons)] } };
}
