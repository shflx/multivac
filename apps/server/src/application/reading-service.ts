import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validBookReference, bookParagraphs, positionRank, referenceText, type ImportBook, type AnnotationCommand, type ReadingScopeCommand, type BookReference, type CoordinatorSessionContext, type ReadingNotesCommand, type ReadingNoteDraft } from '@multivac/contracts';
import { parseBook, readingHash, ReadingError } from '../modules/reading/book-import.js';
import type { SqliteReadingRepository } from '../storage/sqlite-reading-repository.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';
import type { SqliteReadingNotesRepository } from '../storage/sqlite-reading-notes-repository.js';
import type { AssistantMessageView, AssistantContextRef, ReadingMessageSource, CreateReadingDiscussion, ReadingDiscussion } from '@multivac/contracts';

export class ReadingService {
  private readHistory?: (sessionId: string) => Promise<readonly AssistantMessageView[]>;
  private readonly sourceMessages = new Map<string, AssistantMessageView>();
  constructor(private readonly repository: SqliteReadingRepository, private readonly sourceDir: string, private readonly events?: WorkbenchEventPublisher, private readonly sessionsDir?: string, private readonly notesRepository?: SqliteReadingNotesRepository) {}
  setHistoryResolver(resolver: (sessionId: string) => Promise<readonly AssistantMessageView[]>) { this.readHistory = resolver; }
  discussions(bookId?: string) { return bookId ? this.repository.discussions(bookId) : this.repository.allDiscussions(); }
  async readSource(bookId: string, source: ReadingMessageSource): Promise<AssistantMessageView> {
    if (this.discussion(source.sessionId)?.bookId !== bookId || !this.readHistory) throw new ReadingError('来源讨论不存在。', 404);
    const messages = await this.readHistory(source.sessionId);
    const message = messages.find(m => m.piEntryId === source.piEntryId);
    if (!message?.readingReference || message.readingReference.bookId !== bookId || message.text.length > 16000) throw new ReadingError('来源消息已失效或超过长度限制。', 409);
    this.sourceMessages.set(`${source.sessionId}/${source.piEntryId}`, message);
    return message;
  }
  async contextForRefs(sessionId: string, refs: readonly AssistantContextRef[]) {
    const ref = refs[0];
    if (ref?.kind !== 'book') throw new ReadingError('书伴需要原文引用。');
    const context = this.context(sessionId, ref.reference);
    if (ref.sourceMessage) {
      const source = await this.readSource(ref.reference.bookId, ref.sourceMessage);
      if (JSON.stringify(source.readingReference) !== JSON.stringify(ref.reference)) throw new ReadingError('追问原文与来源消息不一致。');
      if (context.kind === 'reading') context.discussionExcerpt = source.text;
    } else {
      const discussion = this.discussion(sessionId);
      if (discussion?.sourceMessage && context.kind === 'reading') context.discussionExcerpt = discussion.sourceMessage.text;
    }
    return context;
  }
  async createDiscussion(bookId: string, command: CreateReadingDiscussion): Promise<ReadingDiscussion> {
    const fingerprint = readingHash(JSON.stringify([bookId, command]));
    const receipt = this.repository.discussionReceipt(command.commandId, fingerprint); if (receipt) return receipt;
    const parent = this.discussion(command.parentSessionId);
    if (!parent || parent.bookId !== bookId || !this.sessionsDir) throw new ReadingError('父讨论不可用。', 404);
    let ancestor: ReadingDiscussion | null = parent; let depth = 0;
    while (ancestor) { if (++depth >= 16) throw new ReadingError('讨论层级最多 16 层。'); ancestor = ancestor.parentSessionId ? this.discussion(ancestor.parentSessionId) : null; }
    let sourceMessage: ReadingDiscussion['sourceMessage'];
    let reference: BookReference;
    if (command.source.kind === 'message') {
      if (command.source.message.sessionId !== parent.sessionId) throw new ReadingError('来源消息不属于父讨论。');
      const source = await this.readSource(bookId, command.source.message);
      reference = source.readingReference!; sourceMessage = { ...command.source.message, text: source.text };
    } else reference = command.source.reference;
    if (!validBookReference(this.get(bookId), reference) || reference.text.length > 16000) throw new ReadingError('原文位置已失效或选区超过 16000 字符。', 409);
    const discussion: ReadingDiscussion = { sessionId: command.sessionId, bookId, parentSessionId: parent.sessionId, reference, title: (sourceMessage?.text ?? reference.text).slice(0, 60), createdAt: new Date().toISOString(), ...(sourceMessage ? { sourceMessage } : {}) };
    const result = this.repository.createDiscussion(discussion, join(this.sessionsDir, `reading-${readingHash(command.sessionId)}`), command.commandId, fingerprint);
    this.events?.publish({ type: 'reading.changed', bookId }); return result;
  }
  async prepareNotes(bookId: string, command: ReadingNotesCommand) {
    if (this.notesRepository?.receipt(bookId, command)) return;
    const candidates = command.action === 'draft' ? [command.draft] : command.action === 'save' ? [this.notes(bookId).draft, command.nextDraft] : [];
    for (const draft of candidates) {
      if (!draft?.discussion) continue;
      const existing = this.notes(bookId).notes.find(n => n.id === draft.id) ?? this.notes(bookId).draft;
      if (existing?.origin === draft.origin && JSON.stringify(existing.discussion) === JSON.stringify(draft.discussion) && JSON.stringify(existing.reference) === JSON.stringify(draft.reference)) continue;
      await this.readSource(bookId, draft.discussion);
    }
  }
  notes(bookId: string) {
    if (!this.notesRepository) throw new ReadingError('阅读笔记存储不可用。', 503);
    return this.notesRepository.get(bookId);
  }
  mutateNotes(bookId: string, command: ReadingNotesCommand) {
    if (!this.notesRepository) throw new ReadingError('阅读笔记存储不可用。', 503);
    const result = this.notesRepository.mutate(bookId, command, () => {
      const candidate = command.action === 'draft' ? command.draft : command.action === 'save' ? command.nextDraft : null;
      if (candidate) this.validateNoteDraft(bookId, candidate);
      if (command.action === 'save' && this.notes(bookId).draft) this.validateNoteDraft(bookId, this.notes(bookId).draft!);
    });
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId });
    return result.state;
  }
  private validateNoteDraft(bookId: string, draft: ReadingNoteDraft) {
    const book = this.repository.get(bookId);
    if (draft.reference.bookId !== bookId || !book || !validBookReference(book, draft.reference)) {
      const existing = this.notes(bookId).notes.find(n => n.id === draft.id) ?? this.notes(bookId).draft;
      if (!existing || JSON.stringify(existing.reference) !== JSON.stringify(draft.reference)) throw new ReadingError('笔记原文引用无效。');
    }
    if (draft.origin === 'companion' && !draft.discussion) throw new ReadingError('书伴笔记必须保留来源讨论。');
    if (draft.origin === 'companion') {
      const existing = this.notes(bookId).notes.find(n => n.id === draft.id) ?? this.notes(bookId).draft;
      const source = this.sourceMessages.get(`${draft.discussion!.sessionId}/${draft.discussion!.piEntryId}`);
      if ((!existing || existing.origin !== 'companion' || JSON.stringify(existing.discussion) !== JSON.stringify(draft.discussion)) && (!source || source.role !== 'assistant' || JSON.stringify(source.readingReference) !== JSON.stringify(draft.reference))) throw new ReadingError('书伴笔记来源消息无法核对。');
    }
    if (draft.discussion && this.discussion(draft.discussion.sessionId)?.bookId !== bookId) throw new ReadingError('笔记来源讨论不属于当前书籍。');
  }
  discussion(sessionId: string) { return this.repository.discussion(sessionId); }
  scope(bookId: string) { return this.repository.scope(this.get(bookId)); }
  setScope(bookId: string, command: ReadingScopeCommand) {
    const book = this.get(bookId);
    if (command.boundary && positionRank(book, command.boundary) < 0) throw new ReadingError('已读边界原文位置无效。');
    const result = this.repository.setScope(book, command, readingHash(JSON.stringify([bookId, command])));
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId });
    return result.scope;
  }
  ensureCompanion(bookId: string) {
    const book = this.get(bookId);
    if (!this.sessionsDir) throw new ReadingError('书伴会话目录不可用。', 503);
    const existed = this.repository.discussion(`reading-${book.version}`);
    const discussion = this.repository.ensureCompanion(book, join(this.sessionsDir, `reading-${book.version}`));
    if (!existed) this.events?.publish({ type: 'reading.changed', bookId });
    return discussion;
  }
  context(sessionId: string, reference: BookReference): CoordinatorSessionContext {
    const discussion = this.discussion(sessionId);
    if (!discussion || discussion.bookId !== reference.bookId) throw new ReadingError('书籍引用不属于当前书伴。');
    const book = this.get(reference.bookId);
    if (!validBookReference(book, reference) || reference.text.length > 16000) throw new ReadingError('书籍引用无效或超过 16000 字符，请缩短选区。');
    const scope = this.scope(book.id);
    const first = bookParagraphs(book)[0]!;
    const read = scope.boundary ? referenceText(book, { chapterId: first.chapterId, paragraphId: first.id, offset: 0 }, scope.boundary) : '';
    const characters = [...read];
    return { kind: 'reading', title: book.title, reference, boundary: scope.boundary, excerpt: characters.slice(-16000).join(''), truncated: characters.length > 16000 };
  }
  list() { return this.repository.list(); }
  get(id: string) {
    const book = this.repository.get(id);
    if (!book) throw new ReadingError('书籍不存在或已删除。', 404);
    return book;
  }
  annotations(id: string) { return this.repository.annotations(id); }
  annotate(id: string, input: AnnotationCommand) {
    const fingerprint = readingHash(JSON.stringify([id, input]));
    const receipt = this.repository.annotationReceipt(input.commandId, fingerprint);
    if (receipt) return receipt;
    if (input.action === 'save') {
      const previous = this.repository.annotations(id).find(record => record.id === input.id);
      const reference = input.reference ?? previous?.reference;
      if (!reference || !validBookReference(this.get(id), reference)) throw new ReadingError('原文引用版本或位置已失效，摘录仍可查看。', 409);
    }
    const result = this.repository.annotate(id, input, fingerprint);
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId: id });
    return { record: result.record };
  }
  async import(input: ImportBook) {
    const book = parseBook(input);
    await mkdir(this.sourceDir, { recursive: true, mode: 0o700 });
    // 文件名仅由服务端正文签名派生；不可变来源先落盘，SQLite 再发布书籍与回执。
    try { await writeFile(join(this.sourceDir, `${book.version}.${book.format}`), input.text, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const existed = this.repository.get(book.id);
    const saved = this.repository.import(book, input.commandId, readingHash(JSON.stringify([input.title, input.author, input.format, input.text])));
    if (!existed) this.events?.publish({ type: 'reading.changed', bookId: book.id });
    return saved;
  }
}
