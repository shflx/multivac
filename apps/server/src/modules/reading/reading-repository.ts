import type {
  AnnotationCommand, Book, BookIndex, BookPosition, BookReference, BookSummary, BookTocEntry,
  ReadingAnnotation, ReadingCollectionItem, ReadingCollectionTarget, ReadingDiscussion,
  ReadingNotesCommand, ReadingNotesState, ReadingScope, ReadingScopeCommand,
} from '@multivac/contracts';

/**
 * 书籍正文的按需读取：索引、分块正文与引用核对。正文版本不可变，读取有界，不先加载整书。
 */
export interface BookContentRepository {
  index(id: string): BookIndex;
  putBlock(id: string, ordinal: number, chapters: Book['chapters']): void;
  putIndex(index: BookIndex): void;
  /** 只更新导航目录，不改正文与段落身份。 */
  setToc(id: string, toc: BookTocEntry[]): BookIndex;
  summary(id: string): BookSummary;
  block(id: string, ordinal: number): Book;
  full(id: string): Book;
  /** 段落在全书中的位置；不存在时返回 null。 */
  position(id: string, position: BookPosition): { rank: number; id: string; length: number; block: number } | null;
  validReference(id: string, reference: BookReference): boolean;
  readRange(id: string, startPosition: BookPosition, endPosition: BookPosition, imageIds?: string[]): BookReference;
  readTail(id: string, boundary: BookPosition | null): { excerpt: string; truncated: boolean };
}

/** 书籍、已读范围、书伴讨论与标注的仓储端口；命令回执与事实在同一短事务内提交。 */
export interface ReadingRepository {
  readonly content: BookContentRepository;
  scope(book: BookSummary): ReadingScope;
  setScope(book: BookSummary, command: ReadingScopeCommand, fingerprint: string): { scope: ReadingScope; changed: boolean };
  discussion(sessionId: string): ReadingDiscussion | null;
  discussions(bookId: string): ReadingDiscussion[];
  allDiscussions(): ReadingDiscussion[];
  discussionReceipt(commandId: string, fingerprint: string): ReadingDiscussion | null;
  createDiscussion(discussion: ReadingDiscussion, directory: string, commandId: string, fingerprint: string): ReadingDiscussion;
  ensureCompanion(book: BookSummary, directory: string): ReadingDiscussion;
  get(id: string): Book | null;
  remove(id: string): boolean;
  list(): BookSummary[];
  /** 同源同格式重复导入返回原书，不发布半本书。 */
  importIndexed(index: BookIndex, commandId: string, fingerprint: string, blocks: Iterable<Book['chapters']>): { book: BookSummary; changed: boolean };
  annotations(bookId: string): ReadingAnnotation[];
  annotationReceipt(commandId: string, fingerprint: string): { record: ReadingAnnotation | null } | null;
  annotate(bookId: string, input: AnnotationCommand, fingerprint: string): { record: ReadingAnnotation | null; changed: boolean };
  import(book: Book, commandId: string, fingerprint: string): Book;
}

/** 阅读笔记与草稿的仓储端口：笔记与草稿共用版本，旧版本不能覆盖新内容。 */
export interface ReadingNotesRepository {
  receipt(bookId: string, command: ReadingNotesCommand): ReadingNotesState | null;
  get(bookId: string): ReadingNotesState;
  /** validate 在事务内、写入前执行。 */
  mutate(bookId: string, command: ReadingNotesCommand, validate: () => void): { state: ReadingNotesState; changed: boolean };
}

/** 阅读摘录收集目标与条目的仓储端口。 */
export interface ReadingCollectionRepository {
  targets(): ReadingCollectionTarget[];
  items(targetId: string): ReadingCollectionItem[];
  receipt(commandId: string, fingerprint: string): ReadingCollectionItem | ReadingCollectionTarget | null;
  createTarget(commandId: string, title: string): ReadingCollectionTarget;
  collect(item: ReadingCollectionItem, identity: string, commandId: string, fingerprint: string): { item: ReadingCollectionItem; changed: boolean };
}
