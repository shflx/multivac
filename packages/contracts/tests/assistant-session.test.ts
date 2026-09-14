import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import {
  ASSISTANT_API_ERROR_CODES,
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  ASSISTANT_SESSION_MAX_LIMIT,
  AssistantApiErrorResponseSchema,
  AssistantMessageViewSchema,
  AssistantPageStatePutSchema,
  AssistantSessionPageResponseSchema,
  AssistantSessionQuerySchema,
  PiMessageReferenceSchema,
} from '../src/index.js';

test('协调助手 contracts 校验引用、消息、分页和页面状态', () => {
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

test('协调助手错误响应只接受稳定错误码', () => {
  for (const code of ASSISTANT_API_ERROR_CODES) {
    assert.equal(Check(AssistantApiErrorResponseSchema, {
      error: { code, message: '稳定错误信息。' },
    }), true, code);
  }
  assert.equal(Check(AssistantApiErrorResponseSchema, {
    error: { code: 'PI_INTERNAL_ERROR', message: '不应透传。' },
  }), false);
});

test('@multivac/contracts 的助手会话契约不依赖 Node、SQLite 或 Pi SDK', async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  const source = await readFile(resolve(sourceRoot, 'assistant-session.ts'), 'utf8');

  assert.equal(source.includes('node:'), false);
  assert.equal(source.includes('@earendil-works/pi-'), false);
  assert.equal(/sqlite|better-sqlite/u.test(source), false);
  assert.equal(source.includes('piSessionPath'), false);
});
