import { useEffect, useRef, useState } from 'react';
import { Check } from 'typebox/value';
import { DecideNoteSuggestionSchema, ImportNoteSuggestionsSchema, type NoteSuggestion, type DecideNoteSuggestion, type ImportNoteSuggestions } from '@multivac/contracts';
import { listNoteSuggestions, importNoteSuggestions, decideNoteSuggestion } from '../../data/note-suggestions-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { NoteAssistant } from './note-assistant.js';
import type { NoteEditorBridge } from './note-editor.js';

/** 服务端版本与本机未保存输入分别处理；接受建议不能覆盖本机草稿。 */
export function NoteAssistantWithSuggestions({ bridge }: { bridge: NoteEditorBridge }) {
  const noteId = bridge.note.id;
  const [suggestions, setSuggestions] = useState<NoteSuggestion[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const commandBusy = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  async function load() {
    const ticket = ++generation.current;
    const result = await listNoteSuggestions(noteId);
    if (mounted.current && ticket === generation.current) setSuggestions(result.suggestions);
  }
  useEffect(() => { mounted.current = true; void load().catch(e => setError((e as Error).message)); return () => { mounted.current = false; ++generation.current; }; }, [noteId]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'notes.changed' && event.noteId === noteId) void load().catch(e => { if (mounted.current) setError((e as Error).message); }); });

  async function collect(sessionId: string, piEntryId: string) {
    if (commandBusy.current) return;
    commandBusy.current = true; setBusy(piEntryId); setError('');
    const key = `multivac:note-suggestion-import:${sessionId}:${piEntryId}`;
    try {
      const raw = sessionStorage.getItem(key); const restored: unknown = raw ? JSON.parse(raw) : null;
      const input: ImportNoteSuggestions = Check(ImportNoteSuggestionsSchema, restored) ? restored : { commandId: newCommandId(), sessionId, piEntryId };
      sessionStorage.setItem(key, JSON.stringify(input));
      await importNoteSuggestions(noteId, input);
      sessionStorage.removeItem(key); await load();
    } catch (e) { setError((e as Error).message); }
    finally { commandBusy.current = false; setBusy(null); }
  }
  async function decide(suggestion: NoteSuggestion, decision: 'accept' | 'reject') {
    if (commandBusy.current || decision === 'accept' && (bridge.dirty || bridge.busy)) return;
    commandBusy.current = true; setBusy(suggestion.id); setError('');
    const key = `multivac:note-suggestion-decision:${suggestion.id}`;
    try {
      const raw = sessionStorage.getItem(key); const restored: unknown = raw ? JSON.parse(raw) : null;
      const input: DecideNoteSuggestion = Check(DecideNoteSuggestionSchema, restored) ? restored : { commandId: newCommandId(), expectedRevision: bridge.note.revision, decision };
      if (input.decision !== decision) throw new Error('先按原决定核对结果，再处理其他操作。');
      sessionStorage.setItem(key, JSON.stringify(input));
      const result = await decideNoteSuggestion(noteId, suggestion.id, input);
      sessionStorage.removeItem(key);
      if (result.suggestion.status === 'stale') setError(result.suggestion.problem ?? '建议已失效，请重新生成。');
      await Promise.all([load(), bridge.refresh()]);
    } catch (e) { setError((e as Error).message); }
    finally { commandBusy.current = false; setBusy(null); }
  }
  return <NoteAssistant bridge={bridge}
    messageActions={(message, sessionId, ready) => message.role === 'assistant' && ready && /"suggestions"\s*:/u.test(message.text) ? <button type="button" disabled={busy !== null} onClick={() => void collect(sessionId, message.piEntryId)}>{busy === message.piEntryId ? '核对建议…' : '查看修改建议'}</button> : null}
    suggestions={(discussion) => <section className="note-suggestions" aria-label="结构化修改建议">
      {error && <div className="notes-error" role="alert">{error}<button type="button" onClick={() => void load().catch(e => setError((e as Error).message))}>重新读取建议</button></div>}
      {suggestions === null && <p className="notes-hint">正在读取修改建议…</p>}
      {suggestions?.filter(s => s.sessionId === discussion.sessionId).map(suggestion => <article className="note-suggestion" key={suggestion.id} data-suggestion-id={suggestion.id}>
        <strong>{suggestion.reason}</strong><small>原文 v{suggestion.baseRevision} · {suggestion.status === 'pending' ? '待决定' : suggestion.status === 'accepted' ? `已接受 · v${suggestion.appliedRevision}` : suggestion.status === 'rejected' ? '已拒绝' : '已失效'}</small>
        <div className="note-diff"><div><span>修改前</span><pre className="diff-before">{suggestion.before}</pre></div><div><span>修改后</span><pre className="diff-after">{suggestion.after || '（删除这段内容）'}</pre></div></div>
        {suggestion.problem && <p role="status">{suggestion.problem}</p>}
        {(suggestion.status === 'pending' || suggestion.status === 'stale') && <footer><button type="button" disabled={busy !== null} onClick={() => void decide(suggestion, 'reject')}>拒绝</button><button type="button" disabled={busy !== null || suggestion.status !== 'pending' || bridge.dirty || bridge.busy} title={bridge.dirty ? '请先保存或核对笔记草稿' : undefined} onClick={() => void decide(suggestion, 'accept')}>{busy === suggestion.id ? '核对决定…' : '接受'}</button></footer>}
      </article>)}
    </section>} />;
}
