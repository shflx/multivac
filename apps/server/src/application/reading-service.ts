import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stageBookImport, readFilePdfOutline } from '../modules/reading/stream-book-import.js';
import type { Book, BookUpload, BookIndex, ReadingAdjacentPages } from '@multivac/contracts';
import { mkdir, writeFile, link, rm, statfs, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bookLocation, readingNoteLocation, assistantQuoteWithinLimit, type BookLocation, type AssistantBookQuote, type CoordinatorBookQuote, type ImportBook, type AnnotationCommand, type ReadingScopeCommand, type BookReference, type CoordinatorSessionContext, type ReadingNotesCommand, type ReadingNoteDraft } from '@multivac/contracts';
import { pdfToc } from '../modules/reading/pdf-outline.js';
import { decodeBookSource, parseBinaryBook } from '../modules/reading/binary-book-import.js';
import { parseBook, readingHash, ReadingError } from '../modules/reading/book-import.js';
import type { SqliteReadingRepository } from '../storage/sqlite-reading-repository.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';
import type { SqliteReadingNotesRepository } from '../storage/sqlite-reading-notes-repository.js';
import type { AssistantMessageView, AssistantContextRef, ReadingMessageSource, CreateReadingDiscussion, ReadingDiscussion } from '@multivac/contracts';
import type { SqliteReadingCollectionRepository } from '../storage/sqlite-reading-collection-repository.js';
import type { CollectReadingCommand, ReadingCollectionItem } from '@multivac/contracts';

