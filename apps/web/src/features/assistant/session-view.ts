import { ASSISTANT_DRAFT_MAX_UTF8_BYTES, type AssistantExecutor, type AssistantStreamingBehavior } from '@multivac/contracts';
import type { RunFeedback } from './command-feedback.js';
import { messagesWithEcho } from './local-echo.js';
import { draftSizeBytes } from './page-state-saver.js';
import { sameCommand } from './pending-command.js';
import { displayedRunFeedback, type SessionState } from './session-controller.js';
import type { SessionModelState } from './session-model.js';
import type { VisibleAssistantMessage } from './streaming-messages.js';
import { buildAssistantTimeline, type AssistantGroupedTimelineItem } from './tool-executions.js';

/** 由会话状态推导、供呈现实例直接使用的视图值。 */
export interface SessionView {
  displayMessages: readonly VisibleAssistantMessage[];
  echoId: string | null;
  timeline: AssistantGroupedTimelineItem[];
  /** 回复已在历史中出现的命令。 */
  visibleReplyCommands: ReadonlySet<string>;
  currentExecutor: AssistantExecutor | null;
  runFeedback: RunFeedback;
  runActive: boolean;
  runBusy: boolean;
  streamingBehavior: AssistantStreamingBehavior | '';
  canSubmit: boolean;
  canRetryUnknown: boolean;
  pendingSubmission: { commandId: string; agentId: string | undefined; unknown: boolean; confirmed: boolean; checking: boolean } | null;
}

export function deriveSessionView(
  state: SessionState,
  model: SessionModelState,
  imageDraft: { ids(): readonly string[]; ready: boolean },
): SessionView {
  const { history, page, activePrompt, pendingCommand } = state;
  const { messages, echoId } = messagesWithEcho(history.messages, state.localEcho);
  // 正文与工具记录按服务端时间戳合并，工具记录不会堆在会话末尾。
  const timeline = buildAssistantTimeline(messages, history.toolExecutions, history.commandAnchors, history.runTraces);
  const visibleReplyCommands = new Set(history.commandAnchors.flatMap((anchor) =>
    history.messages.some((message) => message.role === 'assistant' && message.runtimeEntryId === anchor.runtimeEntryId) ? [anchor.commandId] : []));
  for (const message of history.messages) {
    if (message.role === 'assistant' && message.commandId) visibleReplyCommands.add(message.commandId);
  }

  const runActive = activePrompt !== null;
  const selection = state.streamingBehaviorSelection;
  const streamingBehavior = activePrompt && selection && sameCommand(selection, activePrompt) ? selection.behavior : '';
  const runBusy = runActive || ['reconciling', 'accepted', 'handed'].includes(state.runFeedback.phase);
  const pendingReconciliation = !runActive && state.reconcilingCommandId !== null && pendingCommand?.commandId === state.reconcilingCommandId;
  const canRetryUnknown = pendingCommand?.unknown === true && pendingCommand.text === page.draft && pendingCommand.agentId === (page.agentId ?? undefined);
  const hasExecutor = Boolean(page.agentId) || Boolean(activePrompt && history.executors[activePrompt.commandId]) || model.available;
  const canSubmit = hasExecutor && !model.busy && (Boolean(page.draft.trim()) || imageDraft.ids().length > 0) && imageDraft.ready &&
    draftSizeBytes(page.draft) <= ASSISTANT_DRAFT_MAX_UTF8_BYTES && !state.submitting &&
    !pendingReconciliation && !pendingCommand?.clearOnSubmit && (!runActive || Boolean(streamingBehavior) || canRetryUnknown);

  return {
    displayMessages: messages,
    echoId,
    timeline,
    visibleReplyCommands,
    currentExecutor: activePrompt ? history.executors[activePrompt.commandId] ?? null : null,
    runFeedback: displayedRunFeedback(state),
    runActive,
    runBusy,
    streamingBehavior,
    canSubmit,
    canRetryUnknown,
    pendingSubmission: pendingCommand ? {
      commandId: pendingCommand.commandId, agentId: pendingCommand.agentId, unknown: pendingCommand.unknown,
      confirmed: pendingCommand.confirmed ?? false, checking: state.reconcilingCommandId === pendingCommand.commandId,
    } : null,
  };
}
