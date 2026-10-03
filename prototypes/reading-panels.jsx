import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Highlighter, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import { bookParagraphs, pageIndexForPosition, positionRank, validReference } from './reading-state.js';

export function ReadingTabs({ label, tabs, value, onChange }) {
  return <div className="reading-panel-tabs" role="tablist" aria-label={label} onKeyDown={(event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); onChange(tabs[next].id);
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  }}>
    {tabs.map((tab) => <button type="button" key={tab.id} id={`reading-tab-${tab.id}`} role="tab" tabIndex={value === tab.id ? 0 : -1} aria-selected={value === tab.id} aria-controls={`reading-tabpanel-${tab.id}`} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </div>;
}

export function ReadingNavigation({ book, state, reading, pages, visible, compact, onClose, onTab, onChapter, onLocate, onBook }) {
  const scroll = useRef(null);
  const tab = state.view.navigation.tab;
  useLayoutEffect(() => { if (visible) scroll.current.scrollTop = state.view.navigationScroll[tab]; }, [visible, tab]);
  const bookmarks = state.bookmarks;
  return <aside id="reading-left-navigation" className="reading-left-navigation" aria-label={tab === 'shelf' ? '书架' : '阅读导航'} hidden={!visible}>
    <header className="reading-side-header"><strong>{tab === 'shelf' ? '书架' : '阅读导航'}</strong><button type="button" className="icon-button" aria-label={compact ? '返回正文' : '收起导航'} onClick={onClose}>{compact ? <ArrowLeft /> : <X />}</button></header>
    {tab !== 'shelf' && <ReadingTabs label="阅读导航" tabs={[{ id: 'toc', label: '目录' }, { id: 'bookmarks', label: `书签 · ${bookmarks.length}` }]} value={tab} onChange={onTab} />}
    <div ref={scroll} className="reading-side-scroll" onScroll={(event) => {
      const top = event.currentTarget.scrollTop;
      if (visible && top !== state.view.navigationScroll[tab]) reading.patch(book.id, (current) => ({ ...current, view: { ...current.view, navigationScroll: { ...current.view.navigationScroll, [tab]: top } } }));
    }}>
      {<div hidden={tab !== 'toc'} id="reading-tabpanel-toc" role="tabpanel" aria-labelledby="reading-tab-toc">
        {book.chapters.map((chapter) => {
          const paragraph = bookParagraphs(book).find((item) => item.chapterId === chapter.id);
          const position = { bookId: book.id, chapterId: chapter.id, paragraphId: paragraph.paragraphId, offset: 0 };
          return <button type="button" className={`reading-chapter-item ${state.position.chapterId === chapter.id ? 'active' : ''}`} aria-current={state.position.chapterId === chapter.id ? 'location' : undefined} key={chapter.id} onClick={() => onChapter(position)}><strong>{chapter.title}</strong><small>第 {pageIndexForPosition(book, pages, position) + 1} 页</small></button>;
        })}
      </div>}
      {<div hidden={tab !== 'bookmarks'} id="reading-tabpanel-bookmarks" role="tabpanel" aria-labelledby="reading-tab-bookmarks">
        {!bookmarks.length && <p className="reading-empty">点击正文页眉的书签图标，保存当前页。</p>}
        {bookmarks.map((bookmark) => {
          const available = validReference(book, bookmark.reference);
          const editing = state.view.bookmarkEditingId === bookmark.id;
          return <article className="reading-bookmark-item" key={bookmark.id}>
            <button type="button" className="reading-bookmark-location" disabled={!available} onClick={() => onLocate(bookmark.reference)}><strong>{bookmark.reference.text.slice(0, 62)}…</strong><small>{bookmark.reference.chapterTitle} · {available ? `第 ${pageIndexForPosition(book, pages, bookmark.reference.start) + 1} 页` : '原位置已失效'}</small>{bookmark.remark && <span>{bookmark.remark}</span>}</button>
            <div className="reading-bookmark-actions"><button type="button" className="inline-link" data-bookmark-editor={bookmark.id} aria-expanded={editing} aria-controls={`reading-bookmark-remark-${bookmark.id}`} onClick={() => reading.patch(book.id, (current) => ({ ...current, view: { ...current.view, bookmarkEditingId: editing ? null : bookmark.id } }))}><Pencil />{editing ? '收起备注' : '编辑备注'}</button><button type="button" className="icon-button" aria-label="删除书签" onClick={() => reading.patch(book.id, (current) => ({ ...current, bookmarks: current.bookmarks.filter((item) => item.id !== bookmark.id) }))}><Trash2 /></button></div>
            {<label hidden={!editing} id={`reading-bookmark-remark-${bookmark.id}`} className="reading-field">书签备注<input type="text" value={bookmark.remark} onChange={(event) => reading.patch(book.id, (current) => ({ ...current, bookmarks: current.bookmarks.map((item) => item.id === bookmark.id ? { ...item, remark: event.target.value } : item) }))} /></label>}
          </article>;
        })}
      </div>}
      {tab === 'shelf' && <>
        <div className="reading-library-list">{reading.books.map((item) => <button type="button" key={item.id} className="reading-library-item" aria-current={item.id === book.id ? 'true' : undefined} onClick={() => onBook(item.id)}><BookOpen /><span><strong>《{item.title}》</strong><small>{item.author}</small></span></button>)}</div>
      </>}
    </div>
  </aside>;
}

export function ReadingNotesPanel({ book, state, reading, visible, page, onLocate, onEdit, onNew, onResumeDraft, noteTarget }) {
  const scroll = useRef(null);
  const [section, setSection] = useState('notes');
  useLayoutEffect(() => { if (visible) scroll.current.scrollTop = state.view.notesScroll; }, [visible]);
  const sorted = [...state.notes].sort((a, b) => (validReference(book, a.reference) ? positionRank(book, a.reference.start) : Infinity) - (validReference(book, b.reference) ? positionRank(book, b.reference.start) : Infinity));
  const touchesPage = (reference) => validReference(book, reference) && page && positionRank(book, reference.start) < positionRank(book, page.end) && positionRank(book, reference.end) > positionRank(book, page.start);
  const source = (reference) => <button type="button" className="reading-note-location" disabled={!validReference(book, reference)} title="定位原文" onClick={() => onLocate(reference)}>{reference?.chapterTitle || '原文位置不可用'}{reference?.unavailable ? ' · 位置已失效' : ''}<ArrowLeft /></button>;
  const toggleExpanded = (id) => reading.patch(book.id, (current) => ({ ...current, view: { ...current.view, notesExpanded: current.view.notesExpanded.includes(id) ? current.view.notesExpanded.filter((value) => value !== id) : [...current.view.notesExpanded, id] } }));
  return <>
    <div className="reading-notes-toolbar">
      <ReadingTabs label="记录类型" tabs={[{ id: 'saved-notes', label: `笔记 ${sorted.length}` }, { id: 'saved-highlights', label: `划线 ${state.highlights.length}` }]} value={section === 'notes' ? 'saved-notes' : 'saved-highlights'} onChange={(id) => setSection(id === 'saved-notes' ? 'notes' : 'highlights')} />
      <button type="button" className="icon-button reading-new-note" title="为当前页写笔记" aria-label="为当前页写笔记" disabled={!page} onClick={() => onNew()}><Plus /></button>
    </div>
    <div ref={scroll} className="reading-notes-scroll" onScroll={(event) => { const top = event.currentTarget.scrollTop; if (visible && top !== state.view.notesScroll) reading.patch(book.id, (current) => ({ ...current, view: { ...current.view, notesScroll: top } })); }}>
      {state.noteDraft && <button type="button" className="reading-resume-note" onClick={onResumeDraft}><span className="reading-draft-dot" /><span>继续未完成的笔记</span><Pencil /></button>}
      <div id="reading-tabpanel-saved-notes" role="tabpanel" aria-labelledby="reading-tab-saved-notes" hidden={section !== 'notes'}>
        {!sorted.length && <div className="reading-notes-empty"><Pencil /><strong>把读到的，变成自己的</strong><p>选一段原文，记下此刻的想法。</p><button type="button" className="text-button" disabled={!page} onClick={() => onNew()}>记下第一条笔记<Plus /></button></div>}
        {sorted.map((note) => {
          const expanded = state.view.notesExpanded.includes(note.id);
          return <article id={`reading-note-${note.id}`} key={note.id} className="reading-note-entry">
            <div className="reading-note-meta">{source(note.reference)}{touchesPage(note.reference) && <span>本页</span>}</div>
            {note.reference?.text && <blockquote className={`reading-note-excerpt ${expanded ? 'expanded' : ''}`}>{note.reference.text}</blockquote>}
            <p id={`reading-note-body-${note.id}`} className={expanded ? 'reading-note-body' : 'reading-note-body reading-note-preview'}>{note.body}</p>
            <div className="reading-note-entry-footer">
              <button type="button" className="inline-link" aria-expanded={expanded} aria-controls={`reading-note-body-${note.id}`} onClick={() => toggleExpanded(note.id)}>{expanded ? '收起' : '展开'}</button>
              {note.origin === 'companion' && <small>来自书伴</small>}
              <button type="button" className="icon-button" title="编辑笔记" aria-label="编辑笔记" onClick={() => onEdit(note)}><Pencil /></button>
              <details className="reading-note-menu"><summary title="笔记操作" aria-label="笔记操作"><MoreHorizontal /></summary><div>
                <button type="button" onClick={(event) => { reading.collectNote(book, note); event.currentTarget.closest('details').open = false; }}>收进笔记「{noteTarget || '当前笔记'}」</button>
                <button type="button" onClick={() => reading.patch(book.id, (current) => ({ ...current, notes: current.notes.filter((item) => item.id !== note.id), noteDraft: current.noteDraft?.id === note.id ? null : current.noteDraft }))}>删除笔记</button>
              </div></details>
            </div>
          </article>;
        })}
      </div>
      <div id="reading-tabpanel-saved-highlights" role="tabpanel" aria-labelledby="reading-tab-saved-highlights" hidden={section !== 'highlights'}>
        {!state.highlights.length && <div className="reading-notes-empty"><Highlighter /><strong>留下值得重读的句子</strong><p>选中原文，点击“划线”即可收藏到这里。</p></div>}
        {state.highlights.map((mark) => <article key={mark.id} className="reading-note-entry">
          <div className="reading-note-meta">{source(mark.reference)}{touchesPage(mark.reference) && <span>本页</span>}</div>
          <blockquote className="reading-highlight-excerpt">{mark.reference.text}</blockquote>
          <div className="reading-note-entry-footer"><button type="button" className="inline-link" onClick={() => onNew(mark.reference)}><Pencil />写笔记</button><button type="button" className="icon-button" title="移除划线" aria-label="移除划线" onClick={() => reading.patch(book.id, (current) => ({ ...current, highlights: current.highlights.filter((item) => item.id !== mark.id) }))}><Trash2 /></button></div>
        </article>)}
      </div>
    </div>
  </>;
}
