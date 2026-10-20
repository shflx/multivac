import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantFileQuote } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { AssistantPageStateRevisionConflictError } from '../src/modules/sessions/assistant-session.js';

test('文件来源草稿在真实SQLite中按来源更新版本，关闭重开保留正文、来源和锚点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-source-draft-'));
  const database = join(root, 'draft.sqlite');
  let store = new SqliteAssistantStore(database);
  try {
    store.bindings.insertIfAbsent({ assistantSessionId: 'work', harness: 'pi', runtimeSessionId: 'pi-work', runtimeSessionRef: 'fixture-session', updatedAt: '2026-10-20T00:00:00Z' });
    const quote: AssistantFileQuote = { sourceKind: 'file', quoteKind: 'source', sourceSessionId: 'work', sourceFile: { root: '/原始 目录', path: 'a.bin' }, text: '' };
    const saved = store.pageStates.save('work', { draft: '保留原正文', quote, anchorEntryId: 'entry', anchorOffsetPx: 37, revision: 0 });
    assert.equal(saved.revision, 1);
    assert.deepEqual(store.pageStates.save('work', saved), saved);
    const nextQuote: AssistantFileQuote = { ...quote, sourceFile: { ...quote.sourceFile, path: 'b.bin' } };
    const next = store.pageStates.save('work', { ...saved, quote: nextQuote });
    assert.equal(next.revision, 2);
    assert.throws(() => store.pageStates.save('work', { ...saved, quote: null }), AssistantPageStateRevisionConflictError);
    store.close();
    store = new SqliteAssistantStore(database);
    assert.deepEqual(store.pageStates.get('work'), { ...next, draft: '保留原正文', quote: nextQuote, anchorEntryId: 'entry', anchorOffsetPx: 37 });
    const selected: AssistantFileQuote = { sourceKind: 'file', sourceSessionId: 'work', sourceFile: quote.sourceFile, text: '原选区' };
    const selection = store.pageStates.save('work', { ...next, quote: selected });
    assert.equal(selection.revision, 3); assert.deepEqual(selection.quote, selected);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
