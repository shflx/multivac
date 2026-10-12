/**
 * Token 用量统计：每条记录是某天、某个会话在某个模型上的累计用量。
 * input 只计未命中缓存的输入，cacheRead 是命中缓存的输入，两者与 output 相加为总用量。
 */

export const USAGE_RANGES = [
  { id: '7d', days: 7, label: '近 7 天' },
  { id: '30d', days: 30, label: '近 30 天' },
  { id: '90d', days: 90, label: '近 90 天' },
];
export const DEFAULT_USAGE_RANGE = '30d';

export const USAGE_SOURCE_LABELS = { multivac: 'Multivac 协调', session: '会话', task: '任务执行' };

export const USAGE_DIMENSIONS = [
  { id: 'model', label: '按模型' },
  { id: 'project', label: '按项目' },
  { id: 'source', label: '按来源' },
];

/** 本地日期键 YYYY-MM-DD，统计按用户所在时区切天。 */
export function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shiftDay(key, delta) {
  const [year, month, day] = key.split('-').map(Number);
  return dayKey(new Date(year, month - 1, day + delta));
}

const usageTotal = (record) => record.input + record.output + record.cacheRead;

/**
 * 原型示例数据：几个长期存在的会话按固定规律产生用量，周末明显减少。
 * 用确定的伪随机数，同一天打开原型看到的数据一致。
 */
const USAGE_STREAMS = [
  { sessionId: 'multivac', title: 'Multivac', projectId: null, source: 'multivac', modelId: 'openai-main', base: 42000, cacheRatio: 2.4, since: 180 },
  { sessionId: 'session-restore', title: '修复会话恢复顺序', projectId: 'multivac', source: 'task', modelId: 'openai-main', base: 160000, cacheRatio: 3.2, since: 12 },
  { sessionId: 'settings-copy', title: '设置页文案统一', projectId: 'multivac', source: 'task', modelId: 'openai-main', base: 90000, cacheRatio: 2.6, since: 20 },
  { sessionId: 'vector-research', title: '向量检索方案调研', projectId: 'research', source: 'session', modelId: 'anthropic-main', base: 120000, cacheRatio: 1.8, since: 60 },
  { sessionId: 'reading-notes', title: '整理阅读笔记', projectId: null, source: 'session', modelId: 'openai-fast', base: 30000, cacheRatio: 1.2, since: 120 },
  { sessionId: 'self-model-regression', title: '自建模型回归', projectId: 'multivac', source: 'task', modelId: 'self-responses', base: 70000, cacheRatio: 0.6, since: 45 },
];

function seededRandom(text) {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}

export function seedUsageRecords(today, days = 180) {
  const records = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = shiftDay(today, -offset);
    const weekday = new Date(`${date}T00:00:00`).getDay();
    const weekend = weekday === 0 || weekday === 6;
    for (const stream of USAGE_STREAMS) {
      if (offset >= stream.since) continue;
      const roll = seededRandom(`${date}:${stream.sessionId}`);
      // 大约四分之一的工作日、多数周末这条会话没有活动。
      if (roll < (weekend ? 0.6 : 0.25)) continue;
      const input = Math.round(stream.base * (0.4 + roll) * (weekend ? 0.4 : 1));
      records.push({
        date,
        sessionId: stream.sessionId,
        title: stream.title,
        projectId: stream.projectId,
        source: stream.source,
        modelId: stream.modelId,
        input,
        output: Math.round(input * (0.12 + roll * 0.1)),
        cacheRead: Math.round(input * stream.cacheRatio * (0.7 + roll * 0.5)),
        requests: Math.max(1, Math.round(input / 8000)),
      });
    }
  }
  return records;
}

/** 截取以 today 结尾的 days 天；projectId 为 'all' 时不按项目过滤，null 表示日常（不属于任何项目）。 */
export function usageInRange(records, { today, days, projectId = 'all', offsetDays = 0 }) {
  const end = shiftDay(today, -offsetDays);
  const start = shiftDay(end, -(days - 1));
  return records.filter((record) => record.date >= start && record.date <= end && (projectId === 'all' || record.projectId === projectId));
}

export function summarizeUsage(records) {
  const sum = records.reduce((acc, record) => ({
    input: acc.input + record.input,
    output: acc.output + record.output,
    cacheRead: acc.cacheRead + record.cacheRead,
    requests: acc.requests + record.requests,
  }), { input: 0, output: 0, cacheRead: 0, requests: 0 });
  const prompt = sum.input + sum.cacheRead;
  return { ...sum, total: prompt + sum.output, cacheHitRate: prompt ? sum.cacheRead / prompt : 0 };
}

/** 按天汇总并补齐没有用量的日子，图表横轴始终是连续的 days 天。 */
export function dailyUsage(records, { today, days }) {
  const byDate = new Map();
  for (const record of records) {
    const day = byDate.get(record.date) || { input: 0, output: 0, cacheRead: 0 };
    day.input += record.input;
    day.output += record.output;
    day.cacheRead += record.cacheRead;
    byDate.set(record.date, day);
  }
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDay(today, index - (days - 1));
    const day = byDate.get(date) || { input: 0, output: 0, cacheRead: 0 };
    return { date, ...day, total: day.input + day.output + day.cacheRead };
  });
}

/** 按维度分组，按总用量从高到低；share 是占全部用量的比例。 */
export function groupUsage(records, dimension) {
  const field = { model: 'modelId', project: 'projectId', source: 'source', session: 'sessionId' }[dimension];
  const groups = new Map();
  for (const record of records) {
    const key = record[field] ?? null;
    const group = groups.get(key) || { key, title: record.title, projectId: record.projectId, source: record.source, input: 0, output: 0, cacheRead: 0, requests: 0 };
    group.input += record.input;
    group.output += record.output;
    group.cacheRead += record.cacheRead;
    group.requests += record.requests;
    groups.set(key, group);
  }
  const all = records.reduce((sum, record) => sum + usageTotal(record), 0);
  return [...groups.values()]
    .map((group) => {
      const total = group.input + group.output + group.cacheRead;
      return { ...group, total, share: all ? total / all : 0 };
    })
    .sort((left, right) => right.total - left.total);
}

/** 与上一个等长周期相比的变化比例；上一周期没有用量时无从比较，返回 null。 */
export function usageDelta(current, previous) {
  return previous ? (current - previous) / previous : null;
}

export function formatTokens(value) {
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(2))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(1))}K`;
  return String(value);
}

export function formatShare(ratio) {
  return `${Number((ratio * 100).toFixed(1))}%`;
}
