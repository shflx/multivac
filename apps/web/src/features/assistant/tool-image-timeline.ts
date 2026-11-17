import type { VisibleAssistantMessage } from './streaming-messages.js';
import type { AssistantGroupedTimelineItem } from './tool-executions.js';

/** 工具图片是可见结果，不属于可折叠的过程说明；附带文字仅供模型使用。 */
export function isToolImageMessage(message: VisibleAssistantMessage): boolean {
  return Boolean(message.toolName && message.imageIds?.length);
}

/** 只在组首返回连续图片的下标；文字、轨迹与插入的任务回应都会断开分组。 */
export function toolImageGroup(
  timeline: readonly AssistantGroupedTimelineItem[],
  index: number,
  breakBefore: (index: number) => boolean,
): number[] {
  const isImage = (position: number) => {
    const item = timeline[position];
    return item?.kind === 'message' && isToolImageMessage(item.message);
  };
  if (!isImage(index) || (isImage(index - 1) && !breakBefore(index))) return [];
  const group = [index];
  for (let next = index + 1; isImage(next) && !breakBefore(next); next += 1) group.push(next);
  return group;
}
