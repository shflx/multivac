import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageView } from '@multivac/contracts';
import { transcriptMessage, transcriptPreview, TRANSCRIPT_PAGE_MAX_LENGTH } from '../src/application/session-transcript-pages.js';

function message(index: number, text = `消息${index}`): AssistantMessageView {
  return { id: `private-${index}`, runtimeSessionId: 'private-runtime', runtimeEntryId: `entry-${index}`, role: 'user', text, createdAt: '2026-10-26' };
}

function fixture(messages: AssistantMessageView[]) {
  const state = { messages, branch: messages.map(m => m.runtimeEntryId) };
  return {
    state,
    source: {
      readMessages: () => state.messages,
      readSnapshot: () => ({ runtimeSessionId: 'private-runtime', leafEntryId: state.branch.at(-1) ?? null, branchEntryIds: state.branch, messages: state.messages }),
    },
  };
}

function readAll(source: ReturnType<typeof fixture>['source'], ref: string, part: 'body' | 'quote', expected: string) {
  let page = transcriptMessage(source, 'work', ref, part);
  let text = '', pages = 0;
  while (true) {
    assert.ok(JSON.stringify(page).length <= TRANSCRIPT_PAGE_MAX_LENGTH);
    assert.equal(page.range.start, text.length);
    assert.equal(page.range.end - page.range.start, page.text.length);
    assert.equal(page.range.total, expected.length);
    assert.equal(page.done, page.range.end === expected.length);
    assert.equal(page.text, expected.slice(page.range.start, page.range.end));
    if (page.text.length) assert.doesNotMatch(page.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    text += page.text; pages++;
    if (page.done) { assert.equal(page.next, null); break; }
    assert.ok(page.next);
    assert.ok(pages < 200);
    const next = page.next;
    page = transcriptMessage(source, next.sessionId, next.messageRef, next.part, next.cursor);
  }
  assert.equal(text, expected);
  return pages;
}

export const longDraft = ' \n' + Array.from({ length: 9 }, (_, i) => `T${i + 1}：${'清晰边界😀及完整正文'.repeat(180)}\n`).join('') + '末尾依赖：T1→T2→T3→T4→T5→T6→T7→T8→T9\n  ';

test('长草案和保存引用按公开引用逐字续读，范围、UTF-16、空白、JSON转义与总预算准确', () => {
  const quote = ' \n' + '\u0000\t"\\😀'.repeat(5_000) + '\n ';
  const m = message(0, longDraft);
  m.quote = { sourceRuntimeSessionId: 'third-session', sourceRuntimeEntryId: 'third-entry', sourceRole: 'assistant', text: quote };
  const { source } = fixture([m]);
  const preview = transcriptPreview(source, 'work', { limit: 6, recent: true });
  assert.equal(preview.messages[0]!.body.done, false);
  assert.equal(preview.messages[0]!.quote!.done, false);
  assert.ok(readAll(source, preview.messages[0]!.messageRef, 'body', longDraft) > 1);
  assert.ok(readAll(source, preview.messages[0]!.messageRef, 'quote', quote) > 1);
  assert.doesNotMatch(JSON.stringify(preview), /private-runtime|entry-0|third-session|third-entry/u);
  const controls = fixture([message(1, '\u0000'.repeat(30_000))]);
  assert.ok(JSON.stringify(transcriptPreview(controls.source, 'work', { limit: 6 })).length <= TRANSCRIPT_PAGE_MAX_LENGTH);
});

test('超过20条历史连续向前定位；预算舍弃的条目仍在下一页，新增消息不移位', () => {
  const { state, source } = fixture(Array.from({ length: 53 }, (_, i) => message(i, '长'.repeat(1_600))));
  let page = transcriptPreview(source, 'work', { limit: 20 });
  const ref = page.messages[0]!.messageRef;
  state.messages.push(message(53)); state.branch.push('entry-53');
  assert.equal(transcriptMessage(source, 'work', ref, 'body').text, '长'.repeat(1_600));
  const indexes: number[] = [];
  while (true) {
    assert.ok(JSON.stringify(page).length <= TRANSCRIPT_PAGE_MAX_LENGTH);
    assert.equal(page.range.end - page.range.start, page.messages.length);
    assert.equal(page.range.total, 53);
    indexes.unshift(...page.messages.map(m => m.index));
    if (!page.next) { assert.equal(page.historyDone, true); break; }
    assert.equal(page.historyDone, false);
    page = transcriptPreview(source, page.next.sessionId, page.next);
  }
  assert.deepEqual(indexes, Array.from({ length: 53 }, (_, i) => i));
});

test('内容、引用或分支改变拒绝混版；无效、串部分、串消息、跨会话游标要求重新定位', () => {
  const { state, source } = fixture([message(0, longDraft), message(1)]);
  const page = transcriptPreview(source, 'work', { limit: 1 });
  const history = page.next!;
  const older = transcriptPreview(source, 'work', history).messages[0]!;
  const first = transcriptMessage(source, 'work', older.messageRef, 'body');
  assert.ok(first.next);
  const args = first.next!;
  const original = state.messages[0]!.text;
  state.messages[0]!.text = '变更';
  assert.throws(() => transcriptMessage(source, 'work', args.messageRef, 'body', args.cursor), /重新.*定位/u);
  assert.throws(() => transcriptPreview(source, 'work', history), /重新.*定位/u);
  state.messages[0]!.text = original;
  state.messages[0]!.quote = { sourceRuntimeSessionId: 'x', sourceRuntimeEntryId: 'x', sourceRole: 'user', text: '新引用' };
  assert.throws(() => transcriptMessage(source, 'work', older.messageRef, 'body'), /重新.*定位/u);
  delete state.messages[0]!.quote;
  state.branch.push('invisible-tool-entry');
  const branchRef = transcriptPreview(source, 'work', { limit: 2 }).messages[0]!.messageRef;
  state.branch[state.branch.length - 1] = 'other-invisible-entry';
  assert.throws(() => transcriptMessage(source, 'work', branchRef, 'body'), /重新.*定位/u);
  assert.throws(() => transcriptMessage(source, 'elsewhere', older.messageRef, 'body'), /重新.*定位/u);
  assert.throws(() => transcriptMessage(source, 'work', older.messageRef, 'quote', args.cursor), /重新.*定位/u);
  assert.throws(() => transcriptMessage(source, 'work', page.messages[0]!.messageRef, 'body', args.cursor), /重新.*定位/u);
  for (const cursor of ['invalid', args.cursor.slice(1), history.cursor]) {
    assert.throws(() => transcriptMessage(source, 'work', older.messageRef, 'body', cursor), /重新.*定位/u);
  }
});

test('空会话和完整短正文、空引用、重复读取返回准确结束状态', () => {
  const empty = fixture([]);
  const page = transcriptPreview(empty.source, 'work', { limit: 6 });
  assert.deepEqual(page.range, { start: 0, end: 0, total: 0, currentTotal: 0 });
  assert.equal(page.next, null); assert.equal(page.historyDone, true);
  const { source } = fixture([message(0, ' \n😀\n ')]);
  const preview = transcriptPreview(source, 'work', { limit: 6 });
  assert.equal(preview.messages[0]!.body.done, true);
  const ref = preview.messages[0]!.messageRef;
  assert.deepEqual(transcriptMessage(source, 'work', ref, 'body'), transcriptMessage(source, 'work', ref, 'body'));
  assert.equal(transcriptMessage(source, 'work', ref, 'quote').done, true);
  assert.equal(transcriptMessage(source, 'work', ref, 'quote').range.total, 0);
});
