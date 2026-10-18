import type { AssistantMessageView } from '@multivac/contracts';

/** 测试用的书伴讨论历史：默认不可读；需要来源消息的用例传入固定结果。 */
export async function unreadableReadingHistory(): Promise<readonly AssistantMessageView[]> {
  throw new Error('测试未提供书伴讨论历史。');
}
