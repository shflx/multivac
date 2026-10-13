import { Type } from 'typebox';

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
  description?: string;
  share: number | null;
}
const nonnegative = () => Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableRatio = () => Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
const coverageSchema = () => Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('uncovered')]);
const totalProperties = {
  input: nonnegative(), cacheRead: nonnegative(), output: nonnegative(), total: nonnegative(),
  requests: Type.Integer({ minimum: 0 }), measuredRequests: Type.Integer({ minimum: 0 }), missingRequests: Type.Integer({ minimum: 0 }),
  cacheHitRate: nullableRatio(),
};
const groupSchema = Type.Object({ ...totalProperties, key: Type.String(), label: Type.String(), description: Type.Optional(Type.String()), share: nullableRatio() });
/** 前端使用同一契约校验读取结果；响应不携带费用或原始模型消息。 */
export const UsageStatisticsSchema = Type.Object({
  days: Type.Union([Type.Literal(7), Type.Literal(30), Type.Literal(90)]), timeZone: Type.String(), generatedAt: Type.String(),
  startDate: Type.String(), endDate: Type.String(), summary: Type.Object(totalProperties), previous: Type.Object(totalProperties),
  delta: Type.Union([Type.Number(), Type.Null()]), dailyAverage: Type.Union([nonnegative(), Type.Null()]),
  daily: Type.Array(Type.Object({ ...totalProperties, date: Type.String(), coverage: coverageSchema() }), { maxItems: 90 }),
  distributions: Type.Object({ model: Type.Array(groupSchema), project: Type.Array(groupSchema), source: Type.Array(groupSchema) }),
  topSessions: Type.Array(groupSchema, { maxItems: 5 }),
  coverage: Type.Object({ current: coverageSchema(), previous: coverageSchema(), collectionStartedAt: Type.String(),
    history: Type.Union([Type.Literal('pending'), Type.Literal('partial'), Type.Literal('scanned')]),
    unplacedRequests: Type.Integer({ minimum: 0 }), reasons: Type.Array(Type.String()) }),
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
