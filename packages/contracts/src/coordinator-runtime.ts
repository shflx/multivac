export const COORDINATOR_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type CoordinatorThinkingLevel = (typeof COORDINATOR_THINKING_LEVELS)[number];
export type CoordinatorModelSource = 'base' | 'controlled';
export type CoordinatorModelEndpointMode = 'fixed' | 'pi-native-dynamic';

export interface CoordinatorSessionBinding {
  assistantSessionId: string;
  piSessionId: string;
  piSessionPath: string;
  updatedAt: string;
  /** 新绑定固定创建时选择；旧数据缺失时回退应用基础配置。 */
  modelProvider?: string;
  modelId?: string;
  modelSource?: CoordinatorModelSource;
  modelProtocol?: string;
  modelEndpoint?: string | null;
  modelEndpointMode?: CoordinatorModelEndpointMode;
  modelResolvedEndpoint?: string | null;
  modelProfileId?: string;
}

export interface CoordinatorAuthorizedContext {
  referenceId: string;
  label: string;
  content: string;
}

export interface CoordinatorModelConfig {
  provider: string;
  modelId: string;
  thinkingLevel: CoordinatorThinkingLevel;
  /** 旧调用方未声明 source 时仅视为基础 Pi 配置，不能由 protocol 推断来源。 */
  source?: CoordinatorModelSource;
  protocol?: string;
  endpoint?: string | null;
  /** 基础 Azure 委托 Pi 环境优先解析，endpoint 仅为安全 fallback，不是实际解析端点。 */
  endpointMode?: CoordinatorModelEndpointMode;
  resolvedEndpoint?: string | null;
  profileId?: string;
}

export interface CoordinatorRetryConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export interface CoordinatorCompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface CoordinatorRuntimeConfig {
  systemPrompt: string;
  authorizedContext: CoordinatorAuthorizedContext[];
  model: CoordinatorModelConfig;
  retry: CoordinatorRetryConfig;
  compaction: CoordinatorCompactionConfig;
}

export interface CoordinatorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type CoordinatorRunStatus = 'completed' | 'failed' | 'cancelled';

export interface CoordinatorRunResult {
  /** 当前 usage 是 Pi 最后一条已捕获消息的原始 usage，不代表整次 run 的累计值。 */
  status: CoordinatorRunStatus;
  usage?: CoordinatorUsage;
}

export interface CoordinatorSessionReady {
  binding: CoordinatorSessionBinding;
  activeToolNames: string[];
  model: CoordinatorModelState;
  modelConfig: CoordinatorModelConfig;
  diagnostics: CoordinatorDiagnostic[];
  resumedExistingSession: boolean;
}

export interface CoordinatorActionAccepted {
  accepted: true;
}

export interface CoordinatorModelState {
  provider: string;
  modelId: string;
  thinkingLevel: CoordinatorThinkingLevel;
}

export interface CoordinatorModelUpdate {
  model: CoordinatorModelState;
  diagnostics: CoordinatorDiagnostic[];
}

export type CoordinatorDiagnosticCode =
  | 'MODEL_FALLBACK'
  | 'SETTINGS_LOAD_FAILED'
  | 'SETTINGS_PERSIST_FAILED'
  | 'THINKING_LEVEL_ADJUSTED'
  | 'EVENT_LISTENER_FAILED';

export type CoordinatorDiagnostic =
  | {
      code: Exclude<
        CoordinatorDiagnosticCode,
        'THINKING_LEVEL_ADJUSTED' | 'EVENT_LISTENER_FAILED'
      >;
      message: string;
    }
  | {
      code: 'THINKING_LEVEL_ADJUSTED';
      message: string;
      requestedThinkingLevel: CoordinatorThinkingLevel;
      actualThinkingLevel: CoordinatorThinkingLevel;
    }
  | {
      code: 'EVENT_LISTENER_FAILED';
      message: string;
      eventType: CoordinatorAdapterEvent['type'];
    };

export type CoordinatorErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_OPEN_FAILED'
  | 'SESSION_BINDING_MISMATCH'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_AUTH_UNAVAILABLE'
  | 'DEFAULT_MODEL_UNAVAILABLE'
  | 'MODEL_SELECTION_RECOVERY_REQUIRED'
  | 'RUNTIME_OPERATION_FAILED';

export interface CoordinatorError {
  code: CoordinatorErrorCode;
  message: string;
  recoverableBinding?: CoordinatorSessionBinding;
}

export type CoordinatorResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: CoordinatorError;
    };

export type CoordinatorBusinessProposal =
  | {
      kind: 'task.create';
      proposalId: string;
      title: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high' | 'urgent';
    }
  | {
      kind: 'status.change';
      proposalId: string;
      targetType: 'task' | 'project';
      targetId: string;
      status: string;
      reason?: string;
    };

interface CoordinatorEventBase {
  eventId: string;
  cursor: string;
  sequence: number;
  sourceInstanceId: string;
  assistantSessionId: string;
  piSessionId: string;
  occurredAt: string;
}

export type CoordinatorRetryOutcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export type CoordinatorCompactionStatus = 'succeeded' | 'failed' | 'cancelled';

export type CoordinatorCompactionErrorCode = 'COMPACTION_FAILED';

export type CoordinatorAdapterEvent =
  | (CoordinatorEventBase & {
      type: 'coordinator.run.started';
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.run.ended';
      willRetry: boolean;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.turn.started';
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.turn.ended';
      usage?: CoordinatorUsage;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.message.started';
      messageId: string;
      role: 'user' | 'assistant' | 'tool';
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.message.delta';
      messageId: string;
      channel: 'text' | 'thinking';
      delta: string;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.message.ended';
      messageId: string;
      role: 'user' | 'assistant' | 'tool';
      stopReason?: string;
      usage?: CoordinatorUsage;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.tool.started';
      toolCallId: string;
      toolName: string;
      argumentKeys: string[];
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.tool.updated';
      toolCallId: string;
      toolName: string;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.tool.ended';
      toolCallId: string;
      toolName: string;
      isError: boolean;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.queue.updated';
      steeringCount: number;
      followUpCount: number;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.retry.started';
      scope: 'run' | 'summarization';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.retry.ended';
      scope: 'run' | 'summarization';
      outcome: CoordinatorRetryOutcome;
      attempt: number;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.compaction.started';
      reason: 'manual' | 'threshold' | 'overflow';
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.compaction.ended';
      reason: 'manual' | 'threshold' | 'overflow';
      status: CoordinatorCompactionStatus;
      willRetry: boolean;
      errorCode?: CoordinatorCompactionErrorCode;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.run.completed';
      usage?: CoordinatorUsage;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.run.failed';
      usage?: CoordinatorUsage;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.run.cancelled';
      usage?: CoordinatorUsage;
    })
  | (CoordinatorEventBase & {
      type: 'coordinator.unknown';
      sourceType: string;
    });

export type CoordinatorEventListener = (event: CoordinatorAdapterEvent) => void;
