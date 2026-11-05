import { Download, Eye, EyeOff, File, FileText, Image, LoaderCircle, Paperclip, RotateCcw, Trash2, Upload as UploadIcon, X } from 'lucide-react';
import { TaskAttachmentPreview } from './task-attachment-preview.js';
import { TaskIconButton } from './task-icon-button.js';
import { formatBytes } from '../workspace/temp-retention.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useEffect, useRef, useState } from 'react';
import type { TaskAttachment } from '@multivac/contracts';

const capability = { text: '可读取文本', image: '可读取图片（需模型支持）', download: '仅保存与下载' };
const capabilityIcon = { text: FileText, image: Image, download: File };
const MAX_FILES = 20;
interface Upload { id: string; file: File; error: string; busy: boolean }
async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? '附件操作失败');
  return result;
}

/** 每个组件实例固定归属；上传重试沿用原身份，迟到回执不作用于其他任务。 */
export function TaskAttachments({ taskId, draftId, editable = false, disabled = false, onBlocked }: {
  taskId?: string; draftId?: string; editable?: boolean; disabled?: boolean; onBlocked?: (blocked: boolean) => void;
}) {
  const base = taskId ? `/api/tasks/${taskId}/attachments` : `/api/task-attachment-drafts/${draftId}/attachments`;
  const [items, setItems] = useState<TaskAttachment[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  async function refresh() {
    const current = ++generation.current;
    try {
      const result = await jsonRequest(base);
      if (alive.current && current === generation.current) { setItems(result.attachments); setError(''); }
    } catch (failure) { if (alive.current && current === generation.current) setError((failure as Error).message); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }
  useOptionalWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'task-attachments.changed' && event.taskId === taskId) void refresh(); });
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; ++generation.current; }; }, [base]);
  useEffect(() => { onBlocked?.(uploads.length > 0 || !!removing); }, [uploads, removing, onBlocked]);
  useEffect(() => () => onBlocked?.(false), [onBlocked]);
  async function upload(entry: Upload) {
    setUploads(values => values.map(value => value.id === entry.id ? { ...value, busy: true, error: '' } : value));
    try {
      await jsonRequest(`${base}/${entry.id}?name=${encodeURIComponent(entry.file.name)}`, { method: 'PUT', body: entry.file });
      if (alive.current) { setUploads(values => values.filter(value => value.id !== entry.id)); await refresh(); }
    } catch (failure) {
      if (alive.current) setUploads(values => values.map(value => value.id === entry.id ? { ...value, busy: false, error: (failure as Error).message } : value));
    }
  }
  async function remove(id: string) {
    setRemoving(id);
    try { await jsonRequest(`${base}/${id}`, { method: 'DELETE' }); await refresh(); }
    catch (failure) { if (alive.current) setError((failure as Error).message); }
    finally { if (alive.current) setRemoving(null); }
  }
  function add(files: FileList | File[]) {
    const entries = Array.from(files).map(file => ({ id: crypto.randomUUID(), file, busy: true, error: '' }));
    setUploads(values => [...values, ...entries]);
    for (const entry of entries) void upload(entry);
  }
  const blocked = disabled || !!removing;
  return <section aria-label="输入附件" className="task-input-attachments">
    <div className="task-attachments-heading"><h3>输入附件</h3>{(items.length > 0 || uploads.length > 0) && <span>{items.length} / {MAX_FILES}</span>}</div>
    <p className="task-attachments-hint">启动时固定本次版本，安全重做采用新版本。单文件 10 MiB，合计 50 MiB。</p>
    {loading && <p className="task-muted" role="status">正在读取附件…</p>}
    {!loading && !items.length && !uploads.length && !error && !editable && <p className="task-muted">暂无附件</p>}
    {(items.length > 0 || uploads.length > 0) && <ul className="task-attachment-list">
      {items.map(item => {
        const Icon = capabilityIcon[item.capability];
        const open = preview === item.id;
        return <li key={item.id} className="task-attachment-row">
          <div className="task-attachment-main">
            <span className={`task-attachment-icon ${item.capability}`}><Icon aria-hidden="true" /></span>
            <span className="task-attachment-copy"><strong title={item.name}>{item.name}</strong><small>{formatBytes(item.bytes)} · {capability[item.capability]}</small></span>
            <span className="task-attachment-actions">
              {item.capability !== 'download' && <TaskIconButton label={open ? '收起预览' : '预览'} aria-expanded={open} onClick={() => setPreview(open ? null : item.id)}>{open ? <EyeOff /> : <Eye />}</TaskIconButton>}
              <a className="icon-button" href={`${base}/${item.id}/content`} download={item.name} aria-label="下载" title="下载"><Download aria-hidden="true" /></a>
              {editable && <TaskIconButton label="移除" className="danger" disabled={blocked} onClick={() => void remove(item.id)}>{removing === item.id ? <LoaderCircle className="spin" /> : <Trash2 />}</TaskIconButton>}
            </span>
          </div>
          {open && <TaskAttachmentPreview key={item.id} attachment={item} url={`${base}/${item.id}/content`} />}
        </li>;
      })}
      {uploads.map(entry => <li key={entry.id} className={`task-attachment-row upload ${entry.error ? 'failed' : ''}`}>
        <div className="task-attachment-main">
          <span className="task-attachment-icon">{entry.busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <FileText aria-hidden="true" />}</span>
          <span className="task-attachment-copy"><strong title={entry.file.name}>{entry.file.name}</strong><small>{entry.busy ? `上传中 · ${formatBytes(entry.file.size)}` : entry.error}</small></span>
          {!entry.busy && <span className="task-attachment-actions">
            <TaskIconButton label="重试上传" disabled={disabled} onClick={() => void upload(entry)}><RotateCcw /></TaskIconButton>
            <TaskIconButton label="取消此上传" disabled={disabled} onClick={() => setUploads(values => values.filter(value => value.id !== entry.id))}><X /></TaskIconButton>
          </span>}
        </div>
      </li>)}
    </ul>}
    {/* 点击或拖放文件到此区域上传；原生文件输入保留在区域内，键盘与自动化仍可直接使用。 */}
    {editable && <label className={`task-attachment-drop ${dragging ? 'dragging' : ''} ${blocked ? 'disabled' : ''}`}
      onDragOver={event => { event.preventDefault(); if (!blocked) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!blocked && event.dataTransfer.files.length) add(event.dataTransfer.files); }}>
      <input className="sr-only" aria-label="添加任务附件" type="file" multiple disabled={blocked} onChange={event => { add(event.target.files ?? []); event.target.value = ''; }} />
      {dragging ? <UploadIcon aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
      <span><strong>{dragging ? '松开以上传' : '添加附件'}</strong><small>点击选择或拖放文件到这里</small></span>
    </label>}
    {error && <p className="task-attachments-error" role="alert">{error} <button type="button" className="inline-link" onClick={() => void refresh()}>重试附件列表</button></p>}
  </section>;
}
