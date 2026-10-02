import type { AssistantContextRef, CoordinatorSessionContext, Project, Task } from '@multivac/contracts';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
import { buildProjectContext, buildSessionContext } from '../modules/sessions/session-context.js';
import type { SessionRecord } from '../modules/sessions/session-registry.js';
import { AssistantTurnCommandServiceError, type QuoteSourceSession } from './assistant-turn-command-service.js';
import type { SessionRuntimeHandle } from './workspace-session-service.js';

export interface SessionContextResolverOptions {
  /** 发送消息的会话；不能把自身作为上下文。 */
  ownerSessionId: string;
  /** 取得未归档的会话记录；不存在时抛错。 */
  resolveSession: (sessionId: string) => SessionRecord;
  acquireRuntime: (record: SessionRecord) => SessionRuntimeHandle;
  adapter: CoordinatorAdapter;
}

export interface CoordinatorContextResolverOptions extends SessionContextResolverOptions {
  /** 取得项目；不存在时抛错。 */
  resolveProject: (projectId: string) => Project;
  resolveTask?: (taskId: string) => Task;
}

function invalid(message: string): AssistantTurnCommandServiceError {
  return new AssistantTurnCommandServiceError('INVALID_REQUEST', message);
}

/**
 * 把 Multivac 侧栏的上下文引用解析为交给模型的上下文：服务端自行读取会话标题与最近内容、
 * 项目名称与设置，不信任客户端提供的任何正文。
 */
export function createSessionContextResolver(options: CoordinatorContextResolverOptions) {
  return async (refs: readonly AssistantContextRef[]): Promise<CoordinatorSessionContext | undefined> => {
    const ref = refs[0];
    if (!ref) return undefined;
    if (ref.kind === 'task') {
      try {
        const task = options.resolveTask?.(ref.taskId);
        if (!task) throw new Error('missing task');
        return { kind: 'focused-task', taskId: task.taskId, title: task.title, excerpt: `revision: ${task.revision}\n状态: ${task.status}\n目标: ${task.goal.slice(0, 1200)}\n当前: ${task.reason.slice(0, 500)}\n下一步: ${task.nextStep.slice(0, 500)}` };
      } catch { throw invalid('上下文任务不存在，消息未发送。'); }
    }
    if (ref.kind === 'project') {
      try {
        return buildProjectContext(options.resolveProject(ref.projectId));
      } catch {
        throw invalid('上下文项目不存在，消息未发送。');
      }
    }
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

export type QuoteSourceResolverOptions = Omit<SessionContextResolverOptions, 'ownerSessionId'>;

/**
 * 读取跨会话引用的来源会话：须为工作区中未归档的工作会话，历史由服务端读取，
 * 会话名以注册表为准。
 */
export function createQuoteSourceResolver(options: QuoteSourceResolverOptions) {
  return async (sessionId: string): Promise<QuoteSourceSession> => {
    let record: SessionRecord;
    try {
      record = options.resolveSession(sessionId);
    } catch {
      throw invalid('引用来源会话不存在或已归档，消息未发送。');
    }
    if (record.kind !== 'work') throw invalid('只能引用工作区会话中的内容。');
    try {
      await options.acquireRuntime(record).initialize();
    } catch {
      throw invalid('引用来源会话暂时无法读取，消息未发送，请稍后重试。');
    }
    const snapshot = options.adapter.readActiveBranch(record.sessionId);
    if (!snapshot.ok) throw invalid('引用来源会话暂时无法读取，消息未发送，请稍后重试。');
    return {
      sessionId: record.sessionId,
      title: record.title,
      piSessionId: snapshot.value.piSessionId,
      messages: snapshot.value.messages,
    };
  };
}
