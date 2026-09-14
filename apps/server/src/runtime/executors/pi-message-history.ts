import type { AssistantMessageView } from '@multivac/contracts';
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';

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

  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);

    if (entry.type !== 'message') {
      continue;
    }
    const text = textFromMessage(entry);
    if (!text || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) {
      continue;
    }

    messages.push({
      id: `${piSessionId}:${entry.id}`,
      piSessionId,
      piEntryId: entry.id,
      role: entry.message.role,
      text,
      createdAt: entry.timestamp,
    });
  }

  return messages;
}