export class ReadingService {
  private importing = false;
  private readonly tocUpdates = new Map<string, Promise<BookIndex>>();
  private readonly pageSnapshots = new Map<string, { sessionId: string; bookId: string; version: string; pages: ReadingAdjacentPages }>();
  private readHistory?: (sessionId: string) => Promise<readonly AssistantMessageView[]>;
  private readonly sourceMessages = new Map<string, AssistantMessageView>();
  constructor(private readonly repository: SqliteReadingRepository, private readonly sourceDir: string, private readonly events?: WorkbenchEventPublisher, private readonly sessionsDir?: string, private readonly notesRepository?: SqliteReadingNotesRepository, private readonly collection?: SqliteReadingCollectionRepository) {}
  targets() { if (!this.collection) throw new ReadingError('笔记收集存储不可用。', 503); return this.collection.targets(); }
  collectionItems(targetId: string) { if (!this.collection) throw new ReadingError('笔记收集存储不可用。', 503); return this.collection.items(targetId); }
  createCollectionTarget(commandId: string, title: string) {
    if (!this.collection) throw new ReadingError('笔记收集存储不可用。', 503);
    const receipt = this.collection.receipt(commandId, readingHash(JSON.stringify(['target', title])));
    if (receipt) return receipt as import('@multivac/contracts').ReadingCollectionTarget;
    const result = this.collection.createTarget(commandId, title); this.events?.publish({ type: 'reading.changed', bookId: '' }); return result;
  }
  async collect(command: CollectReadingCommand): Promise<ReadingCollectionItem> {
    if (!this.collection) throw new ReadingError('笔记收集存储不可用。', 503);
    const fingerprint = readingHash(JSON.stringify(['collect', command]));
    const receipt = this.collection.receipt(command.commandId, fingerprint); if (receipt) return receipt as ReadingCollectionItem;
    const source = command.source;
    const bookId = source.kind === 'excerpt' ? source.reference.bookId : source.bookId;
    const book = this.header(bookId);
    let reference: BookReference | undefined; let location: BookLocation; let body: string; let discussion: ReadingMessageSource | undefined; let sourceNote: ReadingCollectionItem['sourceNote'];
    if (source.kind === 'excerpt') { reference = source.reference; location = bookLocation(reference); body = reference.text; }
    else if (source.kind === 'reading-note') {
      const note = this.notes(bookId).notes.find(n => n.id === source.noteId);
      if (!note || note.revision !== source.noteRevision) throw new ReadingError('阅读笔记已改变或删除，请重新读取后收集。', 409);
      reference = note.reference; location = readingNoteLocation(note); body = note.body; discussion = note.discussion; sourceNote = { id: note.id, revision: note.revision };
    } else { const message = await this.readSource(bookId, source.message); if (message.role !== 'assistant') throw new ReadingError('只接受书伴回答作为解释来源。'); reference = message.readingReference!; location = bookLocation(reference); body = message.text; discussion = source.message; }
    if (!this.validLocation(book.id, location) || reference && !this.validReference(book.id, reference) || body.length > 16000) throw new ReadingError('来源原文已失效或超过收集长度限制。', 409);
    const item: ReadingCollectionItem = { id: `collected-${readingHash(command.commandId)}`, targetId: command.targetId, kind: source.kind, location, ...(reference ? { reference } : {}), body, bookTitle: book.title, createdAt: new Date().toISOString(), ...(discussion ? { discussion } : {}), ...(sourceNote ? { sourceNote } : {}) };
    const identity = readingHash(JSON.stringify([command.targetId, source]));
    const result = this.collection.collect(item, identity, command.commandId, fingerprint);
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId });
    return result.item;
  }
  setHistoryResolver(resolver: (sessionId: string) => Promise<readonly AssistantMessageView[]>) { this.readHistory = resolver; }
  async resolveBookQuote(quote: AssistantBookQuote): Promise<CoordinatorBookQuote> {
    const book = this.header(quote.sourceBook.bookId);
    const location = bookLocation(quote.sourceBook);
    if (!this.validLocation(book.id, location) || 'text' in quote.sourceBook && !this.validReference(book.id, quote.sourceBook) || !assistantQuoteWithinLimit(quote) || quote.sourceMessage && quote.sourceNote) throw new ReadingError('书籍引用无效或超过引用长度限制，请缩短选区。');
    if (!('text' in quote.sourceBook) && !quote.sourceNote) throw new ReadingError('无摘录的交接必须来自已保存笔记。');
    let expectedText = 'text' in quote.sourceBook ? quote.sourceBook.text : '';
    if (quote.sourceMessage) {
      const source = await this.readSource(book.id, quote.sourceMessage);
      if (JSON.stringify(source.readingReference) !== JSON.stringify(quote.sourceBook)) throw new ReadingError('书伴解释与原文来源不一致。');
      expectedText = source.text;
    }
    if (quote.sourceNote) {
      const note = this.notes(book.id).notes.find(n => n.id === quote.sourceNote!.id && n.revision === quote.sourceNote!.revision);
      if (!note || JSON.stringify(note.reference ?? readingNoteLocation(note)) !== JSON.stringify(quote.sourceBook)) throw new ReadingError('阅读笔记来源已改变或失效。');
      expectedText = note.body;
    }
    if (quote.text !== expectedText) throw new ReadingError('交接内容与真实来源不一致。');
    return { sourceKind: 'book', sourceBook: quote.sourceBook, text: quote.text, sourceTitle: book.title, ...(quote.sourceMessage ? { sourceMessage: quote.sourceMessage } : {}), ...(quote.sourceNote ? { sourceNote: quote.sourceNote } : {}) };
  }
  focusedBookContext(reference: BookReference): CoordinatorSessionContext {
    const book = this.header(reference.bookId);
    if (!this.validReference(book.id, reference) || reference.text.length > 16000) throw new ReadingError('当前阅读来源已失效或超过范围限制。');
    return { kind: 'reading', title: book.title, reference, excerpt: '', boundary: null, truncated: false };
  }
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
    const context = this.context(sessionId, ref.reference, false);
    if (ref.pageReference) {
      if (ref.pageReference.bookId !== ref.reference.bookId || ref.pageReference.version !== ref.reference.version || !this.validReference(ref.reference.bookId, ref.pageReference)) throw new ReadingError('当前页原文与书籍不一致或已失效。');
      if (context.kind === 'reading') context.currentPage = ref.pageReference;
    }
    if (context.kind === 'reading') {
      if (ref.referenceKind) context.referenceKind = ref.referenceKind;
      if (ref.referenceKind && !ref.pageReference) throw new ReadingError('本轮阅读上下文缺少当前页。');
      if (ref.referenceKind === 'current-page' && (JSON.stringify(ref.reference) !== JSON.stringify(ref.pageReference) || ref.sourceMessage)) throw new ReadingError('当前页来源与本轮上下文不一致。');
      if (ref.referenceKind === 'follow-up' && !ref.sourceMessage) throw new ReadingError('继续追问缺少来源消息。');
      if (ref.referenceKind && ref.referenceKind !== 'follow-up' && ref.sourceMessage) throw new ReadingError('引用类型与追问来源不一致。');
      if (ref.referenceKind === 'discussion' && JSON.stringify(this.discussion(sessionId)?.reference) !== JSON.stringify(ref.reference)) throw new ReadingError('独立讨论引用与原始来源不一致。');
    }
    if (ref.sourceMessage) {
      const source = await this.readSource(ref.reference.bookId, ref.sourceMessage);
      if (JSON.stringify(source.readingReference) !== JSON.stringify(ref.reference)) throw new ReadingError('追问原文与来源消息不一致。');
    }
    if (ref.adjacentPages && context.kind === 'reading') {
      if (!ref.pageReference) throw new ReadingError('相邻页缺少本轮当前页基准。');
      const currentStart = this.repository.content.position(ref.reference.bookId, ref.pageReference.start)!;
      const currentEnd = this.repository.content.position(ref.reference.bookId, ref.pageReference.end)!;
      for (const direction of ['previous', 'next'] as const) {
        const page = ref.adjacentPages[direction]; if (!page) continue;
        const start = this.repository.content.position(ref.reference.bookId, page.start), end = this.repository.content.position(ref.reference.bookId, page.end);
        if (!start || !end || end.rank <= start.rank || end.rank - start.rank > 16000) throw new ReadingError('相邻页原文位置无效或过长。');
        const left = direction === 'previous' ? end : currentEnd;
        const right = direction === 'previous' ? currentStart : start;
        const leftPosition = direction === 'previous' ? page.end : ref.pageReference.end;
        const rightPosition = direction === 'previous' ? ref.pageReference.start : page.start;
        const gap = right.rank - left.rank;
        const sameParagraph = leftPosition.chapterId === rightPosition.chapterId && leftPosition.paragraphId === rightPosition.paragraphId;
        if (!(sameParagraph ? gap === 0 : gap === 1 && leftPosition.offset === left.length && rightPosition.offset === 0)) throw new ReadingError('工具只能读取紧邻本轮当前页的页面。');
      }
      const contextId = randomUUID();
      this.pageSnapshots.set(contextId, { sessionId, bookId: ref.reference.bookId, version: ref.reference.version, pages: structuredClone(ref.adjacentPages) });
      while (this.pageSnapshots.size > 128) this.pageSnapshots.delete(this.pageSnapshots.keys().next().value!);
      context.pageTools = { contextId, previousAvailable: Boolean(ref.adjacentPages.previous), nextAvailable: Boolean(ref.adjacentPages.next) };
    }
    return context;
  }
  readAdjacentPage(sessionId: string, contextId: string, direction: 'previous' | 'next') {
    const snapshot = this.pageSnapshots.get(contextId);
    if (!snapshot || snapshot.sessionId !== sessionId || this.discussion(sessionId)?.bookId !== snapshot.bookId) throw new ReadingError('本轮页面快照已失效，请重新发送问题。');
    const book = this.header(snapshot.bookId);
    if (book.version !== snapshot.version) throw new ReadingError('书籍版本已变化，页面快照已失效。');
    const page = snapshot.pages[direction];
    if (!page) return { available: false, message: direction === 'previous' ? '已在书首，没有上一页。' : '已在书末，没有下一页。' };
    const reference = this.repository.content.readRange(snapshot.bookId, page.start, page.end);
    return { available: true, bookTitle: book.title, direction, reference };
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
    if (!this.validReference(bookId, reference) || reference.text.length > 16000) throw new ReadingError('原文位置已失效或选区超过 16000 字符。', 409);
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
      if (existing?.id === draft.id && existing.origin === draft.origin && JSON.stringify(existing.discussion) === JSON.stringify(draft.discussion) && JSON.stringify(readingNoteLocation(existing)) === JSON.stringify(readingNoteLocation(draft))) continue;
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
    const state = this.notes(bookId);
    const existing = state.notes.find(n => n.id === draft.id) ?? (state.draft?.id === draft.id ? state.draft : null);
    const location = readingNoteLocation(draft);
    const sameLocation = existing && JSON.stringify(readingNoteLocation(existing)) === JSON.stringify(location);
    // 失效的旧位置仍可保留并编辑正文，不能伪造新位置或跨书定位。
    if (location.bookId !== bookId || !this.validLocation(bookId, location) && !sameLocation) throw new ReadingError('笔记原文位置无效。');
    if (draft.reference) {
      if (draft.reference.bookId !== location.bookId || draft.reference.version !== location.version) throw new ReadingError('笔记引用与记录位置不一致。');
      if (!this.validReference(bookId, draft.reference) && (!existing || JSON.stringify(existing.reference) !== JSON.stringify(draft.reference))) throw new ReadingError('笔记原文引用无效。');
    }
    if (draft.origin === 'companion' && !draft.discussion) throw new ReadingError('书伴笔记必须保留来源讨论。');
    if (draft.origin === 'companion') {
      const retainedSource = existing?.origin === 'companion' && sameLocation && JSON.stringify(existing.discussion) === JSON.stringify(draft.discussion);
      const source = this.sourceMessages.get(`${draft.discussion!.sessionId}/${draft.discussion!.piEntryId}`);
      if (!retainedSource && (!source?.readingReference || source.role !== 'assistant' || JSON.stringify(bookLocation(source.readingReference)) !== JSON.stringify(location) || draft.reference && JSON.stringify(source.readingReference) !== JSON.stringify(draft.reference))) throw new ReadingError('书伴笔记来源消息无法核对。');
    }
    if (draft.discussion && this.discussion(draft.discussion.sessionId)?.bookId !== bookId) throw new ReadingError('笔记来源讨论不属于当前书籍。');
  }
  discussion(sessionId: string) { return this.repository.discussion(sessionId); }
  scope(bookId: string) { return this.repository.scope(this.header(bookId)); }
  setScope(bookId: string, command: ReadingScopeCommand) {
    const book = this.header(bookId);
    if (command.boundary && !this.repository.content.position(bookId, command.boundary)) throw new ReadingError('已读边界原文位置无效。');
    const result = this.repository.setScope(book, command, readingHash(JSON.stringify([bookId, command])));
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId });
    return result.scope;
  }
  ensureCompanion(bookId: string) {
    const book = this.header(bookId);
    if (!this.sessionsDir) throw new ReadingError('书伴会话目录不可用。', 503);
    const existed = this.repository.discussion(`reading-${book.version}`);
    const discussion = this.repository.ensureCompanion(book, join(this.sessionsDir, `reading-${book.version}`));
    if (!existed) this.events?.publish({ type: 'reading.changed', bookId });
    return discussion;
  }
  context(sessionId: string, reference: BookReference, includeReadText = true): CoordinatorSessionContext {
    const discussion = this.discussion(sessionId);
    if (!discussion || discussion.bookId !== reference.bookId) throw new ReadingError('书籍引用不属于当前书伴。');
    const book = this.header(reference.bookId);
    if (!this.validReference(book.id, reference) || reference.text.length > 16000) throw new ReadingError('书籍引用无效或超过 16000 字符，请缩短选区。');
    // 普通书伴发送不额外读取已读正文；历史、当前页、可选引用与用户输入构成本轮上下文。
    if (!includeReadText) return { kind: 'reading', title: book.title, reference, excerpt: '', boundary: null, truncated: false };
    const scope = this.scope(book.id);
    const tail = this.repository.content.readTail(book.id, scope.boundary);
    return { kind: 'reading', title: book.title, reference, boundary: scope.boundary, ...tail };
  }
  header(id: string) { return this.repository.content.summary(id); }
  position(id: string, position: import('@multivac/contracts').BookPosition) { return this.repository.content.position(id, position); }
  index(id: string) { return this.repository.content.index(id); }
  async prepareIndex(id: string): Promise<BookIndex> {
    const index = this.index(id);
    if (index.format !== 'pdf' || index.toc !== undefined) return index;
    const pending = this.tocUpdates.get(id);
    if (pending) return pending;
    // 旧书只补建导航索引，不重提正文，也不改变书签、笔记和引用锚点。
    const update = (async () => {
      const path = join(this.sourceDir, `${index.version}.pdf`);
      try { await stat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return index; throw error; }
      const outline = await readFilePdfOutline(path);
      const current = this.index(id);
      return this.repository.content.setToc(id, pdfToc(outline, current.chapters));
    })();
    this.tocUpdates.set(id, update);
    try { return await update; }
    finally { this.tocUpdates.delete(id); }
  }
  window(id: string, block: number) {
    if (!Number.isSafeInteger(block) || block < 0) throw new ReadingError('正文位置无效。');
    return { book: this.repository.content.block(id, block), block };
  }
  private validLocation(id: string, location: BookLocation) {
    return location.bookId === id && location.version === this.header(id).version && Boolean(this.position(id, location.position));
  }
  private validReference(id: string, reference: BookReference) {
    try { return this.repository.content.validReference(id, reference); }
    catch (error) { if (error instanceof ReadingError && error.status === 404) return false; throw error; }
  }
  async importStream(metadata: BookUpload, stream: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    if (this.importing) throw new ReadingError('已有书籍正在导入，请稍后重试。', 409);
    if (!metadata.title.trim()) throw new ReadingError('书名不能为空。');
    this.importing = true;
    let staged: Awaited<ReturnType<typeof stageBookImport>> | undefined;
    try {
      staged = await stageBookImport(this.sourceDir, metadata, stream, signal);
      signal.throwIfAborted();
      const { index, directory, path, sourceHash, blockBytes } = staged;
      const space = await statfs(this.sourceDir);
      // 给 SQLite 事务与日志预留空间，不能等写满磁盘后再发布书籍。
      if (space.bavail * space.bsize < blockBytes * 2 + Buffer.byteLength(JSON.stringify(index)) * 2 + 64 * 1024 * 1024) throw new ReadingError('磁盘剩余空间不足以保存正文，请释放空间后重试。', 507);
      try { await link(path, join(this.sourceDir, `${index.version}.${index.format}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      function* blocks() { for (let n = 0; n < index.blockCount; n++) yield JSON.parse(readFileSync(join(directory, `${n}.json`), 'utf8')) as Book['chapters']; }
      const fingerprint = readingHash(JSON.stringify([metadata.title, metadata.author, metadata.format, sourceHash]));
      const result = this.repository.importIndexed(index, metadata.commandId, fingerprint, blocks());
      if (result.changed) this.events?.publish({ type: 'reading.changed', bookId: result.book.id });
      return result.book;
    } finally {
      try { if (staged) await rm(staged.directory, { recursive: true, force: true }); }
      finally { this.importing = false; }
    }
  }

  remove(id: string) {
    if (this.repository.remove(id)) {
      for (const [key, snapshot] of this.pageSnapshots) if (snapshot.bookId === id) this.pageSnapshots.delete(key);
      for (const [key, message] of this.sourceMessages) if (message.readingReference?.bookId === id) this.sourceMessages.delete(key);
      this.events?.publish({ type: 'reading.changed', bookId: id });
    }
    return { books: this.list() };
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
      if (!reference || !this.validReference(id, reference)) throw new ReadingError('原文引用版本或位置已失效，摘录仍可查看。', 409);
    }
    const result = this.repository.annotate(id, input, fingerprint);
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId: id });
    return { record: result.record };
  }
  async import(input: ImportBook) {
    const source = 'text' in input ? input.text : decodeBookSource(input);
    const book = 'text' in input ? parseBook(input) : await parseBinaryBook(input, source as Buffer);
    await mkdir(this.sourceDir, { recursive: true, mode: 0o700 });
    // 文件名仅由服务端正文签名派生；不可变来源先落盘，SQLite 再发布书籍与回执。
    try { await writeFile(join(this.sourceDir, `${book.version}.${book.format}`), source, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const existed = this.repository.get(book.id);
    const saved = this.repository.import(book, input.commandId, readingHash(JSON.stringify([input.title, input.author, input.format, 'text' in input ? input.text : readingHash(source)])));
    if (!existed) this.events?.publish({ type: 'reading.changed', bookId: book.id });
    return saved;
  }
}
