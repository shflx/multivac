import { createHash } from 'node:crypto';
import type { ContextCoverage, ContextModelIdentity, ContextSnapshot, CoordinatorModelConfig, SessionContextState } from '@multivac/contracts';
import type { PiCoordinatorAgentSession } from './pi-session-factory.js';

export const PI_COMPACTION_UNAVAILABLE = '当前运行时不支持可靠的原生压缩，或尚未空闲／模型身份无法核对。';

/** 不把消息字符估算解释为完整请求计数，也不宣称提供方已计入所有提示及附件。 */
const coverage: ContextCoverage = {
  systemPrompt: { status: 'unknown', explanation: '最近请求用量由提供方返回；系统提示的计数覆盖尚未独立核验。' },
  toolDefinitions: { status: 'unknown', explanation: '工具定义会进入原生请求；提供方计数覆盖尚未独立核验。' },
  summary: { status: 'partial', explanation: '摘要进入后续上下文；压缩后首次有效回复前改用字符粗估。' },
  toolResults: { status: 'partial', explanation: '已请求内容取提供方用量；新增工具结果由 Pi 按字符启发式估算。' },
  attachments: { status: 'partial', explanation: '新增图片按 Pi 固定估算，不是视觉 token；提供方实际覆盖未知。' },
};

/** 压缩后、首次有效回复前的粗估：全部内容按字符启发式计入，不是分词器计数。 */
export const POST_COMPACTION_BASIS = 'pi-0.85.1:post-compaction-heuristic:system+tools+messages:chars/4:v1';
const postCompactionCoverage: ContextCoverage = {
  systemPrompt: { status: 'included', explanation: '按字符 / 4 粗估，不是分词器计数。' },
  toolDefinitions: { status: 'included', explanation: '名称、描述与参数结构按字符 / 4 粗估。' },
  summary: { status: 'included', explanation: '压缩摘要按字符 / 4 粗估。' },
  toolResults: { status: 'included', explanation: '保留的工具结果按字符 / 4 粗估。' },
  attachments: { status: 'partial', explanation: '图片按 Pi 固定值估算，不是视觉 token。' },
};

function identity(config: CoordinatorModelConfig): ContextModelIdentity {
  return { provider: config.provider, modelId: config.modelId, source: config.source ?? 'base', protocol: config.protocol ?? null, profileId: config.profileId ?? null };
}
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** 仅查询已打开的真实运行时，不初始化、不调用模型、不使用累计账本。 */
export function readPiContext(sessionId: string, session: PiCoordinatorAgentSession, config: CoordinatorModelConfig,
  now: string): SessionContextState {
  const branch = session.getActiveBranch();
  const model = session.model;
  const matchesConfig = model?.provider === config.provider && model.id === config.modelId;
  const currentModel = model ? matchesConfig ? identity(config) : { provider: model.provider, modelId: model.id, protocol: model.api, source: null, profileId: null } : null;
  const currentWindow = model && validCount(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null;
  const native = session.getContextUsage?.();
  const busy = session.isIdle !== true;
  const revision = createHash('sha256').update(JSON.stringify([session.sessionId, branch.at(-1)?.id, currentModel, currentWindow, native?.tokens, busy])).digest('hex');
  const base = { sessionId, revision, observedAt: now, measuredAt: null, model: currentModel, contextWindow: currentWindow,
    stale: busy, staleReason: busy ? '会话运行中，上下文仍在变化。' : null, coverage: structuredClone(coverage) };
  const unavailable = (reason: string): ContextSnapshot => ({ ...base, source: 'unavailable', tokens: null, basis: null, unavailableReason: reason });
  let lastRequest: ContextSnapshot | null = null;
  let latestUsageIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const message = entry.message;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
    const usage = message.usage;
    if (!validCount(usage?.input) || !validCount(usage?.cacheRead) || !validCount(usage?.cacheWrite)) continue;
    const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
    // Pi 对缺失 usage 使用全零占位，不能将其展示成一次实际为零的请求。
    if (!validCount(tokens) || tokens === 0) continue;
    latestUsageIndex = index;
    const sameModel = model?.provider === message.provider && model.id === message.model;
    // Pi transcript 没有请求当时的窗口／profile；不能套用当前模型目录猜测历史上限。
    const requestIdentity: ContextModelIdentity = { provider: message.provider, modelId: message.model, protocol: message.api, source: null, profileId: null };
    lastRequest = { ...base, model: requestIdentity,
      contextWindow: null,
      measuredAt: Number.isFinite(message.timestamp) ? new Date(message.timestamp).toISOString() : null,
      source: 'last-request-input', tokens, basis: 'pi-provider-usage:input+cacheRead+cacheWrite:v1', unavailableReason: null,
      stale: busy || index !== branch.length - 1 || !sameModel,
      staleReason: busy ? '会话运行中，最近请求不代表当前占用。' : !sameModel ? '该请求使用另一模型，保留原模型身份；历史窗口未知。' : index !== branch.length - 1 ? '该请求之后上下文已有变化。' : null,
      coverage: Object.fromEntries(Object.entries(coverage).map(([key]) => [key, { status: 'unknown', explanation: '该请求的提供方输入用量；各类内容的独立计数覆盖尚未核验。' }])) as unknown as ContextCoverage,
    };
    break;
  }
  const latestCompaction = branch.findLastIndex(entry => entry.type === 'compaction');
  let current = unavailable('尚无可核验的请求用量；空消息估算不包含系统提示和工具定义。');
  if (latestCompaction >= latestUsageIndex && latestCompaction >= 0) {
    // 压缩后旧用量失效；首次有效回复前用字符启发式粗估，回复后回到提供方用量。
    const estimate = session.estimateContextTokens?.();
    current = validCount(estimate) && estimate > 0
      ? { ...base, source: 'current-estimate', tokens: estimate, measuredAt: now, basis: POST_COMPACTION_BASIS,
        unavailableReason: null, coverage: structuredClone(postCompactionCoverage) }
      : unavailable('压缩后尚无新的有效请求用量，当前占用未知。');
  }
  else if (lastRequest && (lastRequest.model?.provider !== currentModel?.provider || lastRequest.model?.modelId !== currentModel?.modelId)) {
    current = unavailable('最近用量属于另一模型，不能与当前模型窗口混算。');
  } else if (lastRequest && branch.slice(latestUsageIndex + 1).some(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.stopReason !== 'aborted' && entry.message.stopReason !== 'error')) {
    current = unavailable('最近回复缺少完整输入用量，不能将更早的请求统计作为当前依据。');
  } else if (lastRequest && branch.slice(latestUsageIndex + 1).some(entry => entry.type === 'model_change')) {
    current = unavailable('最近请求之后模型配置已有变化，不能沿用旧用量计算当前占用。');
  } else if (lastRequest && native && validCount(native.tokens) && native.tokens > 0) {
    current = { ...base, source: 'current-estimate', tokens: native.tokens, measuredAt: now,
      basis: 'pi-0.85.1:latest-usage-including-output+heuristic-tail', unavailableReason: null };
  }
  return { sessionId, revision, current, lastRequest,
    compaction: session.compactContext && !busy && matchesConfig
      ? { available: true, model: identity(config), reason: null }
      : { available: false, model: identity(config), reason: PI_COMPACTION_UNAVAILABLE } };
}
