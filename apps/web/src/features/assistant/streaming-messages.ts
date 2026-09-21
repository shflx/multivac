import type { AssistantMessageView, AssistantPublicEvent, AssistantSessionPageResponse } from '@multivac/contracts';

export type VisibleAssistantMessage = AssistantMessageView & {
  streamCursor?: number;
  commandId?: string | null;
};

function messageIdentity(message: Pick<AssistantMessageView, 'piSessionId' | 'runtimeMessageId'> & { id?: string }): string {
  return `${message.piSessionId}:${message.runtimeMessageId ?? `entry:${message.id}`}`;
}

export function admitStreamingSnapshot(snapshotCursor: number, historyCursor: number, consumedCursor: number) {
  return {
    admitted: snapshotCursor >= historyCursor,
    historyCursor: Math.max(snapshotCursor, historyCursor),
    resumeCursor: Math.max(snapshotCursor, historyCursor, consumedCursor),
  };
}

export interface StreamingHistorySnapshot {
  page: AssistantSessionPageResponse;
  discardedStreamIds: string[];
}

/** 补齐连续历史后再校准正文；较早分页只补历史，保留首个快照的正文和事件水位。 */
export async function loadStreamingHistory(
  current: readonly VisibleAssistantMessage[],
  latest: AssistantSessionPageResponse,
  readEarlier: (before: string) => Promise<AssistantSessionPageResponse>,
  isCurrent: () => boolean,
): Promise<StreamingHistorySnapshot> {
  const active = new Set((latest.streamingMessages ?? []).map((message) =>
    `${message.piSessionId}:${message.messageId}`));
  const pending = new Set(current.filter((message) => message.streamCursor !== undefined &&
    message.streamCursor <= Number(latest.eventCursor) && !active.has(messageIdentity(message)))
    .map(messageIdentity));
  const oldest = current.find((message) => message.streamCursor === undefined &&
    message.piSessionId === latest.piSessionId);
  let page = latest;
  let messages = [...latest.messages];
  const seen = new Set(messages.map((message) => message.id));
  const completed = new Set(messages.map(messageIdentity));
  const visited = new Set<string>();
  while (isCurrent() && page.hasMore && page.nextBefore &&
      ((oldest && !seen.has(oldest.id)) || [...pending].some((id) => !completed.has(id)))) {
    if (visited.has(page.nextBefore)) throw new Error('历史分页未向前推进。');
    visited.add(page.nextBefore);
    page = await readEarlier(page.nextBefore);
    if (page.piSessionId !== latest.piSessionId) throw new Error('历史分页会话身份已变化。');
    const earlier = page.messages.filter((message) => !seen.has(message.id));
    for (const message of earlier) {
      seen.add(message.id);
      completed.add(messageIdentity(message));
    }
    messages = [...earlier, ...messages];
  }
  const requiredIndices = messages.flatMap((message, index) =>
    message.id === oldest?.id || pending.has(messageIdentity(message)) ? [index] : []);
  const start = requiredIndices.length ? Math.min(...requiredIndices) : 0;
  const covered = messages.slice(start);
  const hasMore = start > 0 || page.hasMore;
  return {
    page: { ...latest, messages: covered, hasMore,
      nextBefore: hasMore ? covered[0]?.piEntryId ?? page.nextBefore : null },
    // 只有遍历至历史起点仍无记录，才能确认该终态正文没有持久化替换。
    discardedStreamIds: !page.hasMore ? [...pending].filter((id) => !completed.has(id)) : [],
  };
}

/** 快照水位只覆盖已读取的增量；迟到快照不能覆盖水位之后的新正文。 */
export function reconcileStreamingMessages(
  current: readonly VisibleAssistantMessage[],
  page: AssistantSessionPageResponse,
  discardedStreamIds: readonly string[] = [],
): VisibleAssistantMessage[] {
  const cursor = Number(page.eventCursor);
  const history = new Map(page.messages.map((message) => [message.id, message]));
  const completed = new Set([
    ...page.messages,
    ...current.filter((message) => message.streamCursor === undefined),
  ].map(messageIdentity));
  const merged: VisibleAssistantMessage[] = [
    ...current.filter((message) => message.streamCursor === undefined && !history.has(message.id)),
    ...page.messages,
  ];
  const streams = new Map<string, VisibleAssistantMessage>((page.streamingMessages ?? []).map((message) => {
    const id = `stream:${message.piSessionId}:${message.messageId}`;
    return [id, {
      id, piEntryId: id, role: 'assistant', piSessionId: message.piSessionId,
      runtimeMessageId: message.messageId, text: message.text, createdAt: message.createdAt,
      streamCursor: cursor,
      ...(message.commandId === undefined ? {} : { commandId: message.commandId }),
    }];
  }));
  for (const [id, message] of streams) {
    if (completed.has(messageIdentity(message))) streams.delete(id);
  }
  const discarded = new Set(discardedStreamIds);
  for (const message of current) {
    if (message.streamCursor !== undefined && !completed.has(messageIdentity(message)) &&
        !(discarded.has(messageIdentity(message)) && message.streamCursor <= cursor) &&
        (message.streamCursor > cursor || !streams.has(message.id))) {
      streams.set(message.id, message);
    }
  }
  const canonicalIds = new Map(merged.map((message) => [messageIdentity(message), message.id]));
  for (let index = 0; index < current.length; index += 1) {
    const message = current[index]!;
    const stream = streams.get(message.id);
    if (!stream) continue;
    const successor = current.slice(index + 1).find((item) => canonicalIds.has(messageIdentity(item)));
    const position = successor
      ? merged.findIndex((item) => item.id === canonicalIds.get(messageIdentity(successor))) : -1;
    if (position < 0) merged.push(stream);
    else merged.splice(position, 0, stream);
    streams.delete(message.id);
  }
  merged.push(...streams.values());
  return merged;
}

export function appendStreamingDelta(
  current: readonly VisibleAssistantMessage[],
  event: Extract<AssistantPublicEvent, { type: 'assistant.message.delta' }>,
): VisibleAssistantMessage[] {
  const { piSessionId, messageId, delta } = event.data;
  if (!delta || current.some((message) => message.streamCursor === undefined &&
      message.piSessionId === piSessionId && message.runtimeMessageId === messageId)) return [...current];
  const id = `stream:${piSessionId}:${messageId}`;
  const previous = current.find((message) => message.id === id);
  const cursor = Number(event.cursor);
  if (previous?.streamCursor !== undefined && previous.streamCursor >= cursor) return [...current];
  const next: VisibleAssistantMessage = {
    id, piSessionId, piEntryId: id, runtimeMessageId: messageId, role: 'assistant',
    text: (previous?.text ?? '') + delta,
    createdAt: previous?.createdAt ?? event.occurredAt, streamCursor: cursor,
    commandId: previous?.commandId ?? event.commandId,
  };
  return previous ? current.map((message) => message.id === id ? next : message) : [...current, next];
}
