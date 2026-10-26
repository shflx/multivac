import type { CoordinatorModelSource } from './coordinator-runtime.js';

/** 统计所属模型；不包含凭据、端点、提示正文或执行器专用类型。 */
export interface ContextModelIdentity {
  provider: string;
  modelId: string;
  source: CoordinatorModelSource;
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
