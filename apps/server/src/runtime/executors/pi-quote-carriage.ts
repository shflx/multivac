import type { CoordinatorQuote, CoordinatorSessionContext } from '@multivac/contracts';

/**
 * 引用在 Pi 中的承载方式：一条 custom_message entry，作为随后用户消息的父节点。
 *
 * 选择 custom_message 而非拼进正文，有三个原因：
 * - 它会作为 user 消息进入 LLM 上下文，模型真实读得到，且不会被提升为 system/developer 指令；
 * - details 保留结构化元数据，UI 恢复不必从正文里反向切分分隔符；
 * - entry 的父子关系天然表达“这条引用属于紧随其后的那条用户消息”。
 */
export const ASSISTANT_QUOTE_CUSTOM_TYPE = 'multivac.quote';

export const ASSISTANT_QUOTE_DETAILS_VERSION = 1;

export interface PiQuoteDetails {
  version: number;
  sourceEntryId: string;
  sourceRole: 'user' | 'assistant';
  text: string;
  /** 跨会话引用的来源；同会话引用没有这些字段。 */
  sourcePiSessionId?: string;
  sourceSessionId?: string;
  sourceTitle?: string;
}

/** 交给模型的引用正文；措辞明确其为用户数据，不承载任何权限或指令语义。 */
export function renderAssistantQuoteForModel(quote: CoordinatorQuote): string {
  if (quote.source) {
    const speaker = quote.sourceRole === 'assistant' ? '助手的回复' : '用户的消息';
    return `用户引用了工作区会话「${quote.source.title}」中${speaker}的一段内容，` +
      `接下来的消息针对这段内容提问：\n\n${quote.text}`;
  }
  const source = quote.sourceRole === 'assistant' ? '你此前的回复' : '用户此前的消息';
  return `用户引用了${source}中的一段内容，接下来的消息针对这段内容提问：\n\n${quote.text}`;
}

export function assistantQuoteDetails(quote: CoordinatorQuote): PiQuoteDetails {
  return {
    version: ASSISTANT_QUOTE_DETAILS_VERSION,
    sourceEntryId: quote.sourcePiEntryId,
    sourceRole: quote.sourceRole,
    text: quote.text,
    ...(quote.source
      ? {
          sourcePiSessionId: quote.source.piSessionId,
          sourceSessionId: quote.source.sessionId,
          sourceTitle: quote.source.title,
        }
      : {}),
  };
}

/** 历史中的 details 由既往版本写入，读取时逐字段核对，无法识别时视为没有引用。 */
export function readAssistantQuoteDetails(value: unknown): PiQuoteDetails | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== ASSISTANT_QUOTE_DETAILS_VERSION) return null;
  if (typeof candidate.sourceEntryId !== 'string' || candidate.sourceEntryId.length === 0) return null;
  if (candidate.sourceRole !== 'user' && candidate.sourceRole !== 'assistant') return null;
  if (typeof candidate.text !== 'string' || candidate.text.length === 0) return null;
  // 跨会话来源三项同时出现才采用；缺任何一项按同会话引用读取。
  const crossSession = typeof candidate.sourcePiSessionId === 'string' && candidate.sourcePiSessionId.length > 0 &&
    typeof candidate.sourceSessionId === 'string' && candidate.sourceSessionId.length > 0 &&
    typeof candidate.sourceTitle === 'string' && candidate.sourceTitle.length > 0;

  return {
    version: ASSISTANT_QUOTE_DETAILS_VERSION,
    sourceEntryId: candidate.sourceEntryId,
    sourceRole: candidate.sourceRole,
    text: candidate.text,
    ...(crossSession
      ? {
          sourcePiSessionId: candidate.sourcePiSessionId as string,
          sourceSessionId: candidate.sourceSessionId as string,
          sourceTitle: candidate.sourceTitle as string,
        }
      : {}),
  };
}

/**
 * 工作区会话上下文的承载方式：与引用相同，是一条不在界面显示的 custom_message，
 * 作为 user 消息进入 LLM 上下文，不会被提升为 system/developer 指令。
 */
export const ASSISTANT_CONTEXT_CUSTOM_TYPE = 'multivac.context';

/** 交给模型的上下文正文；明确其为用户数据，只用于理解指代与背景。 */
export function renderSessionContextForModel(context: CoordinatorSessionContext): string {
  if (context.kind === 'parent-session') {
    return [
      `这是从会话「${context.title}」深入出来的子会话：用户基于父会话中选中的一段内容展开讨论，`,
      '本会话的结论不会自动写回父会话。',
      '',
      '父会话中选中的内容：',
      context.selection ?? '',
      '',
      '父会话最近的内容摘录，仅供理解背景：',
      context.excerpt,
    ].join('\n');
  }
  return [
    `用户当前正在工作区里查看会话「${context.title}」，接下来消息中的“这个”通常指该会话。`,
    '以下是该会话最近的内容摘录，仅供理解上下文：',
    '',
    context.excerpt,
  ].join('\n');
}
