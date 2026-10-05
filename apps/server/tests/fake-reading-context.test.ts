import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoordinatorRuntimeConfig, CoordinatorSessionContext, BookReference } from '@multivac/contracts';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';

test('阅读夹具历史按轮次保留引用类型和当前页，后续选区不回写旧消息', async () => {
  const adapter = new FakeCoordinatorAdapter();
  const config: CoordinatorRuntimeConfig = { systemPrompt: '共读。', authorizedContext: [],
    model: { provider: 'fake', modelId: 'fake-model', thinkingLevel: 'medium' },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 }, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 } };
  await adapter.createSession({ assistantSessionId: 'reading-context-fixture', config, workingDirectory: { kind: 'session-temp', path: '/workspace' } });
  const reference: BookReference = { bookId: 'book', version: 'version', start: { chapterId: 'c', paragraphId: 'p', offset: 0 }, end: { chapterId: 'c', paragraphId: 'p', offset: 2 }, text: '选区' };
  const page: BookReference = { ...reference, end: { ...reference.end, offset: 5 }, text: '选区与页面' };
  const first: CoordinatorSessionContext = { kind: 'reading', title: '测试书', reference, currentPage: page, referenceKind: 'selection', excerpt: reference.text, boundary: null, truncated: false };
  await adapter.prompt('reading-context-fixture', '本次引用。', undefined, first);
  await adapter.prompt('reading-context-fixture', '下一轮回到当前页。', undefined, { ...first, reference: page, referenceKind: 'current-page' });
  const history = await adapter.readActiveBranch('reading-context-fixture'); assert.equal(history.ok, true);
  if (!history.ok) throw new Error(history.error.message);
  const messages = history.value.messages.filter(message => ['本次引用。', '下一轮回到当前页。'].includes(message.text));
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.readingReferenceKind, 'selection'); assert.deepEqual(messages[0]!.readingReference, reference); assert.deepEqual(messages[0]!.readingPageReference, page);
  assert.equal(messages[1]!.readingReferenceKind, 'current-page'); assert.deepEqual(messages[1]!.readingReference, page); assert.deepEqual(messages[1]!.readingPageReference, page);
});
