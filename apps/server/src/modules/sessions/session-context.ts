import type { AssistantMessageView, CoordinatorSessionContext } from '@multivac/contracts';

/** 摘录最近的消息条数、单条与总长度上限：足以让模型理解“这个”指什么，又不挤占上下文。 */
export const SESSION_CONTEXT_MAX_MESSAGES = 6;
export const SESSION_CONTEXT_MESSAGE_MAX_CHARS = 400;
export const SESSION_CONTEXT_MAX_CHARS = 2_400;

function clip(text: string, limit: number): string {
  const normalized = text.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/** 按时间顺序摘录会话最近的几条可见消息；总长度超限时从最早的一条开始舍弃。 */
export function sessionContextExcerpt(messages: readonly AssistantMessageView[]): string {
  const lines = messages.slice(-SESSION_CONTEXT_MAX_MESSAGES).map((message) =>
    `${message.role === 'user' ? '用户' : '助手'}：${clip(message.text, SESSION_CONTEXT_MESSAGE_MAX_CHARS)}`);
  while (lines.length > 1 && lines.join('\n').length > SESSION_CONTEXT_MAX_CHARS) lines.shift();
  return lines.length > 0 ? lines.join('\n') : '（该会话还没有消息）';
}

/** 工作区侧栏的焦点会话上下文。 */
export function buildSessionContext(
  sessionId: string,
  title: string,
  messages: readonly AssistantMessageView[],
): CoordinatorSessionContext {
  return { kind: 'focused-session', sessionId, title, excerpt: sessionContextExcerpt(messages) };
}
