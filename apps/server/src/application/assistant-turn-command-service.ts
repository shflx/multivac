import { createHash } from 'node:crypto';
import type {
  AssistantCommandReceipt,
  AssistantCommandReconciliationResponse,
  AssistantCommandTerminalOutcome,
  CancelAssistantTurnCommand,
  SendAssistantMessageCommand,
} from '@multivac/contracts';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  GLOBAL_ASSISTANT_SESSION_ID,
} from '@multivac/contracts';
import type { AssistantSessionService } from './assistant-session-service.js';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
import type {
  AssistantCommandRepository,
  StoredAssistantCommandReceipt,
} from '../modules/sessions/assistant-turn.js';
import { AssistantEventStream } from './assistant-event-stream.js';

export class AssistantTurnCommandServiceError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'ASSISTANT_SESSION_BINDING_MISMATCH' |
      'COMMAND_ID_CONFLICT' | 'COMMAND_STATE_MISMATCH',
    message: string,
    readonly receipt?: AssistantCommandReceipt,
  ) {
    super(message);
    this.name = 'AssistantTurnCommandServiceError';
  }
}

export interface AssistantTurnCommandServiceOptions {
  sessionService: AssistantSessionService;
  adapter: CoordinatorAdapter;
  commandRepository: AssistantCommandRepository;
  eventStream: AssistantEventStream;
  assistantSessionId?: string;
}

function publicReceipt(receipt: StoredAssistantCommandReceipt): AssistantCommandReceipt {
  const { payloadFingerprint: _fingerprint, dispatchMode: _dispatchMode, ...result } = receipt;
  return result;
}

function commandFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sendFingerprint(command: SendAssistantMessageCommand): string {
  return commandFingerprint({
    kind: 'send',
    commandId: command.commandId,
    assistantSessionId: command.assistantSessionId,
    text: command.text,
    contextRefs: command.contextRefs,
    streamingBehavior: command.streamingBehavior ?? null,
  });
}

function cancelFingerprint(command: CancelAssistantTurnCommand): string {
  return commandFingerprint({
    kind: 'cancel',
    commandId: command.commandId,
    assistantSessionId: command.assistantSessionId,
  });
}

/** commandId 幂等只覆盖一次 Pi handoff；崩溃后的不确定窗口通过回执对账暴露。 */
export class AssistantTurnCommandService {
  private readonly assistantSessionId: string;
  private readonly inFlight = new Map<string, {
    kind: 'send' | 'cancel';
    fingerprint: string;
    promise: Promise<AssistantCommandReceipt>;
  }>();
  private readonly dispatchLocks = new Map<string, Promise<void>>();
  private readonly abortDispatches = new Map<string, ReturnType<CoordinatorAdapter['abort']>>();
  private activePromptCommandId: string | null = null;

  constructor(private readonly options: AssistantTurnCommandServiceOptions) {
    this.assistantSessionId = options.assistantSessionId ?? GLOBAL_ASSISTANT_SESSION_ID;
  }

  send(command: SendAssistantMessageCommand): Promise<AssistantCommandReceipt> {
    const fingerprint = sendFingerprint(command);
    return this.singleFlight(command.commandId, 'send', fingerprint, async () => {
      const existing = this.options.commandRepository.get(command.commandId);
      if (existing) return this.replayOrConflict(existing, 'send', fingerprint);
      this.validateSend(command);
      return this.executeSend(command, fingerprint);
    });
  }

  cancel(command: CancelAssistantTurnCommand): Promise<AssistantCommandReceipt> {
    const fingerprint = cancelFingerprint(command);
    return this.singleFlight(
      command.commandId,
      'cancel',
      fingerprint,
      async () => {
        const existing = this.options.commandRepository.get(command.commandId);
        if (existing) return this.replayOrConflict(existing, 'cancel', fingerprint);
        this.validateSession(command.assistantSessionId);
        return this.executeCancel(command, fingerprint);
      },
    );
  }

  get(commandId: string): AssistantCommandReconciliationResponse {
    const receipt = this.options.commandRepository.get(commandId);
    return receipt
      ? { commandId, status: receipt.status, receipt: publicReceipt(receipt) }
      : { commandId, status: 'unknown', receipt: null };
  }

  currentPromptCommandId(): string | null {
    return this.activePromptCommandId;
  }

  async reconcileOnStartup(): Promise<void> {
    await this.options.sessionService.initialize();
    this.activePromptCommandId = null;
    const nonTerminal = this.options.commandRepository.listNonTerminal(this.assistantSessionId);
    for (const receipt of nonTerminal) {
      const mutation = this.options.commandRepository.reconcile(receipt.commandId, 'failed', {
        code: 'COMMAND_INTERRUPTED',
        message: '服务重启前命令尚未终结；provider stream 不可跨进程恢复，已标记为中断。',
      });
      this.options.eventStream.publish(mutation.event);
    }
  }

