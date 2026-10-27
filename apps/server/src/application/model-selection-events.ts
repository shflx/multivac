import type { AssistantEventStream } from './assistant-event-stream.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

const lifecycleEvents = new Set([
  'assistant.command.accepted', 'assistant.command.handed_to_pi', 'assistant.command.rejected',
  'assistant.command.reconciled', 'assistant.turn.started', 'assistant.turn.ended',
  'assistant.run.processing', 'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled',
  'assistant.retry.started', 'assistant.retry.ended', 'assistant.compaction.started', 'assistant.compaction.ended',
]);

/** 覆盖所有会话；只通知重读，运行门禁仍由真实命令和 Pi 状态判定。 */
export function subscribeModelSelectionLifecycle(stream: AssistantEventStream, events: WorkbenchEventPublisher): () => void {
  return stream.subscribe(event => {
    if (event.type === 'assistant.tool.started' || event.type === 'assistant.tool.ended') events.publish({ type: 'session-context.changed', sessionId: event.assistantSessionId });
    if (lifecycleEvents.has(event.type)) events.publish({ type: 'model-selection.changed', sessionId: event.assistantSessionId });
  });
}
