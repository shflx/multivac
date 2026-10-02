import { ArrowDown, Search, X } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SessionFileContent } from '@multivac/contracts';
import { readSessionFile } from '../../data/session-files-api.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { fileLocationElement, findTextRanges, isolatedHtml } from './file-preview.js';
import type { ReadingPosition } from './reading-scene.js';
import { captureFileSelection, type FileSelection } from './file-selection.js';
import { highlightFileLines } from './file-syntax.js';

export function FileReader({ sessionId, root, path, position, onPosition, visible, onSelection, onReadingFocus }: {
  sessionId: string; root: string; path: string; position: ReadingPosition; onPosition: (change: Partial<ReadingPosition>) => void; visible: boolean;
  onSelection: (selection: FileSelection | null) => void; onReadingFocus: () => void;
}) {
  const [content, setContent] = useState<SessionFileContent | null>(null);
  const [error, setError] = useState('');
  const findOpen = position.findOpen;
  const query = position.query;
  const setFindOpen = (findOpen: boolean) => onPosition({ findOpen });
  const setQuery = (query: string) => onPosition({ query: query.slice(0, 200) });
  const [match, setMatch] = useState(0);
  const [count, setCount] = useState(0);
  const [frameVersion, setFrameVersion] = useState(0);
  const article = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const report = useRef({ position, onPosition, visible, onSelection, onReadingFocus });
  report.current = { position, onPosition, visible, onSelection, onReadingFocus };
  const restored = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    setContent(null); setError(''); setMatch(0); restored.current = false;
    void readSessionFile(sessionId, path, root, abort.signal).then((value) => { if (!abort.signal.aborted) setContent(value); })
      .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '文件读取失败。'); });
    return () => abort.abort();
  }, [sessionId, root, path]);
  const html = useMemo(() => content?.kind === 'html' ? isolatedHtml(content.text) : '', [content]);
  const highlighted = useMemo(() => content && content.kind !== 'html' && content.kind !== 'markdown' ? highlightFileLines(content.path, content.text) : null, [content]);
  const textLines = useMemo(() => content?.text.split('\n') ?? [], [content]);
  const lineStyle = { '--reader-line-digits': Math.max(2, String(textLines.length).length) } as CSSProperties;
  const openFind = () => { setFindOpen(true); requestAnimationFrame(() => input.current?.focus()); };
  useLayoutEffect(() => {
    if (!visible) { restored.current = false; return; }
    const host = content?.kind === 'html' ? frame.current?.contentDocument?.body : article.current;
    if (!host || !visible || restored.current) return;
    const scroll = content?.kind === 'html' ? host.ownerDocument.scrollingElement : host;
    if (!scroll) return;
    if (position.positioned) { scroll.scrollTop = position.scrollTop; scroll.scrollLeft = position.scrollLeft; }
    else fileLocationElement(host, position)?.scrollIntoView({ block: 'start' });
    restored.current = true;
  }, [content, frameVersion, visible]);
  useEffect(() => {
    const host = content?.kind === 'html' ? frame.current?.contentDocument?.body : article.current;
    if (!host) return;
    const scroll = content?.kind === 'html' ? host.ownerDocument.scrollingElement : host;
    const target = content?.kind === 'html' ? host.ownerDocument : host;
    const save = () => { if (report.current.visible && restored.current && scroll) { report.current.onSelection(null); report.current.onPosition({ scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft, positioned: true }); } };
    target.addEventListener('scroll', save);
    return () => target.removeEventListener('scroll', save);
  }, [content, frameVersion]);
  useEffect(() => {
    const host = content?.kind === 'html' ? frame.current?.contentDocument?.body : article.current;
    if (!host) return;
    const document = host.ownerDocument;
    const capture = () => {
      if (!report.current.visible) return;
      const rect = content?.kind === 'html' ? frame.current?.getBoundingClientRect() : null;
      report.current.onSelection(captureFileSelection(host, { sessionId, root, path }, rect ? { left: rect.left, top: rect.top } : undefined));
    };
    const activate = () => report.current.onReadingFocus();
    const key = (event: KeyboardEvent) => {
      if (content?.kind === 'html' && (event.ctrlKey || event.metaKey) && event.key === 'f') { event.preventDefault(); openFind(); }
      if (event.key === 'Escape' && host.contains(document.getSelection()?.anchorNode ?? null)) { event.preventDefault(); event.stopPropagation(); document.getSelection()?.removeAllRanges(); report.current.onSelection(null); }
    };
    document.addEventListener('selectionchange', capture);
    host.addEventListener('pointerdown', activate);
    host.addEventListener('focusin', activate);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('selectionchange', capture); host.removeEventListener('pointerdown', activate); host.removeEventListener('focusin', activate); document.removeEventListener('keydown', key); };
  }, [content, frameVersion, sessionId, root, path]);
  const findChanged = useRef(false);
  useLayoutEffect(() => {
    const host = content?.kind === 'html' ? frame.current?.contentDocument?.body : article.current;
    if (!host) return;
    const ranges = findTextRanges(host, findOpen ? query : '');
    setCount(ranges.length);
    const current = ranges[match % (ranges.length || 1)];
    const view = host.ownerDocument.defaultView!;
    // CSS Highlight 保留原文本节点，查找不破坏 React 渲染、选区或引用快照。
    view.CSS.highlights.set('file-matches', new view.Highlight(...ranges));
    view.CSS.highlights.set('file-current', new view.Highlight(...(current ? [current] : [])));
    if (current && findChanged.current && visible) current.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
    findChanged.current = false;
    return () => { view.CSS.highlights.delete('file-matches'); view.CSS.highlights.delete('file-current'); };
  }, [query, match, findOpen, content, frameVersion, visible]);
  const closeFind = () => { setFindOpen(false); trigger.current?.focus(); };
  return <div className="file-reader" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); event.stopPropagation(); openFind(); } }}>
    <header className="browser-toolbar"><strong title={`${root}/${path}`}>{path}</strong><button ref={trigger} className="icon-button" title="查找原文" aria-label="查找原文" disabled={!content} onClick={openFind}><Search /></button></header>
    {findOpen && <div className="browser-search content-find-bar"><Search /><input ref={input} aria-label="原文内查找" value={query} onChange={(event) => { findChanged.current = true; setQuery(event.target.value); setMatch(0); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); findChanged.current = true; setMatch(match + 1); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); } }} /><span>{query ? `${count ? match % count + 1 : 0}/${count}${count === 5000 ? '+' : ''}` : ''}</span><button className="icon-button" title="查找下一个" aria-label="查找下一个" disabled={!count} onClick={() => { findChanged.current = true; setMatch(match + 1); }}><ArrowDown /></button><button className="icon-button" title="收起原文查找" aria-label="收起原文查找" onClick={closeFind}><X /></button></div>}
    {error ? <p className="browser-empty" role="alert">{error}</p> : !content ? <p className="browser-empty" role="status">正在读取文件…</p> : content.kind === 'html' ?
      <iframe ref={frame} title={`预览 ${path}`} className="discussion-html" sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={html} onLoad={() => setFrameVersion((value) => value + 1)} /> :
      <article ref={article} className={`discussion-content${content.kind === 'markdown' ? '' : ' code-content'}`} tabIndex={0} aria-label={`预览 ${path}`}>
        {content.kind === 'markdown' ? <MarkdownBody text={content.text} identity={`file-${sessionId}-${path}`} sourceLines /> : (
          <div className="discussion-code" style={lineStyle}>
            {textLines.map((line, index) => (
              <div className="content-line" data-line={index + 1} key={index}>
                <span className="content-line-number" aria-hidden="true">{index + 1}</span>
                <code>{highlighted ? highlighted[index]?.map((part, partIndex) => (
                  <Fragment key={partIndex}>
                    {part.scopes.reduceRight<ReactNode>((child, className, scopeIndex) => (
                      <span className={className} key={scopeIndex}>{child}</span>
                    ), part.text)}
                  </Fragment>
                )) : line || ' '}</code>
              </div>
            ))}
          </div>
        )}
      </article>}
  </div>;
}