  private async executeSend(
    command: SendAssistantMessageCommand,
    fingerprint: string,
  ): Promise<AssistantCommandReceipt> {
    const binding = await this.options.sessionService.initialize();
    const existing = this.options.commandRepository.get(command.commandId);
    if (existing) return this.replayOrConflict(existing, 'send', fingerprint);

    const accepted = this.options.commandRepository.createAccepted({
      commandId: command.commandId,
      assistantSessionId: command.assistantSessionId,
      kind: 'send',
      payloadFingerprint: fingerprint,
      piSessionId: binding.piSessionId,
    });
    this.options.eventStream.publish(accepted.event);
    if (accepted.receipt.payloadFingerprint !== fingerprint || accepted.receipt.kind !== 'send') {
      return this.replayOrConflict(accepted.receipt, 'send', fingerprint);
    }

    const dispatch = await this.withDispatchLock(command.assistantSessionId, async () => {
      const activePromptCommandId = this.activePromptCommandId;
      const activePrompt = activePromptCommandId
        ? this.options.commandRepository.get(activePromptCommandId)
        : undefined;
      const promptClaimed = activePromptCommandId !== null && activePrompt?.status !== 'terminal';
      const streaming = this.options.adapter.isStreaming(command.assistantSessionId);
      if (!streaming.ok) {
        return { receipt: this.reject(command.commandId, streaming.error.code, streaming.error.message) };
      }

      // prompt 已占用但 Pi 尚未 streaming 时，队列动作还没有安全的接收点。
      if (promptClaimed && !streaming.value) {
        return { receipt: this.reject(
          command.commandId,
          'COMMAND_STATE_MISMATCH',
          '上一条消息已被 Pi 接受，但尚未进入可追加状态。',
        ) };
      }

      if (!streaming.value && command.streamingBehavior) {
        return { receipt: this.reject(
          command.commandId,
          'COMMAND_STATE_MISMATCH',
          '会话空闲时不能使用 steer 或 followUp。',
        ) };
      }
      if (streaming.value && !command.streamingBehavior) {
        return { receipt: this.reject(
          command.commandId,
          'COMMAND_STATE_MISMATCH',
          '会话运行中必须明确选择 steer 或 followUp。',
        ) };
      }

      if (command.streamingBehavior) {
        const handed = this.options.commandRepository.markHandedToPi(
          command.commandId,
          command.streamingBehavior,
        );
        this.options.eventStream.publish(handed.event);
        const result = command.streamingBehavior === 'steer'
          ? await this.options.adapter.steer(command.assistantSessionId, command.text)
          : await this.options.adapter.followUp(command.assistantSessionId, command.text);
        if (!result.ok) {
          return { receipt: this.reconcileFailure(command.commandId, result.error.code, result.error.message) };
        }
        return { receipt: this.reconcile(command.commandId, 'accepted') };
      }

      const handed = this.options.commandRepository.markHandedToPi(command.commandId, 'prompt');
      this.options.eventStream.publish(handed.event);
      // prompt() 在真正进入 streaming 前可能异步预处理；先占用会话，阻止第二个空闲 prompt。
      this.activePromptCommandId = command.commandId;
      // 调用发生在 SQLite 事务外；Promise 在释放 dispatch lock 后等待 settled。
      const runPromise = this.options.adapter.prompt(command.assistantSessionId, command.text);
      return { runPromise };
    });

    if ('receipt' in dispatch) return dispatch.receipt;

    try {
      const result = await dispatch.runPromise;
      if (!result.ok) {
        return this.reconcileFailure(command.commandId, result.error.code, result.error.message);
      }
      const outcome: AssistantCommandTerminalOutcome = result.value.status === 'completed'
        ? 'succeeded'
        : result.value.status;
      const snapshot = this.options.adapter.readActiveBranch(command.assistantSessionId);
      return this.reconcile(
        command.commandId,
        outcome,
        snapshot.ok ? snapshot.value.leafEntryId : null,
      );
    } finally {
      this.abortDispatches.delete(command.commandId);
      if (this.activePromptCommandId === command.commandId) {
        this.activePromptCommandId = null;
      }
    }
  }

