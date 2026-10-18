import { NOTE_BODY_LIMIT, type NoteSuggestion, type ImportNoteSuggestions, type DecideNoteSuggestion, type NoteSuggestionDecision } from '@multivac/contracts';
import { NotesError, notesFingerprint, type NoteSuggestionsRepository } from '../modules/notes/note.js';
import type { NoteAssistantService } from './note-assistant-service.js';
import { parseNoteSuggestions, uniqueNoteLocation } from './note-suggestion-parser.js';

export class NoteSuggestionsService {
  constructor(readonly repository: NoteSuggestionsRepository, readonly assistant: NoteAssistantService) {}
  /** 建议的读取与写入都在笔记命令事务内完成，事务入口归笔记仓储所有。 */
  private get notes() { return this.assistant.notes.repository; }
  list(noteId: string, sessionId?: string) {
    this.assistant.notes.get(noteId);
    if (sessionId) this.assistant.requireDiscussion(sessionId, noteId);
    return this.repository.list(noteId, sessionId);
  }
  async import(noteId: string, input: ImportNoteSuggestions) {
    this.assistant.notes.summary(noteId);
    const fingerprint = notesFingerprint(['suggestions', noteId, input]);
    const receipt = this.notes.receipt<NoteSuggestion[]>(input.commandId, fingerprint); if (receipt) return receipt;
    const { message, snapshot } = await this.assistant.readMessage(input.sessionId, input.runtimeEntryId);
    if (snapshot.noteId !== noteId || message.role !== 'assistant') throw new NotesError('仅可从当前笔记助手的稳定回复生成建议。', 409);
    const sourceKey = notesFingerprint([input.sessionId, message.runtimeSessionId, message.runtimeEntryId, snapshot.id]);
    const output = parseNoteSuggestions(message.text);
    const base = this.notes.get(noteId, snapshot.revision);
    // 解析每条建议的唯一位置；任一定位不明确则整个批次拒绝，不猜测或部分悄悄丢弃。
    const located = output.suggestions.map(item => {
      const location = uniqueNoteLocation(base.body, item.before);
      if (!location) throw new NotesError('建议原文不存在或定位不唯一，请让助手使用更完整的原文重新生成。', 409);
      return { ...item, ...location };
    });
    const result = this.notes.command(input.commandId, fingerprint, () => {
      const previous = this.repository.source(sourceKey); if (previous) return previous;
      const current = this.notes.get(noteId), now = new Date().toISOString();
      const suggestions: NoteSuggestion[] = located.map((item, index) => ({
        ...item, id: `suggestion-${notesFingerprint([sourceKey, index]).slice(0, 40)}`, noteId, sessionId: input.sessionId, snapshotId: snapshot.id,
        sourceRuntimeSessionId: message.runtimeSessionId, sourceRuntimeEntryId: message.runtimeEntryId, baseRevision: base.revision,
        status: current.revision === base.revision ? 'pending' : 'stale',
        problem: current.revision === base.revision ? null : '正文版本已变化，请基于当前正文重新生成建议。',
        createdAt: now, decidedAt: null, appliedRevision: null,
      }));
      this.repository.insertSource(sourceKey, suggestions); return suggestions;
    });
    if (result.changed) this.assistant.notes.changed(noteId);
    return result.value;
  }
  decide(noteId: string, suggestionId: string, input: DecideNoteSuggestion): NoteSuggestionDecision {
    const result = this.notes.command(input.commandId, notesFingerprint(['decide', noteId, suggestionId, input]), () => {
      const suggestion = this.repository.get(suggestionId);
      if (suggestion.noteId !== noteId) throw new NotesError('建议不属于当前笔记。', 409);
      const note = this.notes.get(noteId);
      const repeated = input.decision === 'accept' && suggestion.status === 'accepted' || input.decision === 'reject' && suggestion.status === 'rejected';
      if (repeated) return { note, suggestion };
      if (['accepted', 'rejected'].includes(suggestion.status)) throw new NotesError('建议已有相反决定，不能再次应用。', 409);
      const now = new Date().toISOString();
      if (input.decision === 'reject') {
        const rejected: NoteSuggestion = { ...suggestion, status: 'rejected', decidedAt: now };
        this.repository.put(rejected); return { note, suggestion: rejected };
      }
      const location = uniqueNoteLocation(note.body, suggestion.before);
      if (suggestion.status === 'stale' || note.revision !== input.expectedRevision || note.revision !== suggestion.baseRevision || !location || location.start !== suggestion.start || location.end !== suggestion.end) {
        const stale: NoteSuggestion = { ...suggestion, status: 'stale', problem: '正文版本或原文位置已变化，禁止应用。请基于当前正文重新生成建议。' };
        this.repository.put(stale); return { note, suggestion: stale };
      }
      const body = note.body.slice(0, location.start) + suggestion.after + note.body.slice(location.end);
      if (body.length > NOTE_BODY_LIMIT) throw new NotesError('应用后的正文超过笔记长度限制。');
      const saved = { ...note, body, revision: note.revision + 1, updatedAt: now };
      // 正文、版本快照、其他建议失效、本条决定及原命令回执共用事务。
      this.notes.writeVersion(saved);
      const accepted: NoteSuggestion = { ...suggestion, status: 'accepted', problem: null, decidedAt: now, appliedRevision: saved.revision };
      this.repository.put(accepted); return { note: saved, suggestion: accepted };
    });
    if (result.changed) this.assistant.notes.changed(noteId);
    return result.value;
  }
}
