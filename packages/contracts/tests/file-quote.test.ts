import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Check } from 'typebox/value';
import { AssistantQuoteSchema, assistantQuoteWithinLimit, CurrentViewSnapshotSchema, type AssistantFileQuote } from '../src/index.js';

test('文件来源独立于消息身份，保留旧引用契约并拒绝伪造和无来源', () => {
  const quote: AssistantFileQuote = { sourceKind: 'file', sourceSessionId: 'work', sourceFile: { root: '/root', path: 'a.txt', line: 1 }, text: '原文' };
  assert.equal(Check(AssistantQuoteSchema, quote), true);
  assert.equal(Check(AssistantQuoteSchema, { sourcePiSessionId: 'pi', sourcePiEntryId: 'entry', sourceRole: 'assistant', text: '旧消息' }), true);
  assert.equal(Check(AssistantQuoteSchema, { ...quote, sourcePiEntryId: 'fake' }), false);
  assert.equal(Check(AssistantQuoteSchema, { ...quote, sourceSessionId: undefined }), false);
  assert.equal(assistantQuoteWithinLimit({ ...quote, text: '中'.repeat(2000) }), false);
  assert.equal(Check(CurrentViewSnapshotSchema, { panel: 'workspace', narrow: false, management: null, workspace: { workspaceId: 'default', scene: null, reading: { sessionId: 'work', root: '/root', path: '../secret', focus: 'file' } } }), false);
});
