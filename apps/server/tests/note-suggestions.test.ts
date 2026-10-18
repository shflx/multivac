import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessageView } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteAssistantService } from '../src/application/note-assistant-service.js';
import { NoteSuggestionsService } from '../src/application/note-suggestions-service.js';
import { parseNoteSuggestions, uniqueNoteLocation } from '../src/application/note-suggestion-parser.js';
import { noteDiscussions, noteSources } from './fixtures/note-discussions.js';

test('生成/拒绝不改正文，逐条接受事务化及幂等，其他建议失效，重启保存决定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-note-suggestions-'));
  const path = join(dir, 'db.sqlite'); let store = new SqliteAssistantStore(path);
  try {
    const sources = noteSources();
    let notes = new NotesService(store.notes, noteDiscussions()), assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'), sources);
    let service = new NoteSuggestionsService(store.noteSuggestions, assistant);
    const original = notes.create({ commandId: 'create', id: 'a', title: 'A', body: '原句一。\n原句二。\n原句三。' });
    const root = assistant.ensureRoot('a');
    const snapshot = assistant.prepare('a', { commandId: 'context', id: 'snap', sessionId: root.sessionId, revision: 1, selection: null });
    const message: AssistantMessageView = { id: 'pi:entry', runtimeSessionId: 'pi', runtimeEntryId: 'entry', role: 'assistant', createdAt: new Date().toISOString(), noteContext: snapshot,
      text: '建议如下\n```json\n' + JSON.stringify({ suggestions: [1, 2, 3].map(i => ({ reason: `润色${i}`, before: `原句${['一', '二', '三'][i - 1]}。`, after: `修改${i}。` })) }) + '\n```' };
    Object.assign(sources, { history: async () => [message], model: async () => ({ provider: 'test', modelId: 'test', thinkingLevel: 'off' }) });
    const input = { commandId: 'import', sessionId: root.sessionId, runtimeEntryId: message.runtimeEntryId };
    const suggestions = await service.import('a', input);
    assert.equal(suggestions.length, 3); assert.deepEqual(notes.get('a'), original);
    assert.deepEqual(await service.import('a', input), suggestions);
    assert.deepEqual(await service.import('a', { ...input, commandId: 'same-source' }), suggestions);
    assert.equal(service.list('a').length, 3);
    assert.throws(() => service.decide('other', suggestions[0]!.id, { commandId: 'cross', expectedRevision: 1, decision: 'accept' }), /不属于/u);
    const rejected = service.decide('a', suggestions[1]!.id, { commandId: 'reject', expectedRevision: 1, decision: 'reject' });
    assert.equal(rejected.suggestion.status, 'rejected'); assert.deepEqual(notes.get('a'), original);
    const command = { commandId: 'accept', expectedRevision: 1, decision: 'accept' as const };
    const accepted = service.decide('a', suggestions[0]!.id, command);
    assert.equal(accepted.note.body, '修改1。\n原句二。\n原句三。'); assert.equal(accepted.note.revision, 2);
    assert.deepEqual(service.decide('a', suggestions[0]!.id, command), accepted);
    assert.equal(service.decide('a', suggestions[0]!.id, { ...command, commandId: 'repeat-new' }).note.revision, 2);
    assert.equal(service.list('a')[2]!.status, 'stale');
    assert.equal(service.decide('a', suggestions[2]!.id, { ...command, commandId: 'stale', expectedRevision: 2 }).suggestion.status, 'stale');
    assert.equal(notes.get('a').revision, 2);
    assert.throws(() => service.decide('a', suggestions[0]!.id, { ...command, commandId: 'opposite', decision: 'reject' }), /相反决定/u);
    store.close(); store = new SqliteAssistantStore(path);
    notes = new NotesService(store.notes, noteDiscussions()); assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'), noteSources()); service = new NoteSuggestionsService(store.noteSuggestions, assistant);
    assert.deepEqual(notes.get('a'), accepted.note);
    assert.deepEqual(service.list('a').map(s => s.status), ['accepted', 'rejected', 'stale']);
    assert.deepEqual(service.decide('a', suggestions[0]!.id, command), accepted);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('结构化输出拒绝非法结构、模糊/重叠重复定位及断开的代理对', () => {
  assert.throws(() => parseNoteSuggestions('随便的回复'), /JSON/u);
  assert.throws(() => parseNoteSuggestions(JSON.stringify({ suggestions: [{ reason: 'r', before: '', after: 'a' }] })), /结构无效/u);
  assert.throws(() => parseNoteSuggestions('```json\n{}\n```\n```json\n{}\n```'), /一个明确/u);
  assert.throws(() => parseNoteSuggestions(JSON.stringify({ suggestions: [{ reason: 'r', before: 'a', after: 'a', noteId: 'forged' }] })), /结构无效/u);
  assert.equal(uniqueNoteLocation('相同 相同', '相同'), null);
  assert.equal(uniqueNoteLocation('aaa', 'aa'), null);
  assert.equal(uniqueNoteLocation('😀', '\uDE00'), null);
  assert.deepEqual(uniqueNoteLocation('开头\n原句\n结尾', '原句'), { start: 3, end: 5 });
});

test('人工编辑使建议失效，不能用旧版本或拒绝后的建议误覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-note-stale-')), store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const sources = noteSources();
    const notes = new NotesService(store.notes, noteDiscussions()), assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'), sources), service = new NoteSuggestionsService(store.noteSuggestions, assistant);
    notes.create({ commandId: 'new', id: 'a', title: '', body: '唯一原文' });
    const root = assistant.ensureRoot('a'), snapshot = assistant.prepare('a', { commandId: 'ctx', id: 'ctx', sessionId: root.sessionId, revision: 1, selection: null });
    const message: AssistantMessageView = { id: 'p:e', runtimeSessionId: 'p', runtimeEntryId: 'e', role: 'assistant', text: JSON.stringify({ suggestions: [{ reason: 'r', before: '唯一原文', after: '新的原文' }] }), createdAt: '2026-01-01', noteContext: snapshot };
    Object.assign(sources, { history: async () => [message], model: async () => ({ provider: 'test', modelId: 'test', thinkingLevel: 'off' }) });
    const [suggestion] = await service.import('a', { commandId: 'import', sessionId: root.sessionId, runtimeEntryId: 'e' });
    notes.update('a', { commandId: 'manual', expectedRevision: 1, title: '', body: '唯一原文\n新段落' });
    assert.equal(service.list('a')[0]!.status, 'stale');
    const result = service.decide('a', suggestion!.id, { commandId: 'old-accept', decision: 'accept', expectedRevision: 1 });
    assert.equal(result.suggestion.status, 'stale'); assert.equal(result.note.body, '唯一原文\n新段落');
    service.decide('a', suggestion!.id, { commandId: 'reject-stale', decision: 'reject', expectedRevision: 2 });
    assert.throws(() => service.decide('a', suggestion!.id, { commandId: 'after-reject', decision: 'accept', expectedRevision: 2 }), /相反决定/u);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
