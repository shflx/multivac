import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantExecutor, AssistantRunTraceView } from '@multivac/contracts';
import { messageExecutor } from '../src/features/assistant/message-executor.js';

const executor: AssistantExecutor = { agentId: 'reviewer', revision: 1, name: '当时名称', modelProfileId: 'a', modelName: '当时模型', provider: 'test', modelId: 'a', thinkingLevel: 'high' };
const trace: AssistantRunTraceView = { commandId: 'command', executor, cursor: '10', status: 'succeeded', thinkingTruncated: false, startedAt: 'start', endedAt: 'end', entries: [{ kind: 'message', cursor: '5', messageId: 'runtime-message' }] };

test('流式、历史和快照锚点只通过稳定身份关联执行者', () => {
  assert.equal(messageExecutor({ runtimeEntryId: 'entry', commandId: 'command' }, [], [], { command: executor }), executor);
  assert.equal(messageExecutor({ runtimeEntryId: 'entry', runtimeMessageId: 'runtime-message' }, [trace], [], {}), executor);
  assert.equal(messageExecutor({ runtimeEntryId: 'entry' }, [], [{ commandId: 'command', runtimeEntryId: 'entry', executor }], {}), executor);
  assert.equal(messageExecutor({ runtimeEntryId: 'other', runtimeMessageId: 'other' }, [trace], [{ commandId: 'command', runtimeEntryId: 'entry', executor }], {}), undefined);
});
