import { ChevronDown, ChevronRight, FileText, Folder, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SessionFileEntry, SessionFileList } from '@multivac/contracts';
import { listSessionFiles } from '../../data/session-files-api.js';

function DirectoryBranch({ sessionId, root, path, query, selected, onSelect }: {
  sessionId: string; root: string; path: string; query: string; selected: string | null; onSelect: (entry: SessionFileEntry) => void;
}) {
  const [listing, setListing] = useState<SessionFileList | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
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
      onClick={() => entry.kind === 'file' ? onSelect(entry) : setExpanded((current) => current.includes(entry.path) ? current.filter((item) => item !== entry.path) : [...current, entry.path])}>
      {entry.kind === 'directory' ? <>{expanded.includes(entry.path) ? <ChevronDown /> : <ChevronRight />}<Folder /></> : <FileText />}
      <span>{entry.name}{query && <small>{entry.path}</small>}</span>
    </button>
    {entry.kind === 'directory' && expanded.includes(entry.path) && <DirectoryBranch sessionId={sessionId} root={root} path={entry.path} query="" selected={selected} onSelect={onSelect} />}
  </li>)}</ul>{!listing.entries.length && <p className="browser-empty">{query ? '没有匹配的文件' : '此目录为空'}</p>}{listing.limited && <p className="browser-empty">已达到浏览上限，请缩小搜索范围或展开子目录。</p>}</>;
}

export function FileBrowser({ sessionId, root, onClose }: { sessionId: string; root: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SessionFileEntry | null>(null);
  return <section className="file-browser" aria-label="工作目录文件浏览">
    <header className="browser-toolbar"><Folder /><strong title={root}>{root}</strong><button className="icon-button" aria-label="关闭文件浏览" title="关闭文件浏览" onClick={onClose}><X /></button></header>
    <div className="browser-body">
      <aside className="browser-directory" aria-label="会话工作目录">
        <label className="browser-search"><Search /><input aria-label="目录文件名搜索" placeholder="搜索文件名" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="browser-directory-scroll"><DirectoryBranch sessionId={sessionId} root={root} path="" query={query} selected={selected?.path ?? null} onSelect={setSelected} /></div>
      </aside>
      <div className="browser-reader">{selected ? <div className="browser-file-info"><FileText /><h3>{selected.name}</h3><p>{root}/{selected.path}</p></div> : <p className="browser-empty">选择工作目录中的文件</p>}</div>
    </div>
  </section>;
}
