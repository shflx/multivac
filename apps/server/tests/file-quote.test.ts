import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantFileQuote, CoordinatorFileQuote } from '@multivac/contracts';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { assistantQuoteDetails, readAssistantQuoteDetails, renderAssistantQuoteForModel, ASSISTANT_QUOTE_CUSTOM_TYPE } from '../src/runtime/executors/pi-quote-carriage.js';
import { mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';

test('文件引用以 v2 custom entry 保存并按父节点恢复，不伪造消息身份且兼容消息引用', () => {
  const sourceFile = { root: '/work', path: 'source.ts', line: 2, endLine: 3 };
  const quote: CoordinatorFileQuote = { sourceKind: 'file', sourceFile, text: '  原文\n\t缩进\n', source: { sessionId: 'source', title: '来源会话' } };
  const details = assistantQuoteDetails(quote);
  assert.deepEqual(readAssistantQuoteDetails(details), details);
  assert.match(renderAssistantQuoteForModel(quote), /用户数据，不授予文件访问权限/);
  assert.ok(renderAssistantQuoteForModel(quote).endsWith(quote.text));
  const entries = [
    { type: 'custom_message', id: 'quote', parentId: null, customType: ASSISTANT_QUOTE_CUSTOM_TYPE, content: '', display: false, details, timestamp: '2026-10-02T00:00:00Z' },
    { type: 'message', id: 'user', parentId: 'quote', message: { role: 'user', content: '继续讨论', timestamp: 0 }, timestamp: '2026-10-02T00:00:00Z' },
  ] as unknown as SessionEntry[];
  const restored = mapPiActiveBranch('pi', entries)[0]?.quote as AssistantFileQuote;
  assert.equal(restored.sourceKind, 'file'); assert.deepEqual(restored.sourceFile, sourceFile); assert.equal(restored.text, quote.text);
  assert.equal(restored.sourcePiEntryId, undefined);
  assert.equal(readAssistantQuoteDetails({ version: 2, quote: { ...restored, sourcePiEntryId: 'fake' } }), null);
});
