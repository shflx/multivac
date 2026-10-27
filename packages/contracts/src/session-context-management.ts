import { Type } from 'typebox';
import type { CoordinatorModelSource } from './coordinator-runtime.js';

/** 统计所属模型；不包含凭据、端点、提示正文或执行器专用类型。 */
export interface ContextModelIdentity {
  provider: string;
  modelId: string;
  /** 历史请求未保存配置来源时保留 null，不套用当前 profile。 */
  source: CoordinatorModelSource | null;
  protocol: string | null;
  profileId: string | null;
}

export type ContextCoverageStatus = 'included' | 'excluded' | 'partial' | 'unknown';

export interface ContextCoverageItem {
  status: ContextCoverageStatus;
  /** 说明统计依据及缺口，不携带原始上下文内容。 */
  explanation: string;
}

export interface ContextCoverage {
  systemPrompt: ContextCoverageItem;
  toolDefinitions: ContextCoverageItem;
  summary: ContextCoverageItem;
  toolResults: ContextCoverageItem;
  attachments: ContextCoverageItem;
}

interface ContextSnapshotBase {
  sessionId: string;
  /** 发起查询时固定的状态版本；会话、模型或上下文变化后不得由旧响应覆盖。 */
  revision: string;
  model: ContextModelIdentity | null;
  /** 统计所属模型的窗口上限。未知时保留 null，禁止套用当前选择框中的模型窗口。 */
  contextWindow: number | null;
  observedAt: string;
  /** 最近请求统计为该请求的时间；不可用时为 null，不用本次查询时间伪造。 */
  measuredAt: string | null;
  stale: boolean;
  staleReason: string | null;
  coverage: ContextCoverage;
}

/**
 * 当前估算与最近请求输入采用不同来源，不共用累计用量账本。
 * 最近请求输入包含缓存命中的输入；不包含该次输出，也不扣减计费缓存 token。
 * 数值未知必须使用 unavailable，不能以 0 或聊天字符数替代。
 */
export type ContextSnapshot = ContextSnapshotBase & (
  | {
      source: 'current-estimate';
      tokens: number;
      /** 明确估算算法及版本，以便判断前后数据口径是否一致。 */
      basis: string;
      unavailableReason: null;
    }
  | {
      source: 'last-request-input';
      tokens: number;
      basis: string;
      unavailableReason: null;
    }
  | {
      source: 'unavailable';
      tokens: null;
      basis: null;
      unavailableReason: string;
    }
);

export type ContextCompactionAvailability =
  | { available: true; model: ContextModelIdentity; reason: null }
  | { available: false; model: ContextModelIdentity | null; reason: string };

export interface SessionContextState {
  sessionId: string;
  revision: string;
  current: ContextSnapshot;
  lastRequest: ContextSnapshot | null;
  /** 服务端当前持久模型，与输入区临时 Agent 的选择分开。 */
  compaction: ContextCompactionAvailability;
}

export type ContextCompactionStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'no-content'
  | 'unavailable'
  | 'reconciliation-required';

export interface ContextCompactionError {
  code: string;
  /** 只允许稳定、脱敏的错误说明，不能直接回传 SDK 错误或文件路径。 */
  message: string;
}

/** 命令意图应先持久化；同 ID 只核对原操作，不重发原生压缩请求。 */
export interface ContextCompactionOperation {
  operationId: string;
  sessionId: string;
  model: ContextModelIdentity | null;
  status: ContextCompactionStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** 抛错、断线或 abort 返回不能单独证明未提交或已停止。 */
  commitState: 'not-committed' | 'committed' | 'unknown';
  /** 由原执行器解释的提交引用；应用层不解析其格式。 */
  runtimeCommitRef: string | null;
  before: ContextSnapshot;
  after: ContextSnapshot | null;
  error: ContextCompactionError | null;
}

/** API 边界使用同一语义验证未知值；不可用 token 必须为 null。 */
const NullableText = Type.Union([Type.String(), Type.Null()]);
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Model = Type.Object({ provider: Type.String(), modelId: Type.String(), source: Type.Union([Type.Enum(['base', 'controlled']), Type.Null()]),
  protocol: NullableText, profileId: NullableText }, { additionalProperties: false });
const CoverageItem = Type.Object({ status: Type.Enum(['included', 'excluded', 'partial', 'unknown']), explanation: Type.String() }, { additionalProperties: false });
const SnapshotBase = {
  sessionId: Type.String(), revision: Type.String(), model: Type.Union([Model, Type.Null()]),
  contextWindow: Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  observedAt: Type.String(), measuredAt: NullableText, stale: Type.Boolean(), staleReason: NullableText,
  coverage: Type.Object({ systemPrompt: CoverageItem, toolDefinitions: CoverageItem, summary: CoverageItem, toolResults: CoverageItem, attachments: CoverageItem }, { additionalProperties: false }),
};
export const ContextSnapshotSchema = Type.Union([
  Type.Object({ ...SnapshotBase, source: Type.Enum(['current-estimate', 'last-request-input']), tokens: Count, basis: Type.String(), unavailableReason: Type.Null() }, { additionalProperties: false }),
  Type.Object({ ...SnapshotBase, source: Type.Literal('unavailable'), tokens: Type.Null(), basis: Type.Null(), unavailableReason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
export const ContextCompactionOperationSchema = Type.Object({
  operationId: Type.String(), sessionId: Type.String(), model: Type.Union([Model, Type.Null()]),
  status: Type.Enum(['running', 'succeeded', 'failed', 'cancelled', 'no-content', 'unavailable', 'reconciliation-required']),
  startedAt: Type.String(), updatedAt: Type.String(), finishedAt: NullableText,
  commitState: Type.Enum(['not-committed', 'committed', 'unknown']), runtimeCommitRef: NullableText,
  before: ContextSnapshotSchema, after: Type.Union([ContextSnapshotSchema, Type.Null()]),
  error: Type.Union([Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });
export const SessionContextResponseSchema = Type.Object({
  state: Type.Object({ sessionId: Type.String(), revision: Type.String(), current: ContextSnapshotSchema,
    lastRequest: Type.Union([ContextSnapshotSchema, Type.Null()]),
    compaction: Type.Union([
      Type.Object({ available: Type.Literal(true), model: Model, reason: Type.Null() }, { additionalProperties: false }),
      Type.Object({ available: Type.Literal(false), model: Type.Union([Model, Type.Null()]), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ]),
  }, { additionalProperties: false }),
  operation: Type.Union([ContextCompactionOperationSchema, Type.Null()]),
}, { additionalProperties: false });
export interface SessionContextResponse { state: SessionContextState; operation: ContextCompactionOperation | null }
export const CompactSessionContextSchema = Type.Object({
  operationId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
  sessionId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
  revision: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
export type CompactSessionContext = Type.Static<typeof CompactSessionContextSchema>;
