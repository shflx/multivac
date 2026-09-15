import type {
  AssistantCommandKind,
  AssistantCommandReceipt,
  AssistantCommandTerminalOutcome,
  AssistantPublicEvent,
} from '@multivac/contracts';

export type AssistantDispatchMode = 'prompt' | 'steer' | 'followUp' | 'abort';

export interface StoredAssistantCommandReceipt extends AssistantCommandReceipt {
  payloadFingerprint: string;
  dispatchMode: AssistantDispatchMode | null;
}

export interface CreateAssistantCommandInput {
  commandId: string;
  assistantSessionId: string;
  kind: AssistantCommandKind;
  payloadFingerprint: string;
  piSessionId: string;
}

export interface AssistantCommandEventMutation {
  receipt: StoredAssistantCommandReceipt;
  event: AssistantPublicEvent | null;
}

export interface AssistantCommandRepository {
  get(commandId: string): StoredAssistantCommandReceipt | undefined;
  listNonTerminal(assistantSessionId: string): StoredAssistantCommandReceipt[];
  createAccepted(input: CreateAssistantCommandInput): AssistantCommandEventMutation;
  reject(
    commandId: string,
    error: { code: string; message: string },
  ): AssistantCommandEventMutation;
  markHandedToPi(
    commandId: string,
    dispatchMode: AssistantDispatchMode,
  ): AssistantCommandEventMutation;
  markRunning(commandId: string, piTurnRef: string | null): AssistantCommandEventMutation;
  reconcile(
    commandId: string,
    terminalOutcome: AssistantCommandTerminalOutcome,
    error?: { code: string; message: string },
    piEntryId?: string | null,
  ): AssistantCommandEventMutation;
}

export interface AppendAssistantPublicEventInput {
  sourceKey: string;
  assistantSessionId: string;
  commandId: string | null;
  type: AssistantPublicEvent['type'];
  data: AssistantPublicEvent['data'];
  occurredAt: string;
}

export type AssistantProjectionReceiptUpdate =
  | {
      type: 'running';
      commandId: string;
      piTurnRef: string | null;
    }
  | {
      type: 'terminal';
      commandId: string;
      terminalOutcome: Extract<AssistantCommandTerminalOutcome, 'succeeded' | 'failed' | 'cancelled'>;
    };

export interface AssistantProjectionMutation {
  event: AssistantPublicEvent | null;
  receipt: StoredAssistantCommandReceipt | null;
}

export interface AssistantEventRepository {
  latestCursor(): string;
  earliestCursor(): string;
  append(input: AppendAssistantPublicEventInput): AssistantPublicEvent | null;
  project(
    input: AppendAssistantPublicEventInput,
    receiptUpdate?: AssistantProjectionReceiptUpdate,
  ): AssistantProjectionMutation;
  listAfter(cursor: string, limit?: number): AssistantPublicEvent[];
}

export class AssistantEventCursorExpiredError extends Error {
  constructor() {
    super('公共事件游标已失效，需要重新读取会话快照。');
    this.name = 'AssistantEventCursorExpiredError';
  }
}
