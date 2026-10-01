import { ArrowDown, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import type { SessionFileContent } from '@multivac/contracts';
import { readSessionFile } from '../../data/session-files-api.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { fileLocationElement, findTextRanges, isolatedHtml } from './file-preview.js';

hljs.registerLanguage('typescript', typescript);

export function FileReader({ sessionId, root, path, target }: { sessionId: string; root: string; path: string; target?: { line?: number; section?: string } }) {
  const [content, setContent] = useState<SessionFileContent | null>(null);
  const [error, setError] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const [count, setCount] = useState(0);
  const [frameVersion, setFrameVersion] = useState(0);
  const article = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    setContent(null); setError(''); setQuery(''); setMatch(0); setFindOpen(false);
    void readSessionFile(sessionId, path, root, abort.signal).then((value) => { if (!abort.signal.aborted) setContent(value); })
      .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '文件读取失败。'); });
    return () => abort.abort();
  }, [sessionId, root, path]);
  const html = useMemo(() => content?.kind === 'html' ? isolatedHtml(content.text) : '', [content]);
  const lines = useMemo(() => content?.kind === 'typescript' ? hljs.highlight(content.text, { language: 'typescript' }).value.split('\n') : [], [content]);
  useEffect(() => { if (findOpen) input.current?.focus(); }, [findOpen]);
  useLayoutEffect(() => {
    const host = content?.kind === 'html' ? frame.current?.contentDocument?.body : article.current;
    if (host && target) fileLocationElement(host, target)?.scrollIntoView({ block: 'start' });
  }, [content, frameVersion, target]);
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
    if (current) current.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return () => { view.CSS.highlights.delete('file-matches'); view.CSS.highlights.delete('file-current'); };
  }, [query, match, findOpen, content, frameVersion]);
  const closeFind = () => { setFindOpen(false); trigger.current?.focus(); };
  return <div className="file-reader" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); event.stopPropagation(); setFindOpen(true); } }}>
    <header className="browser-toolbar"><strong title={`${root}/${path}`}>{path}</strong><button ref={trigger} className="icon-button" title="查找原文" aria-label="查找原文" disabled={!content} onClick={() => setFindOpen(true)}><Search /></button></header>
    {findOpen && <div className="browser-search content-find-bar"><Search /><input ref={input} aria-label="原文内查找" value={query} onChange={(event) => { setQuery(event.target.value); setMatch(0); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setMatch(match + 1); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); } }} /><span>{query ? `${count ? match % count + 1 : 0}/${count}${count === 5000 ? '+' : ''}` : ''}</span><button className="icon-button" title="查找下一个" aria-label="查找下一个" disabled={!count} onClick={() => setMatch(match + 1)}><ArrowDown /></button><button className="icon-button" title="收起原文查找" aria-label="收起原文查找" onClick={closeFind}><X /></button></div>}
    {error ? <p className="browser-empty" role="alert">{error}</p> : !content ? <p className="browser-empty" role="status">正在读取文件…</p> : content.kind === 'html' ?
      <iframe ref={frame} title={`预览 ${path}`} className="discussion-html" sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={html} onLoad={() => setFrameVersion((value) => value + 1)} /> :
      <article ref={article} className="discussion-content" tabIndex={0} aria-label={`预览 ${path}`}>
        {content.kind === 'markdown' ? <MarkdownBody text={content.text} identity={`file-${sessionId}-${path}`} sourceLines /> : <div className="discussion-code">{content.text.split('\n').map((line, index) => <div className="content-line" data-line={index + 1} key={index}><span className="content-line-number" aria-hidden="true">{index + 1}</span>{content.kind === 'typescript' ? <code dangerouslySetInnerHTML={{ __html: lines[index] ?? '' }} /> : <code>{line || ' '}</code>}</div>)}</div>}
      </article>}
  </div>;
}
