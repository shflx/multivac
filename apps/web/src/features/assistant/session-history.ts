import type {
  AssistantCommandAnchor, AssistantExecutor, AssistantMessageView, AssistantPageState, AssistantSessionPageResponse,
} from '@multivac/contracts';
import { reconcileStreamingMessages, type StreamingHistorySnapshot, type VisibleAssistantMessage } from './streaming-messages.js';
import {
  hydrateRunTraces, hydrateToolExecutions, mergeRunTraces, type RunTrace, type ToolExecution,
} from './tool-executions.js';

/**
 * 会话历史在本页的合并规则：首次读取、最新快照回读与更早一批的拼接。
 * 消息按 id、工具记录按 toolCallId、轨迹按命令合并；正文流的取舍见 streaming-messages。
 */

export interface SessionHistory {
  messages: readonly VisibleAssistantMessage[];
  toolExecutions: readonly ToolExecution[];
  runTraces: readonly RunTrace[];
  /** 命令锚点来自会话快照，用于把工具记录放回所属 Turn。 */
  commandAnchors: readonly AssistantCommandAnchor[];
  /** 各命令的执行者（智能体）；只增不减，重新读取也保留已知的执行者。 */
  executors: Readonly<Record<string, AssistantExecutor>>;
  hasMore: boolean;
  nextBefore: string | null;
}

export const EMPTY_HISTORY: SessionHistory = {
  messages: [], toolExecutions: [], runTraces: [], commandAnchors: [], executors: {}, hasMore: false, nextBefore: null,
};

export function mergeMessages(
  earlier: readonly AssistantMessageView[],
  current: readonly AssistantMessageView[],
): AssistantMessageView[] {
  const seen = new Set<string>();
  return [...earlier, ...current].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function withExecutor(
  executors: Readonly<Record<string, AssistantExecutor>>,
  commandId: string,
  executor?: AssistantExecutor,
): Readonly<Record<string, AssistantExecutor>> {
  return executor ? { ...executors, [commandId]: executor } : executors;
}

function withPageExecutors(
  executors: Readonly<Record<string, AssistantExecutor>>,
  page: AssistantSessionPageResponse,
): Readonly<Record<string, AssistantExecutor>> {
  const known = [...(page.commandAnchors ?? []), ...(page.runTraces ?? [])]
    .flatMap((item) => item.executor ? [[item.commandId, item.executor] as const] : []);
  return known.length === 0 ? executors : { ...executors, ...Object.fromEntries(known) };
}

/** 首次（重新）读取：以快照为准，只保留已知的执行者。 */
export function historyFromPage(previous: SessionHistory, page: AssistantSessionPageResponse): SessionHistory {
  return {
    messages: reconcileStreamingMessages([], page),
    toolExecutions: hydrateToolExecutions([], page),
    runTraces: hydrateRunTraces(page),
    commandAnchors: page.commandAnchors ?? [],
    executors: withPageExecutors(previous.executors, page),
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
  };
}

/** 最新快照回读：终态工具记录以服务端投影为准并保留已展开的明细；期间手动加载过更早历史时保留已扩展窗口的分页边界。 */
export function applyHistorySnapshot(history: SessionHistory, snapshot: StreamingHistorySnapshot): SessionHistory {
  const { page, discardedStreamIds } = snapshot;
  const oldest = history.messages.find((message) => message.streamCursor === undefined);
  const keepsWindow = !oldest || page.messages.some((message) => message.id === oldest.id);
  return {
    messages: reconcileStreamingMessages(history.messages, page, discardedStreamIds),
    toolExecutions: hydrateToolExecutions(history.toolExecutions, page),
    runTraces: mergeRunTraces(history.runTraces, hydrateRunTraces(page)),
    commandAnchors: page.commandAnchors ?? [],
    executors: withPageExecutors(history.executors, page),
    hasMore: keepsWindow ? page.hasMore : history.hasMore,
    nextBefore: keepsWindow ? page.nextBefore : history.nextBefore,
  };
}

/** 拼接更早的一批：较新的已有内容优先，锚点按命令去重。 */
export function applyEarlierPage(history: SessionHistory, earlier: AssistantSessionPageResponse): SessionHistory {
  return {
    ...history,
    messages: mergeMessages(earlier.messages, history.messages),
    runTraces: mergeRunTraces(history.runTraces, hydrateRunTraces(earlier)),
    commandAnchors: [...new Map([...(earlier.commandAnchors ?? []), ...history.commandAnchors]
      .map((anchor) => [anchor.commandId, anchor])).values()],
    executors: withPageExecutors(history.executors, earlier),
    hasMore: earlier.hasMore,
    nextBefore: earlier.nextBefore,
  };
}

/** 首屏需包含阅读锚点所在消息：向前最多补读 10 批。 */
export async function loadInitialWindow(
  pageState: AssistantPageState,
  initialPage: AssistantSessionPageResponse,
  readEarlier: (before: string) => Promise<AssistantSessionPageResponse>,
  isCurrent: () => boolean,
): Promise<AssistantSessionPageResponse | null> {
  let page = initialPage;
  if (!pageState.anchorEntryId) return page;

  let messages = page.messages;
  let attempts = 0;
  while (
    isCurrent() &&
    !messages.some((message) => message.piEntryId === pageState.anchorEntryId) &&
    page.hasMore && page.nextBefore && attempts < 10
  ) {
    const earlier = await readEarlier(page.nextBefore);
    messages = mergeMessages(earlier.messages, messages);
    page = { ...page, messages, hasMore: earlier.hasMore, nextBefore: earlier.nextBefore };
    attempts += 1;
  }
  return isCurrent() ? page : null;
}
