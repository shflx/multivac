import { join } from 'node:path';
import { NOTE_CONTEXT_LIMIT, validNoteSelection, type PrepareNoteContext, type NoteDiscussion, type NoteSnapshot, type CreateNoteDiscussion, type CoordinatorSessionContext, type CoordinatorModelConfig, type AssistantMessageView } from '@multivac/contracts';
import { NotesError, notesFingerprint } from '../storage/sqlite-notes-repository.js';
import { SqliteNoteAssistantRepository } from '../storage/sqlite-note-assistant-repository.js';
import type { NotesService } from './notes-service.js';

export class NoteAssistantService {
  private history?: (id: string) => Promise<readonly AssistantMessageView[]>;
  private model?: (id: string) => Promise<CoordinatorModelConfig>;
  constructor(readonly repository: SqliteNoteAssistantRepository, readonly notes: NotesService, private readonly sessionsDir: string) {}
  setResolvers(history: (id: string) => Promise<readonly AssistantMessageView[]>, model: (id: string) => Promise<CoordinatorModelConfig>) { this.history = history; this.model = model; }
  discussions(noteId: string) { this.notes.summary(noteId); return this.repository.discussions(noteId); }
  requireDiscussion(sessionId: string, noteId?: string): NoteDiscussion {
    const discussion = this.repository.discussion(sessionId);
    if (!discussion || noteId !== undefined && discussion.noteId !== noteId) throw new NotesError('讨论不属于当前笔记。', 409);
    this.notes.summary(discussion.noteId);
    return discussion;
  }
  ensureRoot(noteId: string) {
    const note = this.notes.summary(noteId);
    const id = `note-${notesFingerprint(noteId).slice(0, 40)}`;
    const existing = this.repository.discussion(id); if (existing) return existing;
    const result = this.repository.notes.command(`note-root-${notesFingerprint(noteId).slice(0, 40)}`, notesFingerprint(['root', noteId]), () => {
      const discussion: NoteDiscussion = { sessionId: id, noteId, title: `梳理 · ${note.title}`.slice(0, 80), parentSessionId: null, topic: null, createdAt: new Date().toISOString() };
      this.repository.insertDiscussion(discussion, join(this.sessionsDir, id)); return discussion;
    });
    if (result.changed) this.notes.changed(noteId);
    return result.value;
  }
  prepare(noteId: string, input: PrepareNoteContext): NoteSnapshot {
    const result = this.repository.notes.command(input.commandId, notesFingerprint(['context', noteId, input]), () => {
      this.requireDiscussion(input.sessionId, noteId);
      const note = this.repository.notes.get(noteId, input.revision);
      if (note.body.length > NOTE_CONTEXT_LIMIT) throw new NotesError(`当前笔记超过助手 ${NOTE_CONTEXT_LIMIT} 字符上下文上限，请拆分笔记后讨论。`);
      if (input.selection && !validNoteSelection(note.body, input.selection)) throw new NotesError('选区与已保存的正文版本不一致，请重新选取。', 409);
      const snapshot: NoteSnapshot = { id: input.id, sessionId: input.sessionId, noteId, revision: note.revision, selection: input.selection };
      this.repository.insertSnapshot(snapshot); return snapshot;
    });
    return result.value;
  }
  context(sessionId: string, snapshotId: string): CoordinatorSessionContext {
    const snapshot = this.repository.snapshot(snapshotId);
    const discussion = this.requireDiscussion(sessionId, snapshot.noteId);
    if (snapshot.sessionId !== sessionId) throw new NotesError('快照不属于当前讨论。', 409);
    const note = this.repository.notes.get(snapshot.noteId, snapshot.revision);
    return { kind: 'note', title: note.title, body: note.body, snapshot, topic: discussion.topic };
  }
  async createDiscussion(noteId: string, input: CreateNoteDiscussion) {
    const fingerprint = notesFingerprint(['discussion', noteId, input]);
    const receipt = this.repository.notes.receipt<NoteDiscussion>(input.commandId, fingerprint); if (receipt) return receipt;
    const parent = this.requireDiscussion(input.parentSessionId, noteId);
    let level: NoteDiscussion | null = parent; let depth = 0;
    while (level) { if (++depth >= 16) throw new NotesError('讨论层级最多 16 层。'); level = level.parentSessionId ? this.requireDiscussion(level.parentSessionId, noteId) : null; }
    let topic: NonNullable<NoteDiscussion['topic']>;
    if (input.source.kind === 'selection') {
      const snapshot = this.repository.snapshot(input.source.snapshotId);
      if (snapshot.sessionId !== parent.sessionId || snapshot.noteId !== noteId || !snapshot.selection) throw new NotesError('选区不属于父讨论及当前笔记。', 409);
      topic = { snapshotId: snapshot.id, text: snapshot.selection.text };
    } else {
      const messages = await this.history?.(parent.sessionId);
      const source = messages?.find(m => m.piEntryId === (input.source.kind === 'message' ? input.source.piEntryId : ''));
      if (!source?.noteContext || source.noteContext.noteId !== noteId || source.noteContext.sessionId !== parent.sessionId || !source.text || source.text.length > 16000) throw new NotesError('来源消息不可读、身份不一致或内容过长。', 409);
      topic = { snapshotId: source.noteContext.id, text: source.text, sourcePiEntryId: source.piEntryId };
    }
    const initialModel = await this.model?.(parent.sessionId);
    if (!initialModel) throw new NotesError('父讨论的实际模型暂不可核对，请重试。', 503);
    const result = this.repository.notes.command(input.commandId, fingerprint, () => {
      this.requireDiscussion(parent.sessionId, noteId);
      const discussion: NoteDiscussion = { sessionId: input.sessionId, noteId, parentSessionId: parent.sessionId, title: topic.text.slice(0, 60), topic, createdAt: new Date().toISOString() };
      this.repository.insertDiscussion(discussion, join(this.sessionsDir, `note-${notesFingerprint(input.sessionId).slice(0, 40)}`), initialModel); return discussion;
    });
    if (result.changed) this.notes.changed(noteId);
    return result.value;
  }
  async readMessage(sessionId: string, piEntryId: string) {
    const discussion = this.requireDiscussion(sessionId);
    const message = (await this.history?.(sessionId))?.find(m => m.piEntryId === piEntryId);
    if (!message || !message.noteContext || message.noteContext.noteId !== discussion.noteId || message.noteContext.sessionId !== sessionId) throw new NotesError('消息与笔记快照归属无法核对。', 409);
    const snapshot = this.repository.snapshot(message.noteContext.id);
    if (JSON.stringify(snapshot) !== JSON.stringify(message.noteContext)) throw new NotesError('消息的正文版本快照不一致。', 409);
    return { discussion, message, snapshot };
  }
}
