import { Type } from 'typebox';

/** 统计页只接受日历天范围；项目仅是分布维度。 */
export const USAGE_DAYS = [7, 30, 90] as const;
export type UsageDays = (typeof USAGE_DAYS)[number];
export type UsageSource = 'multivac' | 'session' | 'task' | 'unknown';

/** 三段可加总的 token；input 含缓存写入，output 已含推理。 */
export interface UsageTokens {
  input: number;
  cacheRead: number;
  output: number;
  total: number;
}
export interface UsageTotals extends UsageTokens {
  /** 所有已观测调用，包括未计入测量或缺失的失败、取消及待返回调用。 */
  requests: number;
  /** 有可信有效用量的调用数，包含返回正数用量的失败或取消调用。 */
  measuredRequests: number;
  /** 成功结束但没有有效用量的调用数；失败、取消及所有待返回调用不计缺失。 */
  missingRequests: number;
  cacheHitRate: number | null;
}
export interface UsageDaily extends UsageTotals { date: string; }
export interface UsageGroup extends UsageTotals {
  key: string;
  label: string;
  description?: string;
  share: number | null;
}
const nonnegative = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableRatio = () => Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
const totalProperties = {
  input: nonnegative(), cacheRead: nonnegative(), output: nonnegative(), total: nonnegative(),
  requests: nonnegative(), measuredRequests: nonnegative(), missingRequests: nonnegative(),
  cacheHitRate: nullableRatio(),
};
const groupSchema = Type.Object({ ...totalProperties, key: Type.String(), label: Type.String(), description: Type.Optional(Type.String()), share: nullableRatio() });
/** 只描述新调用账本的统计结果，缺失用量以请求数和简短提示呈现。 */
export const UsageStatisticsSchema = Type.Object({
  days: Type.Union([Type.Literal(7), Type.Literal(30), Type.Literal(90)]), timeZone: Type.String(), generatedAt: Type.String(),
  startDate: Type.String(), endDate: Type.String(), summary: Type.Object(totalProperties), previous: Type.Object(totalProperties),
  delta: Type.Union([Type.Number(), Type.Null()]), dailyAverage: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  statisticsDays: Type.Integer({ minimum: 0, maximum: 90 }),
  daily: Type.Array(Type.Object({ ...totalProperties, date: Type.String() }), { minItems: 7, maxItems: 90 }),
  distributions: Type.Object({ model: Type.Array(groupSchema), project: Type.Array(groupSchema), source: Type.Array(groupSchema) }),
  topSessions: Type.Array(groupSchema, { maxItems: 5 }), warnings: Type.Array(Type.String()),
});
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
  /** 所选范围内实际启用采集的日历天数，用作日均分母。 */
  statisticsDays: number;
  daily: UsageDaily[];
  distributions: { model: UsageGroup[]; project: UsageGroup[]; source: UsageGroup[] };
  topSessions: UsageGroup[];
  warnings: string[];
}
