import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import { ArrowLeft, ArrowRight, ArrowDown, ChevronRight, ChevronDown, Columns2, FileText, Folder, Maximize2, MessageSquare, Search, TextSearch, X } from 'lucide-react';
import { discussionContent, contentReference, fileTree } from './discussion-content.js';

hljs.registerLanguage('typescript', typescript);

function FileResults({ files, onOpen, activeId }) {
  return <div className="browser-file-results">{files.length ? files.map((file) => <button key={file.id} aria-current={activeId === file.id ? 'true' : undefined} onClick={() => onOpen({ id: file.id })} title={file.path}><FileText /><span>{file.name}<small>{file.path}</small></span></button>) : <p className="browser-empty">没有匹配的文件</p>}</div>;
}

function DirectoryTree({ files, rootPath, reading, setReading, onOpen }) {
  const [search, setSearch] = useState('');
  const tree = useMemo(() => fileTree(files), [files]);
  const expanded = reading.expandedDirs || [];
  function renderNode(node) {
    const open = expanded.includes(node.path);
    return <li key={node.path}>{node.file ? <button className="browser-tree-file" aria-current={node.file.id === reading.id ? 'true' : undefined} title={node.path} onClick={() => onOpen({ id: node.file.id })}><FileText /><span>{node.name}</span></button> : <><button className="browser-tree-folder" aria-expanded={open} title={node.path} onClick={() => setReading({ ...reading, expandedDirs: open ? expanded.filter((path) => path !== node.path) : [...expanded, node.path] })}>{open ? <ChevronDown /> : <ChevronRight />}<Folder /><span>{node.name}</span></button>{open && <ul>{node.children.map(renderNode)}</ul>}</>}</li>;
  }
  return <aside className="browser-directory" aria-label="会话工作目录"><div className="browser-root"><Folder /><strong title={rootPath}>{rootPath}</strong><small>演示目录</small></div><div className="discussion-find"><Search /><input aria-label="目录文件名搜索" placeholder="搜索文件名" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="browser-directory-scroll">{search ? <FileResults files={files.filter((file) => file.name.toLowerCase().includes(search.toLowerCase()))} onOpen={onOpen} activeId={reading.id} /> : <ul className="browser-tree">{tree.map(renderNode)}</ul>}{!files.length && !search && <p className="browser-empty">此目录没有演示文件</p>}</div></aside>;
}

