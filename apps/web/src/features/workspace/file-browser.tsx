import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Columns2, FileText, Folder, Maximize2, MessageSquare, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionFileEntry, SessionFileList } from '@multivac/contracts';
import { listSessionFiles } from '../../data/session-files-api.js';
import { FileReader } from './file-reader.js';
import { navigateReading, openReading, type ReadingScene } from './reading-scene.js';
import type { UpdateReading } from './use-reading-scene.js';

function DirectoryBranch({ sessionId, root, path, query, selected, onSelect, expanded, onToggle }: {
  sessionId: string; root: string; path: string; query: string; selected: string | null; onSelect: (entry: SessionFileEntry) => void;
  expanded: string[]; onToggle: (path: string) => void;
}) {
  const [listing, setListing] = useState<SessionFileList | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setListing(null); setError('');
    const timer = setTimeout(() => {
      void listSessionFiles(sessionId, path, query, root, abort.signal).then((value) => {
        if (!abort.signal.aborted) setListing(value);
      }).catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '目录读取失败。'); });
    }, query ? 200 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [sessionId, root, path, query, retry]);
  if (error) return <div className="browser-empty" role="alert">{error}<button className="icon-button" aria-label="重试目录读取" title="重试" onClick={() => setRetry(retry + 1)}><RefreshCw /></button></div>;
  if (!listing) return <p className="browser-empty" role="status">正在读取目录…</p>;
  return <><ul className="browser-tree">{listing.entries.map((entry) => <li key={entry.path}>
    <button type="button" title={`${root}/${entry.path}`} aria-current={selected === entry.path ? 'true' : undefined}
      {...(entry.kind === 'directory' ? { 'aria-expanded': expanded.includes(entry.path) } : {})}
      onClick={() => entry.kind === 'file' ? onSelect(entry) : onToggle(entry.path)}>
      {entry.kind === 'directory' ? <>{expanded.includes(entry.path) ? <ChevronDown /> : <ChevronRight />}<Folder /></> : <FileText />}
      <span>{entry.name}{query && <small>{entry.path}</small>}</span>
    </button>
    {entry.kind === 'directory' && expanded.includes(entry.path) && <DirectoryBranch sessionId={sessionId} root={root} path={entry.path} query="" selected={selected} onSelect={onSelect} expanded={expanded} onToggle={onToggle} />}
  </li>)}</ul>{!listing.entries.length && <p className="browser-empty">{query ? '没有匹配的文件' : '此目录为空'}</p>}{listing.limited && <p className="browser-empty">已达到浏览上限，请缩小搜索范围或展开子目录。</p>}</>;
}

