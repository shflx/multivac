import type { AssistantContextRef, CoordinatorSessionContext } from '@multivac/contracts';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
import { buildSessionContext } from '../modules/sessions/session-context.js';
import type { SessionRecord } from '../modules/sessions/session-registry.js';
import { AssistantTurnCommandServiceError } from './assistant-turn-command-service.js';
import type { SessionRuntimeHandle } from './workspace-session-service.js';

export interface SessionContextResolverOptions {
  /** 发送消息的会话；不能把自身作为上下文。 */
  ownerSessionId: string;
  /** 取得未归档的会话记录；不存在时抛错。 */
  resolveSession: (sessionId: string) => SessionRecord;
  acquireRuntime: (record: SessionRecord) => SessionRuntimeHandle;
  adapter: CoordinatorAdapter;
}

function invalid(message: string): AssistantTurnCommandServiceError {
  return new AssistantTurnCommandServiceError('INVALID_REQUEST', message);
}

/**
 * 把工作区会话上下文引用解析为交给模型的上下文：服务端自行读取会话标题与最近内容，
 * 不信任客户端提供的任何正文。
 */
export function createSessionContextResolver(options: SessionContextResolverOptions) {
  return async (refs: readonly AssistantContextRef[]): Promise<CoordinatorSessionContext | undefined> => {
    const ref = refs[0];
    if (!ref) return undefined;
    if (ref.sessionId === options.ownerSessionId) throw invalid('不能把会话自身作为上下文。');

    let record: SessionRecord;
    try {
      record = options.resolveSession(ref.sessionId);
    } catch {
      throw invalid('上下文会话不存在或已归档，消息未发送。');
    }
    if (record.kind !== 'work') throw invalid('只能把工作区会话作为上下文。');

    try {
      await options.acquireRuntime(record).initialize();
    } catch {
      throw invalid('上下文会话暂时无法读取，消息未发送，请稍后重试。');
    }
    const snapshot = options.adapter.readActiveBranch(record.sessionId);
    if (!snapshot.ok) throw invalid('上下文会话暂时无法读取，消息未发送，请稍后重试。');
    return buildSessionContext(record.sessionId, record.title, snapshot.value.messages);
  };
}