  private async executeCancel(
    command: CancelAssistantTurnCommand,
    fingerprint: string,
  ): Promise<AssistantCommandReceipt> {
    const binding = await this.options.sessionService.initialize();
    const existing = this.options.commandRepository.get(command.commandId);
    if (existing) return this.replayOrConflict(existing, 'cancel', fingerprint);

    const accepted = this.options.commandRepository.createAccepted({
      commandId: command.commandId,
      assistantSessionId: command.assistantSessionId,
      kind: 'cancel',
      payloadFingerprint: fingerprint,
      piSessionId: binding.piSessionId,
    });
    this.options.eventStream.publish(accepted.event);

    const targetPromptCommandId = this.activePromptCommandId;
    const targetPromptReceipt = targetPromptCommandId
      ? this.options.commandRepository.get(targetPromptCommandId)
      : undefined;
    const targetedActivePrompt = targetPromptReceipt?.kind === 'send' &&
      targetPromptReceipt.status !== 'terminal';

    const dispatch = await this.withDispatchLock(command.assistantSessionId, async () => {
      if (!targetPromptCommandId || !targetedActivePrompt) {
        return { receipt: this.rejectNoActiveTurn(command.commandId) };
      }

      const sharedAbort = this.abortDispatches.get(targetPromptCommandId);
      if (sharedAbort) {
        const handed = this.options.commandRepository.markHandedToPi(command.commandId, 'abort');
        this.options.eventStream.publish(handed.event);
        return { abortPromise: sharedAbort };
      }

      const currentPrompt = this.options.commandRepository.get(targetPromptCommandId);
      if (
        this.activePromptCommandId !== targetPromptCommandId ||
        currentPrompt?.status === 'terminal'
      ) {
        return { receipt: this.rejectNoActiveTurn(command.commandId) };
      }

      const streaming = this.options.adapter.isStreaming(command.assistantSessionId);
      if (!streaming.ok || !streaming.value) {
        return { receipt: this.rejectNoActiveTurn(command.commandId) };
      }
      const handed = this.options.commandRepository.markHandedToPi(command.commandId, 'abort');
      this.options.eventStream.publish(handed.event);
      const abortPromise = this.options.adapter.abort(command.assistantSessionId);
      this.abortDispatches.set(targetPromptCommandId, abortPromise);
      return { abortPromise };
    });

    if ('receipt' in dispatch) return dispatch.receipt;
    const result = await dispatch.abortPromise;
    return result.ok
      ? this.reconcile(command.commandId, 'accepted')
      : this.reconcileFailure(command.commandId, result.error.code, result.error.message);
  }

  private replayOrConflict(
    receipt: StoredAssistantCommandReceipt,
    kind: 'send' | 'cancel',
    fingerprint: string,
  ): AssistantCommandReceipt {
    if (receipt.kind !== kind || receipt.payloadFingerprint !== fingerprint) {
      throw new AssistantTurnCommandServiceError(
        'COMMAND_ID_CONFLICT',
        'commandId 已被不同请求使用。',
        publicReceipt(receipt),
      );
    }
    return publicReceipt(receipt);
  }

  private reject(commandId: string, code: string, message: string): AssistantCommandReceipt {
    const mutation = this.options.commandRepository.reject(commandId, { code, message });
    this.options.eventStream.publish(mutation.event);
    return publicReceipt(mutation.receipt);
  }

  private rejectNoActiveTurn(commandId: string): AssistantCommandReceipt {
    return this.reject(
      commandId,
      'COMMAND_STATE_MISMATCH',
      '当前没有可取消的协调助手运行。',
    );
  }

  private reconcileFailure(commandId: string, code: string, message: string): AssistantCommandReceipt {
    const mutation = this.options.commandRepository.reconcile(commandId, 'failed', { code, message });
    this.options.eventStream.publish(mutation.event);
    return publicReceipt(mutation.receipt);
  }

  private reconcile(
    commandId: string,
    outcome: AssistantCommandTerminalOutcome,
    piEntryId?: string | null,
  ): AssistantCommandReceipt {
    const mutation = this.options.commandRepository.reconcile(
      commandId,
      outcome,
      undefined,
      piEntryId,
    );
    this.options.eventStream.publish(mutation.event);
    return publicReceipt(mutation.receipt);
  }

  private validateSend(command: SendAssistantMessageCommand): void {
    this.validateSession(command.assistantSessionId);
    if (!command.text.trim()) {
      throw new AssistantTurnCommandServiceError('INVALID_REQUEST', '消息正文不能为空。');
    }
    if (Buffer.byteLength(command.text, 'utf8') > ASSISTANT_DRAFT_MAX_UTF8_BYTES) {
      throw new AssistantTurnCommandServiceError('INVALID_REQUEST', '消息正文超过 12 KiB UTF-8 上限。');
    }
    if (command.contextRefs.length !== 0) {
      throw new AssistantTurnCommandServiceError('INVALID_REQUEST', '当前版本不支持 contextRefs。');
    }
  }

  private validateSession(assistantSessionId: string): void {
    if (assistantSessionId !== this.assistantSessionId) {
      throw new AssistantTurnCommandServiceError(
        'ASSISTANT_SESSION_BINDING_MISMATCH',
        '命令的 assistantSessionId 与当前全局助手不一致。',
      );
    }
  }

  private singleFlight(
    commandId: string,
    kind: 'send' | 'cancel',
    fingerprint: string,
    operation: () => Promise<AssistantCommandReceipt>,
  ): Promise<AssistantCommandReceipt> {
    const existing = this.inFlight.get(commandId);
    if (existing) {
      if (existing.kind !== kind || existing.fingerprint !== fingerprint) {
        return Promise.reject(new AssistantTurnCommandServiceError(
          'COMMAND_ID_CONFLICT',
          'commandId 已被不同请求使用。',
        ));
      }
      return existing.promise;
    }
    const promise = operation().finally(() => {
      if (this.inFlight.get(commandId)?.promise === promise) this.inFlight.delete(commandId);
    });
    this.inFlight.set(commandId, { kind, fingerprint, promise });
    return promise;
  }

  private async withDispatchLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.dispatchLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.dispatchLocks.set(key, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.dispatchLocks.get(key) === chain) this.dispatchLocks.delete(key);
    }
  }
}
