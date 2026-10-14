import type { AssistantCommandAnchor, AssistantExecutor, AssistantMessageView, AssistantRunTraceView } from '@multivac/contracts';

/** 只沿命令和 Pi 消息身份关联，不按正文、名称或时间猜测执行者。 */
export function messageExecutor(
  message: Pick<AssistantMessageView, 'piEntryId' | 'runtimeMessageId'> & { commandId?: string | null },
  traces: readonly AssistantRunTraceView[],
  anchors: readonly AssistantCommandAnchor[],
  executors: Readonly<Record<string, AssistantExecutor>>,
): AssistantExecutor | undefined {
  if (message.commandId && executors[message.commandId]) return executors[message.commandId];
  const trace = message.runtimeMessageId ? traces.find(candidate => candidate.entries.some(entry =>
    (entry.kind === 'message' || entry.kind === 'user') && entry.messageId === message.runtimeMessageId)) : undefined;
  if (trace) return trace.executor ?? executors[trace.commandId];
  const anchor = anchors.find(candidate => candidate.piEntryId === message.piEntryId);
  return anchor?.executor ?? (anchor ? executors[anchor.commandId] : undefined);
}
