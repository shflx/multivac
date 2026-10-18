import {
  parseSkillInvocation, skillRequestText,
  type AssistantContextRef, type AssistantMessageSkill, type AssistantQuote,
} from '@multivac/contracts';
import { sameQuote } from './message-quote.js';
import type { CommandIdentity } from './pending-command.js';
import type { VisibleAssistantMessage } from './streaming-messages.js';

/**
 * 刚发出、尚未回读到 Pi 历史的消息，用于本地回显。
 *
 * 它只是渲染层的临时行：没有 Pi entry，因此不作阅读锚点、不可被引用，
 * 也不会进入消息状态或流式对账。
 */
export interface LocalEcho extends CommandIdentity {
  imageIds?: string[];
  text: string;
  quote: AssistantQuote | null;
  contextRefs?: readonly AssistantContextRef[];
  omitQuote?: boolean;
  createdAt: string;
  /** 提交时历史中已有的同内容消息条数；超过它即说明本次消息已经回读到。 */
  baseline: number;
}

function readingEchoSource(echo: Pick<LocalEcho, 'contextRefs' | 'omitQuote'>) {
  const reading = echo.omitQuote ? echo.contextRefs?.find(ref => ref.kind === 'book') : undefined;
  return reading?.kind === 'book' ? { readingReference: reading.reference,
    ...(reading.pageReference ? { readingPageReference: reading.pageReference } : {}),
    ...(reading.referenceKind ? { readingReferenceKind: reading.referenceKind } : {}) } : {};
}

/** 待确认消息按服务端回显的形态呈现：Skill 选择行拆成标签，正文只保留本次请求。 */
function echoView(text: string): { text: string; skill?: AssistantMessageSkill } {
  const selection = parseSkillInvocation(text);
  return selection ? { text: skillRequestText(selection), skill: { ...selection.ref, label: selection.label } } : { text };
}

/** 历史中与回显内容相同的用户消息条数。 */
export function echoOccurrences(
  messages: readonly VisibleAssistantMessage[],
  echo: Pick<LocalEcho, 'text' | 'quote' | 'contextRefs' | 'omitQuote' | 'imageIds'>,
): number {
  const reading = echo.omitQuote ? echo.contextRefs?.find(ref => ref.kind === 'book') : undefined;
  const note = echo.contextRefs?.find(ref => ref.kind === 'note');
  const text = echoView(echo.text).text;
  return messages.filter((message) => message.role === 'user' &&
    message.streamCursor === undefined && message.text === text &&
    (note?.kind !== 'note' || message.noteContext?.id === note.snapshotId) &&
    (reading?.kind === 'book' ? JSON.stringify(message.readingReference) === JSON.stringify(reading.reference)
      : sameQuote(message.quote ?? null, echo.quote)) && JSON.stringify(message.imageIds ?? []) === JSON.stringify(echo.imageIds ?? [])).length;
}

/**
 * 带回显的消息列表。回显只在本次消息尚未回读到历史时出现；一旦 Pi 历史带回同一条，就交还给历史渲染。
 * 回显排在本命令的在途正文之前：运行中正文与工具记录都属于这条消息之后的一轮。
 */
export function messagesWithEcho(
  messages: readonly VisibleAssistantMessage[],
  echo: LocalEcho | null,
): { messages: readonly VisibleAssistantMessage[]; echoId: string | null } {
  if (!echo || echoOccurrences(messages, echo) > echo.baseline) return { messages, echoId: null };
  const id = `pending:${echo.commandId}`;
  const row: VisibleAssistantMessage = {
    id,
    piSessionId: messages.at(-1)?.piSessionId ?? '',
    piEntryId: id,
    role: 'user',
    ...echoView(echo.text),
    imageIds: echo.imageIds ?? [],
    createdAt: echo.createdAt,
    commandId: echo.commandId,
    // 没有 Pi entry：该行不做阅读锚点，也不作为引用来源。
    streamCursor: Number.MAX_SAFE_INTEGER,
    ...(echo.quote && !echo.omitQuote ? { quote: echo.quote } : {}),
    ...readingEchoSource(echo),
  };
  const index = messages.findIndex((message) => message.commandId === echo.commandId);
  return {
    messages: index < 0 ? [...messages, row] : [...messages.slice(0, index), row, ...messages.slice(index)],
    echoId: id,
  };
}
