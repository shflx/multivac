import React from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Pencil, X } from 'lucide-react';
import { annotationSegments } from './reading-state.js';

export function ReadingPage({ book, state, page, pageIndex, pages, visible, mainRef, viewportRef, articleRef, pageInput, onPageInput, onJump, onTurn, onCapture, flash, bookmarked, onBookmark, onNote, onViewNotes, onRead, returnPosition, onReturn, onDismissReturn }) {
  const annotations = [...state.highlights, ...state.notes.filter((note) => note.reference), ...(flash ? [{ id: 'flash', reference: flash }] : [])];
  return <main ref={mainRef} className="reading-main" hidden={!visible} aria-hidden={!visible}>
    <header className="reading-chapter">
      <span title={page?.chapterTitle}>{page?.chapterTitle || book.chapters[state.chapterIndex].title}</span>
      <div>{returnPosition && <><button type="button" className="text-button reading-return-button" aria-label="返回之前阅读处" title="返回之前阅读处" onClick={onReturn}><ArrowLeft /><span>返回阅读处</span></button><button type="button" className="icon-button" aria-label="关闭返回提示" onClick={onDismissReturn}><X /></button></>}<button type="button" className="icon-button" disabled={!page} aria-label={bookmarked ? '取消当前页书签' : '添加当前页书签'} title={bookmarked ? '取消当前页书签' : '添加当前页书签'} aria-pressed={bookmarked} onClick={onBookmark}><Bookmark fill={bookmarked ? 'currentColor' : 'none'} /></button>
        <button type="button" className="icon-button" disabled={!page} aria-label={state.noteDraft ? '继续阅读笔记草稿' : '为当前页写笔记'} title={state.noteDraft ? '继续阅读笔记草稿' : '为当前页写笔记'} onClick={onNote}><Pencil />{state.noteDraft && <i className="reading-draft-dot" />}</button></div>
    </header>
    <div className="reading-page-viewport" ref={viewportRef}>
      <article ref={articleRef} tabIndex={0} aria-label={`阅读正文，第 ${pageIndex + 1} 页`} className="reading-prose" style={{ fontSize: state.settings.fontSize }} onMouseDown={(event) => { if (!event.target.closest('button, [role="button"]')) event.currentTarget.focus({ preventScroll: true }); }} onMouseUp={onCapture} onTouchEnd={() => setTimeout(onCapture, 0)} onKeyUp={onCapture}>
        {page?.fragments.map((fragment) => {
          const segments = annotationSegments(book, fragment, annotations);
          const noteIds = [...new Set(segments.flatMap((segment) => segment.annotations.filter((annotation) => state.notes.some((note) => note.id === annotation.id)).map((annotation) => annotation.id)))];
          return <p key={`${fragment.paragraphId}:${fragment.start}`}>
            <span data-reading-fragment="true" data-chapter={fragment.chapterId} data-paragraph-id={fragment.paragraphId} data-start={fragment.start}>
              {segments.map((segment) => {
                const text = fragment.text.slice(segment.start - fragment.start, segment.end - fragment.start);
                if (!segment.annotations.length) return <React.Fragment key={segment.start}>{text}</React.Fragment>;
                const related = segment.annotations.filter((annotation) => state.notes.some((note) => note.id === annotation.id)).map((annotation) => annotation.id);
                const view = () => onViewNotes(related);
                return <mark key={segment.start} className={`${segment.annotations.some((annotation) => annotation.id === 'flash') ? 'reading-located' : ''} ${related.length ? 'reading-note-mark' : ''}`} role={related.length ? 'button' : undefined} tabIndex={related.length ? 0 : undefined} title={related.length ? `查看 ${related.length} 条关联笔记` : '正文划线'} onClick={related.length ? () => { if (!window.getSelection()?.toString()) view(); } : undefined} onKeyDown={related.length ? (event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); view(); } } : undefined}>{text}</mark>;
              })}
            </span>
            {noteIds.length > 0 && <button type="button" className="reading-margin-note" title={`查看此段 ${noteIds.length} 条笔记`} aria-label={`查看此段 ${noteIds.length} 条笔记`} onClick={() => onViewNotes(noteIds)}><Pencil /></button>}
          </p>;
        })}
      </article>
    </div>
    <footer className="reading-navigation">
      <button type="button" className="secondary" disabled={pageIndex === 0} onClick={() => onTurn(pageIndex - 1)}><ArrowLeft /><span>上一页</span></button>
      <form onSubmit={(event) => { event.preventDefault(); onJump(pageInput); }}><label>第 <input type="text" aria-label="跳转页码" inputMode="numeric" value={pageInput} onChange={(event) => onPageInput(event.target.value)} onFocus={(event) => event.target.select()} /> / {pages.length || '—'} 页</label><button type="submit" className="text-button">跳转</button></form>
      <button type="button" className="secondary" disabled={!pages.length || pageIndex === pages.length - 1} onClick={() => onTurn(pageIndex + 1)}><span>下一页</span><ArrowRight /></button>
      <button type="button" className="inline-link reading-mark-read" disabled={!page} onClick={onRead}>本页已读</button>
    </footer>
  </main>;
}
