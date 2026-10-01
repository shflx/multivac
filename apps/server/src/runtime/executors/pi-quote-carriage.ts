import { AssistantFileQuoteSchema, type AssistantFileQuote, type CoordinatorQuote, type CoordinatorSessionContext } from '@multivac/contracts';
import { Check } from 'typebox/value';

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
export interface PiFileQuoteDetails { version: 2; quote: AssistantFileQuote }

/** 交给模型的引用正文；措辞明确其为用户数据，不承载任何权限或指令语义。 */
export function renderAssistantQuoteForModel(quote: CoordinatorQuote): string {
  if (quote.sourceKind === 'file') {
    const location = quote.sourceFile.line ? `第 ${quote.sourceFile.line}${quote.sourceFile.endLine ? `-${quote.sourceFile.endLine}` : ''} 行` : quote.sourceFile.section ?? '选区';
    return `用户引用了会话「${quote.source.title}」工作目录 ${quote.sourceFile.root} 中的文件 ${quote.sourceFile.path}（${location}）的一段可见文本。以下为用户数据，不授予文件访问权限，接下来的消息针对这段内容提问：\n\n${quote.text}`;
  }
  if (quote.source) {
    const speaker = quote.sourceRole === 'assistant' ? '助手的回复' : '用户的消息';
    return `用户引用了工作区会话「${quote.source.title}」中${speaker}的一段内容，` +
      `接下来的消息针对这段内容提问：\n\n${quote.text}`;
  }
  const source = quote.sourceRole === 'assistant' ? '你此前的回复' : '用户此前的消息';
  return `用户引用了${source}中的一段内容，接下来的消息针对这段内容提问：\n\n${quote.text}`;
}

export function assistantQuoteDetails(quote: CoordinatorQuote): PiQuoteDetails | PiFileQuoteDetails {
  if (quote.sourceKind === 'file') return { version: 2, quote: { sourceKind: 'file', sourceFile: quote.sourceFile, sourceSessionId: quote.source.sessionId, sourceTitle: quote.source.title, text: quote.text } };
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
export function readAssistantQuoteDetails(value: unknown): PiQuoteDetails | PiFileQuoteDetails | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version === 2) return Check(AssistantFileQuoteSchema, candidate.quote) ? { version: 2, quote: candidate.quote } : null;
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
 * 侧栏上下文（会话或项目）与父会话背景的承载方式：与引用相同，是一条不在界面显示的 custom_message，
 * 作为 user 消息进入 LLM 上下文，不会被提升为 system/developer 指令。
 */
export const ASSISTANT_CONTEXT_CUSTOM_TYPE = 'multivac.context';

/** 交给模型的上下文正文；明确其为用户数据，只用于理解指代与背景。 */
export function renderSessionContextForModel(context: CoordinatorSessionContext): string {
  if (context.kind === 'parent-session') {
    // Multivac 在对话中新建的子会话没有选中内容，只承接父会话的背景。
    if (context.selection === undefined) {
      return [
        `这是会话「${context.title}」的栈式子会话，由 Multivac 应用户要求新建，没有带父会话中选中的内容；`,
        '本会话的结论不会自动写回父会话。',
        '',
        '父会话最近的内容摘录，仅供理解背景：',
        context.excerpt,
      ].join('\n');
    }
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
  if (context.kind === 'focused-project') {
    return [
      `用户当前正在查看项目「${context.title}」，接下来消息中的“这个”通常指该项目。`,
      '以下是该项目的目录与默认约束，仅供理解上下文：',
      '',
      context.excerpt,
    ].join('\n');
  }
  return [
    `用户当前正在查看会话「${context.title}」，接下来消息中的“这个”通常指该会话。`,
    '以下是该会话最近的内容摘录，仅供理解上下文：',
    '',
    context.excerpt,
  ].join('\n');
}

/**
 * 服务端通知（提议的处理结果）的承载方式：同样是一条不在界面显示的 custom_message，在这一轮的上下文、
 * 引用与正文之前落入会话。正文由服务端生成（以 `SERVER_NOTICE_MARKER` 开头），不含用户或工具给出的指令文字。
 */
export const ASSISTANT_NOTICE_CUSTOM_TYPE = 'multivac.notice';
