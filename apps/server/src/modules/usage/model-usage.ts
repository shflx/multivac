import type { UsageSource, UsageTokens } from '@multivac/contracts';

export interface UsageIdentity {
  sessionId: string;
  sessionTitle: string;
  piSessionId: string;
  provider: string | null;
  modelId: string | null;
  projectId: string | null;
  projectKnown: boolean;
  projectName: string | null;
  source: UsageSource;
}
export interface UsageRecord extends UsageIdentity {
  requestId: string;
  startedAt: string;
  outcome: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  tokens: UsageTokens | null;
  raw: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null; totalTokens: number } | null;
  missingReason: string | null;
}
/** 模型调用的独立账本；归档、改名和删除会话不会抹去调用事实。 */
export interface UsageRepository {
  /** 首次接入真实采集时登记一次，重启沿用，用于日均与环比的计算。 */
  startCollection(at: string): void;
  collectionStartedAt(): string | null;
  put(record: UsageRecord): void;
  records(start?: string, end?: string): UsageRecord[];
}

export interface ModelUsageRecorder {
  begin(sessionId: string, piSessionId: string, model: unknown): (message?: unknown, error?: unknown) => void;
}
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const token = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** 不根据费用或 total 差额猜字段；不符合三段分解的 SDK 记录保留为缺失。 */
export function measuredUsage(message: unknown): Pick<UsageRecord, 'tokens' | 'raw' | 'missingReason' | 'outcome'> {
  const stop = isObject(message) ? message.stopReason : undefined;
  const outcome = stop === 'aborted' ? 'cancelled' : stop === 'error' || !isObject(message) || message.role !== 'assistant' ? 'failed' : 'succeeded';
  const missing = (reason: string): ReturnType<typeof measuredUsage> => ({ tokens: null, raw: null, missingReason: reason, outcome });
  if (!isObject(message) || message.role !== 'assistant') return missing('没有可确认的模型响应');
  const usage = message.usage;
  if (!isObject(usage)) return missing('响应未提供 usage');
  const { input, output, cacheRead, cacheWrite, totalTokens, reasoning } = usage;
  if (![input, output, cacheRead, cacheWrite, totalTokens].every(token)) return missing('usage 字段缺失或不是非负安全整数');
  // TS 不会从数组 every 收窄独立变量。
  if (!token(input) || !token(output) || !token(cacheRead) || !token(cacheWrite) || !token(totalTokens)) return missing('无效 token');
  const sum = input + cacheRead + cacheWrite + output;
  if (!Number.isSafeInteger(sum) || sum !== totalTokens) return missing('usage 字段无法按输入、缓存、输出可靠分解');
  if (reasoning !== undefined && (!token(reasoning) || reasoning > output)) return missing('推理 token 与输出包含关系无法确认');
  const raw = { input, output, cacheRead, cacheWrite, totalTokens, reasoning: token(reasoning) ? reasoning : null };
  // SDK 默认占位与提供方真的报告零无法仅凭最终对象区分；不把成功状态当成 usage 存在性的证明。
  if (totalTokens === 0) return { outcome, tokens: null, raw, missingReason: '全零 usage 无法确认是提供方实际用量，按缺失处理' };
  return { outcome, tokens: { input: input + cacheWrite, cacheRead, output, total: totalTokens }, raw, missingReason: null };
}
