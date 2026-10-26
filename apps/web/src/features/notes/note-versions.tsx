import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, X } from 'lucide-react';
import type { Note, NoteVersionList } from '@multivac/contracts';
import { getNoteVersion, listNoteVersions } from '../../data/notes-api.js';
import { NoteRichText } from './note-rich-text.js';

const ignore = () => {};
function NoteVersionBody({ note, previewRoot }: { note: Note; previewRoot: HTMLElement | null }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  return <><NoteRichText noteId={note.id} body={note.body} disabled elementRef={element} previewRoot={previewRoot} onReady={ignore} onChange={ignore} onSelection={ignore} onError={error => setError(error.message)} />{error && <p role="alert">{error}</p>}</>;
}

export function NoteVersions({ current, knownRevision, blocked, onRestore, onClose }: {
  current: Note; knownRevision: number; blocked: string; onRestore(note: Note): Promise<boolean>; onClose(): void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const [page, setPage] = useState<NoteVersionList | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [version, setVersion] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [listError, setListError] = useState('');
  const [readError, setReadError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current!, trigger = document.activeElement;
    element.showModal();
    return () => {
      mounted.current = false; element.close();
      if (!element.isConnected && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setListError('');
    void listNoteVersions(current.id).then(result => {
      if (!active) return;
      setPage(result); setSelected(previous => previous ?? result.versions[0]?.revision ?? null);
    }).catch(error => { if (active) setListError((error as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [current.id, knownRevision, attempt]);
  useEffect(() => {
    if (selected === null) return;
    let active = true;
    setVersion(null); setReadError(''); setRestoreError('');
    void getNoteVersion(current.id, selected).then(note => { if (active) setVersion(note); })
      .catch(error => { if (active) setReadError((error as Error).message); });
    return () => { active = false; };
  }, [current.id, selected, attempt]);

  async function loadMore() {
    const before = page?.nextBefore;
    if (!before || more) return;
    setMore(true); setListError('');
    try {
      const result = await listNoteVersions(current.id, before);
      if (mounted.current) setPage(previous => previous?.nextBefore === before ? { ...result, versions: [...previous.versions, ...result.versions] } : previous);
    } catch (error) { if (mounted.current) setListError((error as Error).message); }
    finally { if (mounted.current) setMore(false); }
  }
  const reason = blocked || (page && page.latestRevision !== current.revision ? '笔记已有更新，请关闭历史并核对最新内容。' : '')
    || (version && version.revision === page?.latestRevision ? '正在查看当前版本。' : '')
    || (version && version.title === current.title && version.body === current.body ? '内容与当前版本一致。' : '');
  async function restore() {
    if (!version || reason || restoring || loading) return;
    setRestoring(true); setRestoreError('');
    try {
      if (await onRestore(version)) onClose();
      else if (mounted.current) setRestoreError('恢复尚未完成，请关闭历史并核对正文的保存状态。');
    } catch (error) { if (mounted.current) setRestoreError((error as Error).message); }
    finally { if (mounted.current) setRestoring(false); }
  }
  return createPortal(<dialog ref={dialog} className="note-versions-dialog" aria-modal="true" aria-labelledby={titleId}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!restoring) onClose(); }}>
    <header><div><h2 id={titleId}><History size={17} aria-hidden="true" />版本历史</h2><p>查看以前保存的标题与正文</p></div><button type="button" className="note-versions-close" aria-label="关闭版本历史" disabled={restoring} onClick={onClose}><X size={17} /></button></header>
    <div className="note-versions-content">
      <nav className="note-version-list" aria-label="笔记版本列表" aria-busy={loading}>
        {page?.versions.map(item => <button type="button" key={item.revision} aria-current={selected === item.revision ? 'true' : undefined} disabled={restoring} onClick={() => setSelected(item.revision)}>
          <strong>v{item.revision}{item.revision === page.latestRevision && <small>当前</small>}</strong><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString('zh-CN')}</time><span>{item.title || '未命名笔记'}</span>
        </button>)}
        {loading && <p role="status">正在读取版本…</p>}
        {page?.nextBefore && <button type="button" className="note-versions-more" disabled={more || loading || restoring} onClick={() => void loadMore()}>{more ? '正在读取…' : '更早版本'}</button>}
      </nav>
      <section className="note-version-preview" aria-label="历史版本内容" key={selected}>
        {version ? <><div className="note-version-heading"><span>v{version.revision}</span><time dateTime={version.updatedAt}>{new Date(version.updatedAt).toLocaleString('zh-CN')}</time></div><h3>{version.title || '未命名笔记'}</h3>{version.body ? <NoteVersionBody key={`${version.id}:${version.revision}`} note={version} previewRoot={dialog.current} /> : <p className="note-version-empty">此版本还没有正文。</p>}</> : !readError && <p role="status">正在读取内容…</p>}
      </section>
    </div>
    {(listError || readError || restoreError) && <div className="notes-error" role="alert">{listError || readError || restoreError}{!restoreError && <button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</button>}</div>}
    <footer><p>{reason || '恢复会创建新版本，已有版本仍保留。'}</p><button type="button" className="note-version-restore" disabled={!version || !!reason || restoring || loading} onClick={() => void restore()}>{restoring ? '正在恢复…' : '恢复此版本'}</button></footer>
  </dialog>, document.body);
}
