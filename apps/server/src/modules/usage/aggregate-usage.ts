import type { UsageDays, UsageDaily, UsageGroup, UsageStatistics, UsageTotals } from '@multivac/contracts';
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
  collectionStartedAt: string | null;
  collectionReliable: boolean;
  warnings?: string[];
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
  const byDay = new Map<string, UsageTotals>(dates.map(date => [date, empty()]));
  const current: UsageRecord[] = [], previousRecords: UsageRecord[] = [];
  const collectionAt = options.collectionStartedAt === null ? Infinity : Date.parse(options.collectionStartedAt);
  if (Number.isNaN(collectionAt)) throw new Error('无效采集时间');
  for (const record of records) {
    const timestamp = Date.parse(record.startedAt);
    if (!Number.isFinite(timestamp)) throw new Error('无效调用时间');
    if (timestamp < collectionAt || timestamp > at) continue;
    const date = calendar.dateKey(timestamp);
    const day = byDay.get(date);
    if (!day) continue;
    add(day, record);
    (date >= startDate ? current : previousRecords).push(record);
  }
  // 没有新调用的日期正常显示零，采集启用时间只用于计算日均和可比较周期。
  const daily: UsageDaily[] = dates.slice(days).map(date => ({ date, ...byDay.get(date)! }));
  const collectionDate = Number.isFinite(collectionAt) ? calendar.dateKey(collectionAt) : null;
  const statisticsDays = collectionAt <= at && collectionDate ? daily.filter(day => day.date >= collectionDate).length : 0;
  const summarize = (items: readonly UsageRecord[]) => { const sum = empty(); for (const record of items) add(sum, record); return sum; };
  const summary = summarize(current), previous = summarize(previousRecords);
  const group = (dimension: 'model' | 'project' | 'source' | 'session'): UsageGroup[] => {
    const groups = new Map<string, UsageGroup>();
    const sessionContext = new Map<string, { projects: Map<string, string>; sources: Set<string> }>();
    for (const record of current) {
      const key = dimension === 'model' ? JSON.stringify([record.provider, record.modelId])
        : dimension === 'project' ? !record.projectKnown ? 'unknown' : record.projectId === null ? 'none' : `project:${record.projectId}`
        : dimension === 'source' ? record.source : record.sessionId;
      const label = dimension === 'model' ? `${record.provider ?? '未知提供方'} / ${record.modelId ?? '未知模型'}`
        : dimension === 'project' ? !record.projectKnown ? '未知项目归属' : record.projectId === null ? '日常（无项目）' : record.projectName ?? record.projectId
        : dimension === 'source' ? sourceLabels[record.source] : options.sessionTitle?.(record.sessionId) ?? record.sessionTitle;
      const item = groups.get(key) ?? { key, label, share: null, ...empty() };
      add(item, record); groups.set(key, item);
      if (dimension === 'session') {
        const context = sessionContext.get(key) ?? { projects: new Map<string, string>(), sources: new Set<string>() };
        const projectKey = !record.projectKnown ? 'unknown' : record.projectId === null ? 'none' : `project:${record.projectId}`;
        context.projects.set(projectKey, !record.projectKnown ? '未知项目归属' : record.projectId === null ? '日常（无项目）' : record.projectName ?? record.projectId);
        context.sources.add(sourceLabels[record.source]); sessionContext.set(key, context);
      }
    }
    return [...groups.values()].map(item => {
      const context = sessionContext.get(item.key);
      return { ...item, share: summary.total > 0 ? item.total / summary.total : null,
        ...(context ? { description: `${context.projects.size === 1 ? [...context.projects.values()][0] : '多个项目归属'} · ${context.sources.size === 1 ? [...context.sources][0] : '多个来源'}` } : {}) };
    })
      .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  };
  const warnings = [...(options.warnings ?? [])];
  if (summary.missingRequests) warnings.push(`有 ${summary.missingRequests} 次请求未返回可确认的用量。`);
  const currentReliable = options.collectionReliable && summary.missingRequests === 0;
  const previousComparable = collectionAt <= calendar.midnight(previousStart) && previous.missingRequests === 0;
  return { days, timeZone, generatedAt: now, startDate, endDate, summary, previous, statisticsDays,
    delta: currentReliable && previousComparable && previous.total > 0 ? (summary.total - previous.total) / previous.total : null,
    dailyAverage: currentReliable ? statisticsDays > 0 ? summary.total / statisticsDays : 0 : null,
    daily, distributions: { model: group('model'), project: group('project'), source: group('source') },
    topSessions: group('session').filter(item => item.measuredRequests > 0).slice(0, 5),
    warnings: [...new Set(warnings)] };
}
