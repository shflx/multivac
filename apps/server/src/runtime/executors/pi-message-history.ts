import type { AssistantMessageView } from '@multivac/contracts';
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import {
  ASSISTANT_QUOTE_CUSTOM_TYPE,
  readAssistantQuoteDetails,
  type PiQuoteDetails,
} from './pi-quote-carriage.js';

function textFromMessage(entry: SessionMessageEntry): string | undefined {
  const message = entry.message;
  switch (message.role) {
    case 'user': {
      const content = message.content;
      const text = typeof content === 'string'
        ? content
        : content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
      return text.trim() ? text : undefined;
    }
    case 'assistant': {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      return text.trim() ? text : undefined;
    }
    case 'toolResult':
    case 'bashExecution':
    case 'custom':
    case 'branchSummary':
    case 'compactionSummary':
      return undefined;
    default:
      return undefined;
  }
}

/** 只投影 active branch 的可见文本，Pi 原始对象不会离开 executors。 */
export function mapPiActiveBranch(
  piSessionId: string,
  entries: readonly SessionEntry[],
): AssistantMessageView[] {
  const seen = new Set<string>();
  const messages: AssistantMessageView[] = [];
  const messageCounts = new Map<string, number>();
  // 引用 entry 是其所属用户消息的父节点；按 entry id 索引即可还原归属，无需解析正文。
  const quotesByEntryId = new Map<string, PiQuoteDetails>();

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);

    if (entry.type === 'custom_message' && entry.customType === ASSISTANT_QUOTE_CUSTOM_TYPE) {
      const details = readAssistantQuoteDetails(entry.details);
      if (details) quotesByEntryId.set(entry.id, details);
      continue;
    }

    if (entry.type !== 'message') {
      continue;
    }
    const base = `${entry.message.role}:${'timestamp' in entry.message ? entry.message.timestamp : 'unknown'}`;
    const count = (messageCounts.get(base) ?? 0) + 1;
    messageCounts.set(base, count);
    const text = textFromMessage(entry);
    if (!text || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) {
      continue;
    }

    const quote = entry.message.role === 'user' && entry.parentId
      ? quotesByEntryId.get(entry.parentId)
      : undefined;

    messages.push({
      id: `${piSessionId}:${entry.id}`,
      piSessionId,
      piEntryId: entry.id,
      role: entry.message.role,
      text,
      createdAt: entry.timestamp,
      ...(entry.message.role === 'assistant'
        ? { runtimeMessageId: count === 1 ? base : `${base}:${count}` } : {}),
      ...(quote
        ? {
            quote: {
              sourcePiSessionId: piSessionId,
              sourcePiEntryId: quote.sourceEntryId,
              sourceRole: quote.sourceRole,
              text: quote.text,
            },
          }
        : {}),
    });
  }

  return messages;
}
