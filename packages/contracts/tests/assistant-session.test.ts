import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import {
  ASSISTANT_API_ERROR_CODES,
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  ASSISTANT_QUOTE_MAX_UTF8_BYTES,
  ASSISTANT_SESSION_MAX_LIMIT,
  AssistantApiErrorResponseSchema,
  AssistantMessageViewSchema,
  AssistantPageStatePutSchema,
  AssistantQuoteSchema,
  AssistantSessionPageResponseSchema,
  AssistantSessionQuerySchema,
  AssistantStreamingMessageViewSchema,
  PiMessageReferenceSchema,
  SendAssistantMessageCommandSchema,
  assistantQuoteSizeBytes,
  assistantQuoteWithinLimit,
  assistantToolInputSummary,
  assistantToolKeyArgument,
} from '../src/index.js';

const quote = {
  sourcePiSessionId: 'pi-1',
  sourcePiEntryId: 'entry-1',
  sourceRole: 'assistant' as const,
  text: '第一行\n\n    保留缩进的第二行',
};

test('Multivac contracts 校验引用、消息、分页和页面状态', () => {
  assert.equal(Check(PiMessageReferenceSchema, {
    piSessionId: 'pi-1',
    piEntryId: 'entry-1',
  }), true);
  assert.equal(Check(AssistantMessageViewSchema, {
    id: 'pi-1:entry-1',
    piSessionId: 'pi-1',
    piEntryId: 'entry-1',
    role: 'assistant',
    text: '已完成当前检查。',
    createdAt: '2026-09-14T08:00:00.000Z',
  }), true);
  assert.equal(Check(AssistantMessageViewSchema, {
    id: 'pi-1:entry-1',
    piSessionId: 'pi-1',
    piEntryId: 'entry-1',
    role: 'tool',
    text: '不应公开',
    createdAt: '2026-09-14T08:00:00.000Z',
  }), false);

  assert.equal(Check(AssistantSessionQuerySchema, { limit: ASSISTANT_SESSION_MAX_LIMIT }), true);
  assert.equal(Check(AssistantSessionQuerySchema, { limit: ASSISTANT_SESSION_MAX_LIMIT + 1 }), false);
  assert.equal(Check(AssistantSessionPageResponseSchema, {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-1',
    messages: [],
    hasMore: false,
    nextBefore: null,
    cursor: 'snapshot-1',
    eventCursor: '0',
  }), true);
  assert.equal(Check(AssistantPageStatePutSchema, {
    draft: '未发送草稿',
    anchorEntryId: null,
    anchorOffsetPx: 0,
    revision: 0,
  }), true);
  assert.equal(Check(AssistantPageStatePutSchema, {
    draft: '',
    anchorEntryId: null,
    anchorOffsetPx: 0,
    revision: -1,
  }), false);
  assert.equal(Check(AssistantPageStatePutSchema, {
    draft: 'x'.repeat(ASSISTANT_DRAFT_MAX_UTF8_BYTES),
    anchorEntryId: null,
    anchorOffsetPx: 0,
    revision: 0,
  }), true);
  assert.equal(Check(AssistantPageStatePutSchema, {
    draft: 'x'.repeat(ASSISTANT_DRAFT_MAX_UTF8_BYTES + 1),
    anchorEntryId: null,
    anchorOffsetPx: 0,
    revision: 0,
  }), false);
});

