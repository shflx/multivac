import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteAssistantService } from '../src/application/note-assistant-service.js';
import { renderSessionContextForModel } from '../src/runtime/executors/pi-quote-carriage.js';
import { validNoteSelection } from '@multivac/contracts';

test('笔记上下文冻结正文、选区、讨论身份；分层及服务重启恢复，不进入工作会话列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-note-assistant-'));
  let store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    let notes = new NotesService(store.notes), assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'));
    notes.create({ commandId: 'ca', id: 'a', title: 'A', body: '第一段\n第二段' });
    notes.create({ commandId: 'cb', id: 'b', title: 'B', body: '不同正文' });
    const root = assistant.ensureRoot('a'), other = assistant.ensureRoot('b');
    assert.equal(assistant.ensureRoot('a').sessionId, root.sessionId);
    const input = { commandId: 'snap', id: 'snapshot', sessionId: root.sessionId, revision: 1, selection: { start: 0, end: 3, text: '第一段' } };
    const frozen = assistant.prepare('a', input);
    assert.deepEqual(assistant.prepare('a', input), frozen);
    assert.throws(() => assistant.prepare('b', { ...input, commandId: 'cross', id: 'cross' }), /不属于/u);
    assert.throws(() => assistant.prepare('a', { ...input, commandId: 'wrong', id: 'wrong', selection: { ...input.selection, text: '伪造' } }), /不一致/u);
    notes.update('a', { commandId: 'edit', expectedRevision: 1, title: 'A', body: '后来正文' });
    const context = assistant.context(root.sessionId, frozen.id);
    assert.equal(context.kind, 'note');
    if (context.kind !== 'note') throw new Error('missing note context');
    assert.equal(context.body, '第一段\n第二段'); assert.equal(context.snapshot.revision, 1);
    assert.throws(() => assistant.context(other.sessionId, frozen.id), /不属于/u);
    assert.ok(renderSessionContextForModel(context).includes('用户数据'));
    const model = { provider: 'openai', modelId: 'test', thinkingLevel: 'off' as const };
    assistant.setResolvers(async () => [], async () => model);
    const command = { commandId: 'child', sessionId: 'child', parentSessionId: root.sessionId, source: { kind: 'selection' as const, snapshotId: frozen.id } };
    const child = await assistant.createDiscussion('a', command);
    assert.equal(child.topic?.text, '第一段');
    assert.deepEqual(await assistant.createDiscussion('a', command), child);
    assert.deepEqual(store.getSession(child.sessionId)?.initialModel, model);
    assert.equal(store.getSession(root.sessionId)?.host?.kind, 'note');
    assert.equal(store.listSessions(null, 'work').length, 0);
    store.close(); store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
    notes = new NotesService(store.notes); assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'));
    assert.deepEqual(assistant.discussions('a'), [root, child]);
    assert.deepEqual(assistant.context(root.sessionId, frozen.id), context);
    assert.equal(notes.get('a').body, '后来正文');
    assert.ok(!validNoteSelection('😀文字', { start: 1, end: 2, text: '\uDE00' }));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
