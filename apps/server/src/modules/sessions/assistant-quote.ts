import type { AssistantMessageView, AssistantQuote } from '@multivac/contracts';
import {
  ASSISTANT_QUOTE_MAX_UTF8_BYTES,
  assistantQuoteWithinLimit,
} from '@multivac/contracts';

export interface AssistantQuoteRejection {
  code: 'INVALID_REQUEST';
  message: string;
}

export interface AssistantQuoteSourceContext {
  piSessionId: string;
  messages: readonly AssistantMessageView[];
}

/**
 * 校验引用是否真实来自当前会话的某条可读消息。
 *
 * 只核对来源归属与角色，不核对文本是否为来源正文的子串：
 * 引用取自已渲染的可见文本，与 Pi 中的原始 Markdown 并不逐字相等。
 */
export function validateAssistantQuote(
  quote: AssistantQuote,
  context: AssistantQuoteSourceContext,
): AssistantQuoteRejection | null {
  if (!quote.text.trim()) {
    return { code: 'INVALID_REQUEST', message: '引用内容不能为空。' };
  }

  if (!assistantQuoteWithinLimit(quote)) {
    return {
      code: 'INVALID_REQUEST',
      message: `引用内容超过 ${ASSISTANT_QUOTE_MAX_UTF8_BYTES / 1024} KiB UTF-8 上限，请缩短选区后重试。`,
    };
  }

  if (quote.sourcePiSessionId !== context.piSessionId) {
    return { code: 'INVALID_REQUEST', message: '引用来源不属于当前会话。' };
  }

  const source = context.messages.find((message) => message.piEntryId === quote.sourcePiEntryId);
  if (!source) {
    return { code: 'INVALID_REQUEST', message: '引用来源消息不在当前分支的可读历史中。' };
  }
  if (source.role !== quote.sourceRole) {
    return { code: 'INVALID_REQUEST', message: '引用来源消息的角色与声明不一致。' };
  }

  return null;
}
