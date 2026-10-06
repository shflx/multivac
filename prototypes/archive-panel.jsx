import React, { useEffect, useState } from 'react';
import { Archive, ArrowRight, RefreshCw, Search, X } from 'lucide-react';
import { workingDirOf } from './ui-state.js';

/** 归档与会话页共用同一份会话元数据，恢复后保留回执和继续入口。 */
export function ArchivePanel({ active, sessions, projects, request, onOpen, onSelect, renderGrants }) {
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    if (!request) return;
    setQuery(''); setProjectId(request.projectId || 'all'); setSelectedId(null);
  }, [request]);
  const archived = sessions.list.filter((session) => session.archived);
  const shown = archived.filter((session) => (projectId === 'all' || (session.projectId || 'default') === projectId) && session.title.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
  const selected = shown.find((session) => session.id === selectedId) || shown[0];
  useEffect(() => { if (active) onSelect(selected || null); }, [active, selected?.id, selected?.title]);
  const nameOf = (session) => projects.find((project) => project.id === session.projectId)?.name || '默认工作区';
  function restore(open) {
    sessions.restore(selected.id);
    if (open) onOpen(selected);
    else setNotice({ session: selected, text: `已恢复「${selected.title}」，可以在原工作区继续。` });
  }
  return <div className="page-column archive-page">
    <header className="page-intro"><h1>归档</h1></header>
    <div className="toolbar"><label className="search-field"><Search /><input type="search" aria-label="按标题搜索归档" placeholder="按标题搜索" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="归档项目筛选" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="all">全部项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}<option value="default">不属于项目</option></select></div>
    {notice && <div className="archive-notice" role="status"><p>{notice.text}</p><button className="secondary" onClick={() => onOpen(notice.session)}>继续在工作区打开</button><button className="icon-button" aria-label="关闭恢复提示" onClick={() => setNotice(null)}><X /></button></div>}
    {!selected ? <div className="empty-state"><Archive /><h2>{archived.length ? '没有符合条件的归档' : '还没有归档会话'}</h2><p>{archived.length ? '换个关键词，或放宽项目筛选。' : '工作区中归档的会话会出现在这里，可以恢复到原工作区。'}</p></div> : <div className="master-detail sessions-layout">
      <section className="document-list" aria-label="归档会话列表">{shown.map((session) => <button key={session.id} className={selected.id === session.id ? 'selected' : ''} aria-current={selected.id === session.id ? 'true' : undefined} onClick={() => setSelectedId(session.id)}><Archive /><div><strong>{session.title}</strong><p>{nameOf(session)}</p><small>归档于 {session.archivedAt ? new Date(session.archivedAt).toLocaleString('zh-CN') : '时间未记录'}</small></div><ArrowRight /></button>)}</section>
      <section className="detail-panel session-detail" aria-label={`归档会话：${selected.title}`}><h2>{selected.title}</h2><p>{nameOf(selected)}</p><details><summary>工作目录</summary><code>{(selected.directory || workingDirOf({ sessionId: selected.id, project: projects.find((item) => item.id === selected.projectId) })).path}</code></details><div className="session-actions"><button className="secondary" onClick={() => restore(false)}><RefreshCw />恢复</button><button className="primary" onClick={() => restore(true)}>恢复并打开</button></div><details><summary>本会话已允许</summary>{renderGrants(selected)}</details></section>
    </div>}
  </div>;
}
