import type { AssistantMessageView, CoordinatorSessionBinding } from '@multivac/contracts';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';

export class SessionTranscriptUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTranscriptUnavailableError';
  }
}

export interface SessionTranscriptReaderOptions {
  registry: Pick<SessionRegistryRepository, 'get'>;
  bindings: { get(sessionId: string): CoordinatorSessionBinding | undefined };
  adapter: Pick<CoordinatorAdapter, 'readActiveBranch' | 'readPersistedHistory'>;
}

/**
 * 只读读取工作会话的可见消息（用户与助手正文，与会话页同一投影：不含 thinking、工具输入与输出）。
 *
 * 会话的运行时已打开时读内存中的 active branch；否则只读 Pi session 文件，不打开会话、不创建运行时、
 * 不补建工作目录，所以已归档会话也可以读，读取不会改变它的任何状态（包括临时目录的清理计划）。
 * 只接受工作会话：全局 Multivac 自己与其他类型的会话一律拒绝。
 */
export class SessionTranscriptReader {
  constructor(private readonly options: SessionTranscriptReaderOptions) {}

  readMessages(sessionId: string): AssistantMessageView[] {
    const record = this.options.registry.get(sessionId);
    if (!record || record.kind !== 'work') throw new SessionTranscriptUnavailableError('只能读取工作会话的内容。');

    const live = this.options.adapter.readActiveBranch(sessionId);
    if (live.ok) return live.value.messages;

    // 还没有 Pi 绑定：会话从未打开过，也就还没有消息。
    const binding = this.options.bindings.get(sessionId);
    if (!binding) return [];
    const persisted = this.options.adapter.readPersistedHistory(
      { piSessionId: binding.piSessionId, piSessionPath: binding.piSessionPath },
      record.workingDirectory?.path ?? binding.piSessionPath,
    );
    if (!persisted.ok) throw new SessionTranscriptUnavailableError('会话的历史暂时无法读取。');
    return persisted.value.messages;
  }
}
