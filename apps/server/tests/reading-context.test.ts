import assert from 'node:assert/strict';
import test from 'node:test';
import type { BookReference, CoordinatorSessionContext } from '@multivac/contracts';
import { renderSessionContextForModel } from '../src/runtime/executors/pi-quote-carriage.js';

const page: BookReference = { bookId: 'book', version: 'v1', start: { chapterId: 'c1', paragraphId: 'p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'p1', offset: 4 }, text: '本轮页面' };
const oldQuote = { ...page, text: '旧页引用' };
const base: Extract<CoordinatorSessionContext, { kind: 'reading' }> = { kind: 'reading', title: '书', reference: page, currentPage: page, referenceKind: 'current-page', excerpt: '不应自动注入的已读内容', discussionExcerpt: '不应重复注入的旧回答', boundary: page.end, truncated: false };

test('无显式引用时只提供当前页，旧回答与已读补充不进入模型正文', () => {
  const text = renderSessionContextForModel(base);
  const data = JSON.parse(text);
  assert.deepEqual(data.currentPage, page);
  assert.equal(data.userQuote, null);
  assert.equal(data.relatedAnswer, undefined);
  assert.equal(data.readSupplement, undefined);
  assert.equal(text.includes(base.excerpt), false);
  assert.equal(text.includes(base.discussionExcerpt!), false);
  assert.equal(text.split(page.text).length - 1, 1);
});

test('旧引用与本轮位置分开，显式引用整页时保留类型且正文只出现一次', () => {
  const quoted = JSON.parse(renderSessionContextForModel({ ...base, reference: oldQuote, referenceKind: 'follow-up' }));
  assert.deepEqual(quoted.currentPage, page);
  assert.deepEqual(quoted.userQuote, { kind: 'follow-up', reference: oldQuote });
  const fullPage = renderSessionContextForModel({ ...base, referenceKind: 'selection' });
  assert.deepEqual(JSON.parse(fullPage).userQuote, { kind: 'selection', contentSource: 'currentPage' });
  assert.equal(fullPage.split(page.text).length - 1, 1);
});

test('旧客户端未提供当前位置时不将其引用冒充当前页', () => {
  const { currentPage: _page, referenceKind: _kind, ...legacy } = base;
  const data = JSON.parse(renderSessionContextForModel(legacy));
  assert.equal(data.currentPage, null);
  assert.deepEqual(data.userQuote, { kind: 'unclassified', reference: page });
});