export function DiscussionViewer({ reading, setReading, files, rootPath, onOpen, expanded, onExpand, onReturn, onClose, onReturnToParallel, onPrevious, onForward, onSelection, onActivate, IconButton }) {
  const content = discussionContent(reading.id);
  const viewer = useRef(null);
  const frame = useRef(null);
  const findInput = useRef(null);
  const findTrigger = useRef(null);
  const report = useRef({ reading, setReading, onSelection });
  report.current = { reading, setReading, onSelection };
  const [query, setQuery] = useState(reading.query || '');
  const [findOpen, setFindOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState('');
  const [match, setMatch] = useState(0);
  const [matchCount, setMatchCount] = useState(null);
  // 高亮 HTML 的 props 保持同一引用，焦点上报重渲染时不重建文字节点，避免清空浏览器选区。
  const highlighted = useMemo(() => content?.type === 'TypeScript' ? content.text.split('\n').map((line) => ({ __html: hljs.highlight(line || ' ', { language: 'typescript' }).value })) : [], [content]);
  const html = useMemo(() => content?.type === 'HTML' ? content.text.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; script-src &apos;none&apos;; form-action &apos;none&apos;; base-uri &apos;none&apos;">') : '', [content]);
  const chooser = !content || reading.chooser;
  const sourcePath = content ? `${rootPath.replace(/\/$/u, '')}/${content.path}` : rootPath;

  useEffect(() => { setFindOpen(false); }, [reading.id]);
  useEffect(() => { if (findOpen && !chooser) findInput.current?.focus(); }, [findOpen, chooser]);

  function closeFind() {
    setFindOpen(false);
    findTrigger.current?.focus();
  }

  function capture(root, win = window, offset = { left: 0, top: 0 }) {
    const selected = win.getSelection();
    if (!selected?.rangeCount || !selected.toString().trim()) return;
    const range = selected.getRangeAt(0);
    if (!root?.contains(range.commonAncestorContainer)) return;
    const start = range.startContainer.parentElement?.closest('[data-line]');
    const end = range.endContainer.parentElement?.closest('[data-line]');
    const heading = [...root.querySelectorAll('h2')].filter((h) => h.compareDocumentPosition(range.startContainer) & 4).at(-1)?.textContent;
    const location = start ? `${start.dataset.line}${end && end !== start ? `–${end.dataset.line}` : ''}` : range.startContainer.parentElement?.closest('footer') ? '页面结论' : heading || (content.type === 'HTML' ? '页面' : reading.section || '全文');
    const rect = range.getBoundingClientRect();
    const text = selected.toString().trim();
    report.current.onSelection({ text, reference: contentReference({ ...content, path: sourcePath }, location, text), location, title: content.name, path: sourcePath,
      left: Math.max(12, Math.min(rect.left + offset.left, window.innerWidth - 350)), top: Math.max(12, Math.min(rect.bottom + offset.top + 8, window.innerHeight - 60)), clear: () => selected.removeAllRanges() });
  }

  useEffect(() => {
    setQuery(reading.query || ''); setMatch(0); setMatchCount(null);
    const el = viewer.current;
    const timer = requestAnimationFrame(() => {
      const target = reading.line ? el?.querySelector(`[data-line="${reading.line}"]`) : [...(el?.querySelectorAll('[data-section]') || [])].find((h) => h.dataset.section === reading.section);
      if (el) { el.scrollTop = reading.positioned ? reading.scrollTop || 0 : target ? Math.max(0, target.offsetTop - 28) : 0; el.scrollLeft = reading.scrollLeft || 0; }
    });
    return () => cancelAnimationFrame(timer);
  }, [reading.id, reading.jump, chooser]);

  function frameReady() {
    // 允许父页面读取选区，但 sandbox 和 CSP 均禁止脚本、网络、表单及顶层导航。
    const doc = frame.current?.contentDocument;
    const win = frame.current?.contentWindow;
    if (!doc || !win) return;
    win.scrollTo(report.current.reading.scrollLeft || 0, report.current.reading.scrollTop || 0);
    doc.addEventListener('mouseup', () => capture(doc.body, win, frame.current.getBoundingClientRect()));
    win.addEventListener('scroll', () => report.current.setReading({ ...report.current.reading, scrollTop: win.scrollY, scrollLeft: win.scrollX, positioned: true }));
  }

  function findNext() {
    const root = content.type === 'HTML' ? frame.current?.contentDocument?.body : viewer.current;
    if (!root) return;
    root.querySelectorAll('.content-find-match').forEach((el) => { el.classList.remove('content-find-match'); if (content.type === 'HTML') el.style.background = ''; });
    const nodes = [...root.querySelectorAll(content.type === 'TypeScript' ? '.content-line' : content.type === '纯文本' ? '.content-text-line' : 'p, h1, h2, footer')].filter((el) => query.trim() && el.textContent.toLowerCase().includes(query.toLowerCase()));
    setMatchCount(nodes.length);
    if (!nodes.length) return;
    const index = match % nodes.length;
    nodes[index].classList.add('content-find-match');
    if (content.type === 'HTML') nodes[index].style.background = '#fff1c2';
    nodes[index].scrollIntoView({ block: 'center', inline: 'nearest' });
    setMatch(index + 1);
  }

  return <section className="discussion-viewer" aria-label={content ? `原文：${content.name}` : '内容浏览区'} onMouseDown={onActivate}>
    <header className="conversation-header"><div className="conversation-title"><FileText /><div><h2>{content?.name || '查看文件'}</h2><span className="object-meta">{content ? `${content.type} · 演示材料` : '会话工作目录'}</span></div></div><div className="conversation-tools"><IconButton label="目录" aria-expanded={Boolean(reading.directoryOpen)} onClick={() => setReading({ ...reading, directoryOpen: !reading.directoryOpen })}><Folder /></IconButton><IconButton label="搜索文件与最近查看" disabled={!content} aria-pressed={chooser} onClick={() => { setFileSearch(''); setReading({ ...reading, chooser: !reading.chooser }); }}><Search /></IconButton><IconButton ref={findTrigger} label="查找原文" disabled={!content || chooser} aria-expanded={findOpen && !chooser} onClick={() => setFindOpen((open) => !open)}><TextSearch /></IconButton><IconButton label="返回上一处阅读位置" disabled={!reading.history?.length} onClick={onPrevious}><ArrowLeft /></IconButton><IconButton label="前进到下一处阅读位置" disabled={!reading.future?.length} onClick={onForward}><ArrowRight /></IconButton>{expanded ? <IconButton label="回到当前会话" onClick={onReturn}><MessageSquare /></IconButton> : <IconButton label="放大原文" onClick={onExpand}><Maximize2 /></IconButton>}{expanded && <IconButton label="返回平行视图" onClick={onReturnToParallel}><Columns2 /></IconButton>}<IconButton label="关闭原文，留在聚焦会话" onClick={onClose}><X /></IconButton></div></header>
    <div className="discussion-source" title={sourcePath}>{sourcePath}</div>
    <div className="browser-body">
    {reading.directoryOpen && <DirectoryTree files={files} rootPath={rootPath} reading={reading} setReading={setReading} onOpen={onOpen} />}
    <div className="browser-reader">
    {chooser ? <div className="browser-chooser"><div className="discussion-find"><Search /><input autoFocus aria-label="搜索工作目录文件" placeholder="搜索文件名" value={fileSearch} onChange={(e) => setFileSearch(e.target.value)} />{content && <IconButton label="返回当前文件" onClick={() => setReading({ ...reading, chooser: false })}><X /></IconButton>}</div>{!fileSearch && reading.recent?.length > 0 && <><h3>最近查看</h3><FileResults files={reading.recent.map(discussionContent).filter((file) => files.includes(file))} onOpen={onOpen} activeId={reading.id} /></>}<h3>{fileSearch ? '搜索结果' : '工作目录文件'}</h3><FileResults files={files.filter((file) => file.name.toLowerCase().includes(fileSearch.toLowerCase()))} onOpen={onOpen} activeId={reading.id} /></div> : <>
    {findOpen && <div className="discussion-find content-find-bar"><TextSearch /><input ref={findInput} aria-label="原文内查找" placeholder="查找原文" value={query} onChange={(e) => { setQuery(e.target.value); setReading({ ...reading, query: e.target.value }); setMatch(0); setMatchCount(null); }} onKeyDown={(e) => { if (e.key === 'Enter') findNext(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); } }} /><span>{query && matchCount !== null && `${matchCount ? `${match}/${matchCount}` : '0 处'}`}</span><IconButton label="查找下一个" disabled={!query.trim()} onClick={findNext}><ArrowDown /></IconButton><IconButton label="收起原文查找" onClick={closeFind}><X /></IconButton></div>}
    {content.type === 'HTML' ? <iframe ref={frame} title={`预览 ${content.name}`} className="discussion-html" sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={html} onLoad={frameReady} /> : <article ref={viewer} className="discussion-content" onMouseUp={() => capture(viewer.current)} onScroll={(e) => setReading({ ...reading, scrollTop: e.currentTarget.scrollTop, scrollLeft: e.currentTarget.scrollLeft, positioned: true })}>
      {content.type === 'TypeScript' ? <div className="discussion-code">{content.text.split('\n').map((line, i) => <div key={i} data-line={i + 1} className={`content-line ${reading.line === i + 1 ? 'content-target' : ''}`}><span className="content-line-number" aria-hidden="true">{i + 1}</span><code dangerouslySetInnerHTML={highlighted[i]} /></div>)}</div> : content.type === '纯文本' ? <pre className="discussion-plain">{content.text.split('\n').map((line, index) => <span key={index} className="content-text-line" data-line={index + 1}>{line || ' '}</span>)}</pre> : <div className="discussion-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ h2: ({ children }) => <h2 data-section={String(children)} className={reading.section === String(children) ? 'content-target' : ''}>{children}</h2> }}>{content.text}</Markdown></div>}
    </article>}
    </>}
    </div>
    </div>
  </section>;
}
