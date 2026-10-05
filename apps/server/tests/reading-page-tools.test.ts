import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BookReference, CoordinatorRuntimeConfig } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { InternalToolService, type InternalToolServices } from '../src/application/internal-tools/internal-tool-service.js';
import { READING_PAGE_TOOLS } from '../src/application/internal-tools/reading-page-tools.js';
import { createToolBoundaryExtension } from '../src/runtime/executors/pi-tool-boundary.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'reading-page-tools-'));
  const store = new SqliteAssistantStore(':memory:');
  const service = new ReadingService(store.reading, join(root, 'books'), undefined, join(root, 'sessions'));
  const book = await service.import({ commandId: 'book', title: '跨页句子', author: '', format: 'txt', text: '句子的前半部分\n\n在当前页继续\n\n并在下一页结束。' });
  const discussion = service.ensureCompanion(book.id);
  const refs: BookReference[] = book.chapters[0]!.paragraphs.map(p => ({ bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: p.id, offset: 0 }, end: { chapterId: 'c1', paragraphId: p.id, offset: p.text.length }, text: p.text }));
  const [previous, current, next] = refs as [BookReference, BookReference, BookReference];
  const range = (r: BookReference) => ({ start: r.start, end: r.end });
  const context = await service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: current, pageReference: current, referenceKind: 'current-page', adjacentPages: { previous: range(previous), next: range(next) } }]);
  assert.equal(context.kind, 'reading'); if (context.kind !== 'reading') throw new Error('缺少阅读上下文');
  return { root, store, service, discussion, previous, current, next, range, context, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('相邻页固定在发送时位置，跨会话、跳页和超范围读取均拒绝，书首书末明确返回', async () => {
  const h = await setup();
  try {
    const id = h.context.pageTools!.contextId;
    const previous = h.service.readAdjacentPage(h.discussion.sessionId, id, 'previous');
    const next = h.service.readAdjacentPage(h.discussion.sessionId, id, 'next');
    assert.deepEqual(previous.reference, h.previous); assert.deepEqual(next.reference, h.next);
    assert.deepEqual(h.service.readAdjacentPage(h.discussion.sessionId, id, 'next'), next);
    assert.throws(() => h.service.readAdjacentPage('other-session', id, 'next'), /快照已失效/u);
    assert.throws(() => h.service.readAdjacentPage(h.discussion.sessionId, 'forged-id', 'next'), /快照已失效/u);
    await assert.rejects(h.service.contextForRefs(h.discussion.sessionId, [{ kind: 'book', reference: h.previous, pageReference: h.previous, adjacentPages: { previous: null, next: h.range(h.next) } }]), /紧邻/u);
    const context = await h.service.contextForRefs(h.discussion.sessionId, [{ kind: 'book', reference: h.previous, pageReference: h.previous, adjacentPages: { previous: null, next: h.range(h.current) } }]);
    assert.equal(context.kind, 'reading'); if (context.kind !== 'reading') throw new Error('缺少上下文');
    assert.equal(h.service.readAdjacentPage(h.discussion.sessionId, context.pageTools!.contextId, 'previous').available, false);
    assert.deepEqual(h.service.readAdjacentPage(h.discussion.sessionId, id, 'next'), next);
    const last = await h.service.contextForRefs(h.discussion.sessionId, [{ kind: 'book', reference: h.next, pageReference: h.next, adjacentPages: { previous: h.range(h.current), next: null } }]);
    assert.equal(last.kind, 'reading'); if (last.kind !== 'reading') throw new Error('缺少上下文');
    assert.equal(h.service.readAdjacentPage(h.discussion.sessionId, last.pageTools!.contextId, 'next').available, false);
    assert.equal(h.service.scope(h.previous.bookId).boundary, null);
  } finally { await h.close(); }
});

test('真实 Pi 书伴只声明相邻页工具，按需收到原文且不能执行文件工具', async () => {
  const h = await setup(); const model = await startScriptedModel();
  const agentDir = join(h.root, 'agent'), cwd = join(h.root, 'work');
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir: join(h.root, 'pi') });
  const tools = new InternalToolService({ tools: READING_PAGE_TOOLS, services: { readingPages: h.service } as InternalToolServices, calls: new SqliteInternalToolCallRepository(h.store), currentTurn: () => ({ commandId: 'reading-turn', windowId: null }) });
  const config: CoordinatorRuntimeConfig = { systemPrompt: '阅读书伴', readingOnly: true, authorizedContext: [], model: { provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
  try {
    await mkdir(cwd); await configureScriptedModel(agentDir, model.endpoint);
    const created = await adapter.createSession({ assistantSessionId: h.discussion.sessionId, config, internalTools: tools, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.ok(created.ok, JSON.stringify(created));
    assert.deepEqual([...created.value.activeToolNames].sort(), ['read_next_page', 'read_previous_page']);
    model.script({ toolCalls: [{ name: 'read_previous_page', arguments: { contextId: h.context.pageTools!.contextId } }, { name: 'read_next_page', arguments: { contextId: h.context.pageTools!.contextId } }] }, { toolCalls: [{ name: 'read', arguments: { path: 'secret.txt' } }] }, { text: '完整句子已补齐。' });
    const outcome = await adapter.prompt(h.discussion.sessionId, '请补全跨页句子', undefined, h.context);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const results = model.takeToolResults().join('\n');
    assert.ok(results.includes(h.previous.text)); assert.ok(results.includes(h.next.text));
    const requests = model.takeRequests();
    assert.ok(requests.every(request => request.tools.length === 2 && request.tools.every(name => name === 'read_next_page' || name === 'read_previous_page')));
    assert.equal(requests[0]!.userTexts.join('\n').includes(h.next.text), false);
    assert.equal(h.service.scope(h.previous.bookId).boundary, null);
  } finally { adapter.dispose(); await model.close(); await h.close(); }
});


test('相邻页面可跨正文块，仍核对 Unicode 边界且不读取整书', async () => {
  const h = await setup();
  try {
    const text = Array.from({ length: 131 }, (_, i) => `第${i}处原文😀`).join('\n\n');
    const book = await h.service.import({ commandId: 'large', title: '跨块验证', author: '', format: 'txt', text });
    const discussion = h.service.ensureCompanion(book.id);
    const paragraphs = book.chapters[0]!.paragraphs;
    const position = (i: number, offset = 0) => ({ chapterId: 'c1', paragraphId: paragraphs[i]!.id, offset });
    const current: BookReference = { bookId: book.id, version: book.version, start: position(126), end: position(126, paragraphs[126]!.text.length), text: paragraphs[126]!.text };
    const next = { start: position(127), end: position(128, paragraphs[128]!.text.length) };
    assert.equal(h.service.index(book.id).blockCount, 2);
    h.store.reading.content.full = () => { throw new Error('不允许加载整本正文'); };
    const context = await h.service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: current, pageReference: current, adjacentPages: { previous: null, next } }]);
    assert.equal(context.kind, 'reading'); if (context.kind !== 'reading') throw new Error('缺少上下文');
    assert.equal(h.service.readAdjacentPage(discussion.sessionId, context.pageTools!.contextId, 'next').reference?.text, paragraphs.slice(127, 129).map(p => p.text).join('\n'));
    await assert.rejects(h.service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: current, pageReference: current, adjacentPages: { previous: null, next: { ...next, end: position(128, paragraphs[128]!.text.length - 1) } } }]), /位置无效/u);
  } finally { await h.close(); }
});

test('阅读边界仅放行已注入的两个只读工具，文件、命令和其他内部工具始终拒绝', async () => {
  const extension = createToolBoundaryExtension({ cwd: '/unused', readingOnly: true, internalTools: { read_next_page: 'query', read_previous_page: 'query', list_tasks: 'query' } });
  const handler = extension.handlers.get('tool_call')![0]!;
  for (const name of ['read_previous_page', 'read_next_page']) assert.equal(await handler({ toolName: name, input: { contextId: 'snapshot' } }, {}), undefined);
  for (const name of ['read', 'write', 'edit', 'bash', 'list_tasks', 'unknown']) {
    const result = await handler({ toolName: name, input: {} }, {}) as { block: boolean };
    assert.equal(result.block, true, name);
  }
  const absent = createToolBoundaryExtension({ cwd: '/unused', readingOnly: true }).handlers.get('tool_call')![0]!;
  assert.equal((await absent({ toolName: 'read_next_page', input: {} }, {}) as { block: boolean }).block, true);
});
