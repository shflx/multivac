import type { AssistantMessageView, CoordinatorSessionContext, Project } from '@multivac/contracts';

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
  if (messages.length === 0) return '（该会话还没有消息）';
  const lines = messages.slice(-SESSION_CONTEXT_MAX_MESSAGES).map((message) => {
    const text = message.text.trim();
    const incomplete = text.length > SESSION_CONTEXT_MESSAGE_MAX_CHARS;
    let end = incomplete ? SESSION_CONTEXT_MESSAGE_MAX_CHARS - 1 : text.length;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--;
    return `${message.role === 'user' ? '用户' : '助手'}${incomplete ? '（正文未完）' : ''}：${text.slice(0, end)}${incomplete ? '…' : ''}`;
  });
  const header = () => `有限摘录：最近 ${lines.length}/${messages.length} 条，消息范围 [${messages.length - lines.length},${messages.length})；保存引用未自动注入。`;
  while (lines.length > 1 && [header(), ...lines].join('\n').length > SESSION_CONTEXT_MAX_CHARS) lines.shift();
  return [header(), ...lines].join('\n');
}

/** Multivac 侧栏正在看的会话（工作区的焦点会话）。 */
export function buildSessionContext(
  sessionId: string,
  title: string,
  messages: readonly AssistantMessageView[],
): CoordinatorSessionContext {
  return { kind: 'focused-session', sessionId, title, excerpt: sessionContextExcerpt(messages) };
}

/** 项目目录类型在上下文里的写法，与界面一致。 */
const PROJECT_DIRECTORY_KINDS = { managed: '托管', mounted: '挂载' } as const;

/**
 * Multivac 侧栏正在看的项目（设置 · 项目页选中的项目）：名称以外给出目录（第一个是主目录）
 * 与默认约束，足以让模型理解“这个项目”指什么。约束按 SESSION_CONTEXT_MAX_CHARS 截断。
 */
export function buildProjectContext(project: Project): CoordinatorSessionContext {
  const directories = project.directories.map((directory, index) =>
    `- ${PROJECT_DIRECTORY_KINDS[directory.kind]} ${directory.path}${index === 0 ? '（主目录）' : ''}`);
  const constraints = project.defaultConstraints.trim();
  return {
    kind: 'focused-project',
    projectId: project.projectId,
    title: project.name,
    excerpt: [
      '目录：',
      ...directories,
      `默认约束：${constraints ? clip(constraints, SESSION_CONTEXT_MAX_CHARS) : '（未设置）'}`,
    ].join('\n'),
  };
}
