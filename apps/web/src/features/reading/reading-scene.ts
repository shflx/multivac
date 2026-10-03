import { Check } from 'typebox/value';
import { BookPositionSchema, BookReferenceSchema, ReadingMessageSourceSchema, bookParagraphs, positionRank, type Book, type BookPosition, type BookReference, type ReadingMessageSource } from '@multivac/contracts';

export interface ReadingScene {
  version: string; position: BookPosition; fontSize: number; navigation: boolean;
  navigationTab: 'shelf' | 'toc' | 'bookmarks'; right: { open: boolean; tab: 'companion' | 'notes' | 'highlights' };
  lastSide: 'left' | 'right'; pane: 'reader' | 'navigation' | 'right'; returnPosition: BookPosition | null;
  companionQuote: BookReference | null; discussionId: string | null; companionSource: ReadingMessageSource | null;
  discussionScenes: Record<string, { quote: BookReference | null; source: ReadingMessageSource | null }>;
}
export function restoreReadingScene(book: Book): ReadingScene {
  const p = bookParagraphs(book)[0]!;
  const base: ReadingScene = { version: book.version, position: { chapterId: p.chapterId, paragraphId: p.id, offset: 0 }, fontSize: 18, navigation: true, navigationTab: 'shelf', right: { open: false, tab: 'companion' }, lastSide: 'left', pane: 'reader', returnPosition: null, companionQuote: null, discussionId: null, companionSource: null, discussionScenes: {} };
  try {
    const value = JSON.parse(localStorage.getItem(`multivac.reading.scene.${book.id}`) ?? 'null') as Partial<ReadingScene> & { companionOpen?: boolean } | null;
    if (!value || value.version !== book.version) return base;
    const quote = (r: unknown) => Check(BookReferenceSchema, r) ? r : null;
    const source = (r: unknown) => Check(ReadingMessageSourceSchema, r) ? r : null;
    const position = (r: unknown) => Check(BookPositionSchema, r) && positionRank(book, r) >= 0 ? r : null;
    return { ...base,
      position: position(value.position) ?? base.position, returnPosition: position(value.returnPosition),
      fontSize: Math.min(32, Math.max(14, Number(value.fontSize) || 18)), navigation: typeof value.navigation === 'boolean' ? value.navigation : base.navigation,
      navigationTab: value.navigationTab === 'toc' || value.navigationTab === 'bookmarks' ? value.navigationTab : 'shelf',
      right: value.right && ['companion', 'notes', 'highlights'].includes(value.right.tab) ? { open: Boolean(value.right.open), tab: value.right.tab } : { open: Boolean(value.companionOpen), tab: 'companion' },
      lastSide: value.lastSide === 'right' ? 'right' : 'left', pane: value.pane === 'navigation' || value.pane === 'right' ? value.pane : 'reader',
      companionQuote: quote(value.companionQuote), companionSource: source(value.companionSource), discussionId: typeof value.discussionId === 'string' ? value.discussionId : null,
      discussionScenes: Object.fromEntries(Object.entries(value.discussionScenes ?? {}).slice(0, 100).map(([id, r]) => [id, { quote: quote(r?.quote), source: source(r?.source) }])),
    };
  } catch { return base; }
}
export function readingPanelLayout(scene: ReadingScene, width: number, narrow: boolean) {
  const compact = narrow || width < 680;
  if (compact) return { compact, left: scene.navigation && scene.pane === 'navigation', right: scene.right.open && scene.pane === 'right', reader: scene.pane === 'reader' || scene.pane === 'navigation' && !scene.navigation || scene.pane === 'right' && !scene.right.open };
  return { compact, left: scene.navigation && (width >= 1000 || !scene.right.open || scene.lastSide === 'left'), right: scene.right.open && (width >= 1000 || !scene.navigation || scene.lastSide === 'right'), reader: true };
}