test('引用契约限定来源身份与文本快照，并按 UTF-8 字节判定上限', () => {
  assert.equal(Check(AssistantQuoteSchema, quote), true);
  // 来源三元组缺一不可，服务端才能核对归属。
  for (const key of ['sourcePiSessionId', 'sourcePiEntryId', 'sourceRole', 'text'] as const) {
    const { [key]: _removed, ...partial } = quote;
    assert.equal(Check(AssistantQuoteSchema, partial), false, key);
  }
  assert.equal(Check(AssistantQuoteSchema, { ...quote, sourceRole: 'tool' }), false);
  assert.equal(Check(AssistantQuoteSchema, { ...quote, text: '' }), false);
  // 引用只描述来源，不接受任何 Pi 路径或指令提升字段。
  for (const extra of [{ piSessionPath: '/tmp/pi.jsonl' }, { role: 'system' }, { instructions: 'x' }]) {
    assert.equal(Check(AssistantQuoteSchema, { ...quote, ...extra }), false);
  }

  const chinese = '中'.repeat(Math.floor(ASSISTANT_QUOTE_MAX_UTF8_BYTES / 3));
  assert.equal(assistantQuoteSizeBytes(chinese), chinese.length * 3);
  assert.equal(assistantQuoteWithinLimit({ ...quote, text: chinese }), true);
  assert.equal(assistantQuoteWithinLimit({ ...quote, text: `${chinese}中中` }), false);
  assert.equal(
    assistantQuoteWithinLimit({ ...quote, text: 'x'.repeat(ASSISTANT_QUOTE_MAX_UTF8_BYTES) }),
    true,
  );

  // 旧消息与旧页面状态没有引用字段，必须照常通过校验。
  const message = {
    id: 'pi-1:entry-9', piSessionId: 'pi-1', piEntryId: 'entry-9', role: 'user' as const,
    text: '这段是什么意思？', createdAt: '2026-09-22T08:00:00.000Z',
  };
  assert.equal(Check(AssistantMessageViewSchema, message), true);
  assert.equal(Check(AssistantMessageViewSchema, { ...message, quote }), true);
  assert.equal(Check(AssistantMessageViewSchema, { ...message, quote: null }), false);

  const pageState = { draft: '继续讨论', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 };
  assert.equal(Check(AssistantPageStatePutSchema, pageState), true);
  assert.equal(Check(AssistantPageStatePutSchema, { ...pageState, quote }), true);
  assert.equal(Check(AssistantPageStatePutSchema, { ...pageState, quote: null }), true);

  const command = {
    commandId: 'command-1', assistantSessionId: 'global-coordinator',
    text: '这段是什么意思？', contextRefs: [] as [],
  };
  assert.equal(Check(SendAssistantMessageCommandSchema, command), true);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, quote }), true);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, quote: null }), false);
  // 只有引用没有正文不构成一次发送。
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...command, text: '', quote }), false);
});

test('在途正文恢复契约不伪造 Pi entry 且拒绝 thinking/tool payload', () => {
  const message = {
    piSessionId: 'pi-1', messageId: 'assistant:1:2', text: '在途正文',
    createdAt: '2026-09-17T00:00:00Z',
  };
  assert.equal(Check(AssistantStreamingMessageViewSchema, message), true);
  for (const extra of [{ piEntryId: 'fake' }, { thinking: 'secret' }, { toolPayload: {} }]) {
    assert.equal(Check(AssistantStreamingMessageViewSchema, { ...message, ...extra }), false);
  }
});

test('Multivac 错误响应只接受稳定错误码', () => {
  for (const code of ASSISTANT_API_ERROR_CODES) {
    assert.equal(Check(AssistantApiErrorResponseSchema, {
      error: { code, message: '稳定错误信息。' },
    }), true, code);
  }
  assert.equal(Check(AssistantApiErrorResponseSchema, {
    error: { code: 'PI_INTERNAL_ERROR', message: '不应透传。' },
  }), false);
});

test('工具关键参数按工具登记，摘要取入参投影首个非空行', () => {
  assert.equal(assistantToolKeyArgument('read'), 'path');
  assert.equal(assistantToolKeyArgument('bash'), 'command');
  assert.equal(assistantToolKeyArgument('grep'), 'pattern');
  assert.equal(assistantToolKeyArgument('custom_tool'), undefined);

  assert.equal(assistantToolInputSummary('\npath: /repo/package.json\nlimit: 200'), 'path: /repo/package.json');
  assert.equal(assistantToolInputSummary(''), null);
  assert.equal(assistantToolInputSummary(null), null);
  const long = `path: /${'a'.repeat(200)}`;
  assert.equal(assistantToolInputSummary(long), `${long.slice(0, 120)}…`);
});

test('@multivac/contracts 的助手会话契约不依赖 Node、SQLite 或 Pi SDK', async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  const source = await readFile(resolve(sourceRoot, 'assistant-session.ts'), 'utf8');

  assert.equal(source.includes('node:'), false);
  assert.equal(source.includes('@earendil-works/pi-'), false);
  assert.equal(/sqlite|better-sqlite/u.test(source), false);
  assert.equal(source.includes('piSessionPath'), false);
});