export function FileBrowser({ sessionId, root, reading, setReading, visible, expanded, onExpand, onReturn, onClose }: {
  sessionId: string; root: string; expanded: boolean; onExpand: () => void; onReturn: () => void; onClose: () => void;
  reading: ReadingScene; setReading: UpdateReading; visible: boolean;
}) {
  const query = reading.search;
  const selected = reading.position.path;
  const directoryOpen = reading.directoryOpen;
  const setDirectoryOpen = (open: boolean) => setReading((scene) => ({ ...scene, directoryOpen: open }));
  const setQuery = (search: string) => setReading((scene) => ({ ...scene, search: search.slice(0, 200) }));
  const [wide, setWide] = useState(false);
  const browserRef = useRef<HTMLElement>(null);
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const previouslyWide = useRef<boolean | null>(null);
  useEffect(() => {
    if (!visible) return;
    if (previouslyWide.current === true && !wide && selected) setDirectoryOpen(false);
    previouslyWide.current = wide;
  }, [visible, wide, selected]);
  useLayoutEffect(() => {
    const browser = browserRef.current;
    if (!browser) return;
    const observer = new ResizeObserver(() => { if (browser.clientWidth) setWide(browser.clientWidth >= 620); });
    observer.observe(browser);
    return () => observer.disconnect();
  }, []);
  const onSelect = (entry: SessionFileEntry) => setReading((scene) => ({ ...openReading(scene, entry.path), directoryOpen: wide ? scene.directoryOpen : false }));
  const onToggle = (path: string) => setReading((scene) => ({ ...scene, expandedDirs: scene.expandedDirs.includes(path) ? scene.expandedDirs.filter((item) => item !== path) : [...scene.expandedDirs, path].slice(-200) }));
  const branch = <DirectoryBranch sessionId={sessionId} root={root} path="" query={query} selected={selected} onSelect={onSelect} expanded={reading.expandedDirs} onToggle={onToggle} />;
  return <section ref={browserRef} className="file-browser" aria-label="工作目录文件浏览" onKeyDown={(event) => {
    if (event.key === 'Escape' && directoryOpen && !wide) { event.stopPropagation(); setDirectoryOpen(false); directoryTrigger.current?.focus(); }
  }}>
    <header className="browser-toolbar"><button ref={directoryTrigger} className="icon-button" title="目录" aria-label="切换文件目录" aria-expanded={directoryOpen} onClick={() => setDirectoryOpen(!directoryOpen)}><Folder /></button><strong title={root}>{root}</strong>
      <button className="icon-button" aria-label="返回上一处阅读" title="返回上一处阅读" disabled={!reading.history.length} onClick={() => setReading((scene) => navigateReading(scene, 'previous'))}><ArrowLeft /></button>
      <button className="icon-button" aria-label="前进下一处阅读" title="前进下一处阅读" disabled={!reading.future.length} onClick={() => setReading((scene) => navigateReading(scene, 'forward'))}><ArrowRight /></button>
      <button className="icon-button" aria-label="选择工作目录文件" title="选择工作目录文件" onClick={() => setReading((scene) => ({ ...scene, chooser: true }))}><Search /></button>
      <button className="icon-button" aria-label={expanded ? '并排讨论与原文' : '放大原文'} title={expanded ? '并排讨论与原文' : '放大原文'} onClick={onExpand}>{expanded ? <Columns2 /> : <Maximize2 />}</button>
      <button className="icon-button" aria-label="回到当前讨论" title="回到当前讨论" onClick={onReturn}><MessageSquare /></button>
      <button className="icon-button" aria-label="关闭文件浏览" title="关闭文件浏览" onClick={onClose}><X /></button></header>
    {reading.notice && <p className="browser-empty" role="status">{reading.notice}</p>}
    <div className="browser-body">
      <aside className={`browser-directory ${wide ? '' : 'overlay'}`} aria-label="会话工作目录" hidden={!directoryOpen || reading.chooser || !selected}>
        <label className="browser-search"><Search /><input aria-label="目录文件名搜索" placeholder="搜索文件名" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (query) setQuery(''); else { setDirectoryOpen(false); directoryTrigger.current?.focus(); } } }} /></label>
        <div className="browser-directory-scroll">{branch}</div>
      </aside>
      <div className="browser-reader">{reading.chooser || !selected ? <div className="browser-chooser">
        <label className="browser-search"><Search /><input aria-label="搜索工作目录文件" placeholder="搜索文件名" value={query} onChange={(event) => setQuery(event.target.value)} />{selected && <button className="icon-button" aria-label="返回当前文件" title="返回当前文件" onClick={() => setReading((scene) => ({ ...scene, chooser: false }))}><X /></button>}</label>
        {!query && reading.recent.length > 0 && <><h3>最近查看</h3><ul className="browser-tree">{reading.recent.map((path) => <li key={path}><button title={`${root}/${path}`} onClick={() => onSelect({ kind: 'file', path, name: path.split('/').at(-1)! })}><FileText /><span>{path}</span></button></li>)}</ul></>}
        <h3>{query ? '搜索结果' : '工作目录文件'}</h3>{branch}
      </div> : <FileReader key={`${selected}:${reading.history.length}:${reading.future.length}`} sessionId={sessionId} root={root} path={selected} position={reading.position} visible={visible}
        onPosition={(change) => setReading((scene) => scene.position.path === selected ? { ...scene, position: { ...scene.position, ...change } } : scene)} />}</div>
    </div>
  </section>;
}
