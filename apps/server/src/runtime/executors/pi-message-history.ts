import { NoteSnapshotSchema, type NoteSnapshot, BookReferenceSchema, ReadingReferenceKindSchema, type ReadingReferenceKind, type BookReference, type AssistantMessageSkill, type AssistantMessageView } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { createHash } from 'node:crypto';
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';
import {
  ASSISTANT_QUOTE_CUSTOM_TYPE,
  ASSISTANT_CONTEXT_CUSTOM_TYPE,
  ASSISTANT_SKILL_CUSTOM_TYPE,
  readAssistantQuoteDetails,
  readAssistantSkillDetails,
  type PiQuoteDetails,
  type PiFileQuoteDetails,
  type PiBookQuoteDetails,
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
      return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
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
  assistantSessionId?: string,
): AssistantMessageView[] {
  const seen = new Set<string>();
  const messages: AssistantMessageView[] = [];
  const messageCounts = new Map<string, number>();
  // 引用 entry 是其所属用户消息的父节点；按 entry id 索引即可还原归属，无需解析正文。
  const quotesByEntryId = new Map<string, PiQuoteDetails | PiFileQuoteDetails | PiBookQuoteDetails>();
  // Skill entry 可能与用户消息之间隔着引用 entry；归属紧随其后的第一条用户消息。
  let pendingSkill: AssistantMessageSkill | undefined;
  let noteContext: NoteSnapshot | undefined;
  let readingReference: BookReference | undefined;
  let readingPageReference: BookReference | undefined;
  let readingReferenceKind: ReadingReferenceKind | undefined;

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    if (entry.type === 'custom_message' && entry.customType === ASSISTANT_CONTEXT_CUSTOM_TYPE) {
      // appendContext 将来源直接写入 details；新上下文无有效来源时也不能沿用上一轮。
      const details = entry.details as { kind?: string; snapshot?: unknown; reference?: unknown; currentPage?: unknown; referenceKind?: unknown } | undefined;
      noteContext = details?.kind === 'note' && Check(NoteSnapshotSchema, details.snapshot) ? details.snapshot : undefined;
      readingReference = details?.kind === 'reading' && Check(BookReferenceSchema, details.reference)
        ? details.reference : undefined;
      readingPageReference = details?.kind === 'reading' && Check(BookReferenceSchema, details.currentPage) ? details.currentPage : undefined;
      readingReferenceKind = details?.kind === 'reading' && Check(ReadingReferenceKindSchema, details.referenceKind) ? details.referenceKind : undefined;
    }

    if (entry.type === 'custom_message' && entry.customType === ASSISTANT_SKILL_CUSTOM_TYPE) {
      pendingSkill = readAssistantSkillDetails(entry.details) ?? undefined;
      continue;
    }

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
    const imageIds = assistantSessionId && ['user', 'assistant', 'toolResult'].includes(entry.message.role) && 'content' in entry.message && Array.isArray(entry.message.content)
      ? entry.message.content.filter(block => block.type === 'image').slice(0, 4).map(block => blockImageIdentity(assistantSessionId, block)) : [];
    if ((!text && !imageIds.length) || (entry.message.role !== 'user' && entry.message.role !== 'assistant' && !(entry.message.role === 'toolResult' && imageIds.length))) {
      continue;
    }

    const quote = entry.message.role === 'user' && entry.parentId
      ? quotesByEntryId.get(entry.parentId)
      : undefined;
    const skill = entry.message.role === 'user' ? pendingSkill : undefined;
    pendingSkill = undefined;

    messages.push({
      id: `${piSessionId}:${entry.id}`,
      piSessionId,
      piEntryId: entry.id,
      role: entry.message.role === 'user' ? 'user' : 'assistant',
      ...(entry.message.role === 'toolResult' ? { toolName: entry.message.toolName } : {}),
      text: text ?? '',
      ...(imageIds.length ? { imageIds } : {}),
      createdAt: entry.timestamp,
      ...(noteContext ? { noteContext } : {}),
      ...(readingReference ? { readingReference } : {}),
      ...(readingPageReference ? { readingPageReference } : {}),
      ...(readingReferenceKind ? { readingReferenceKind } : {}),
      ...(skill ? { skill } : {}),
      ...(entry.message.role === 'assistant' || entry.message.role === 'user'
        ? { runtimeMessageId: count === 1 ? base : `${base}:${count}` } : {}),
      ...(quote
        ? {
            quote: 'quote' in quote ? quote.quote : {
              sourcePiSessionId: quote.sourcePiSessionId ?? piSessionId,
              sourcePiEntryId: quote.sourceEntryId,
              sourceRole: quote.sourceRole,
              text: quote.text,
              ...(quote.sourceSessionId ? { sourceSessionId: quote.sourceSessionId } : {}),
              ...(quote.sourceTitle ? { sourceTitle: quote.sourceTitle } : {}),
            },
          }
        : {}),
    });
  }

  return messages;
}

// 活动会话的 entry 常驻内存且不再修改：按图片块记住标识，每次读取分支不必重新解码并哈希整段历史图片。
const blockImageIdentities = new WeakMap<object, { sessionId: string; id: string }>();

function blockImageIdentity(sessionId: string, block: { data: string }): string {
  const cached = blockImageIdentities.get(block);
  if (cached?.sessionId === sessionId) return cached.id;
  const id = imageIdentity(sessionId, block.data);
  blockImageIdentities.set(block, { sessionId, id });
  return id;
}

export function imageIdentity(sessionId: string, data: string): string {
  // 不解码越界的历史载荷；该引用会明确显示为无效资源。
  return createHash('sha256').update(sessionId).update('\0').update(data.length <= 14 * 1024 * 1024 ? Buffer.from(data, 'base64') : data.slice(0, 128)).digest('hex');
}
