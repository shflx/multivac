import { TaskAttachmentPreview } from './task-attachment-preview.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useEffect, useRef, useState } from 'react';
import type { TaskAttachment } from '@multivac/contracts';

const capability = { text: '可读取 UTF-8 文本', image: '可读取图片（需模型支持）', download: '仅保存与下载，不能解析' };
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
  return <section aria-label="输入附件" className="task-input-attachments">
    <h3>输入附件</h3><p className="task-muted">参考材料独立保存。启动后固定本次版本；继续使用原版本，安全重做采用新版本。单文件 10 MiB，最多 20 个、合计 50 MiB。</p>
    {loading && <p role="status">正在读取附件…</p>}
    {!loading && !items.length && !uploads.length && !error && <p className="task-muted">暂无附件</p>}
    {items.map(item => <div key={item.id} className="task-attachment-row"><span>{item.name} · {item.bytes.toLocaleString()} 字节 · {capability[item.capability]}</span> {item.capability !== 'download' && <button type="button" className="inline-link" onClick={() => setPreview(preview === item.id ? null : item.id)}>{preview === item.id ? '收起预览' : '预览'}</button>}<a className="inline-link" href={`${base}/${item.id}/content`} download={item.name}>下载</a> {editable && <button type="button" className="inline-link" disabled={disabled || !!removing} onClick={() => void remove(item.id)}>移除</button>}{preview === item.id && <TaskAttachmentPreview key={item.id} attachment={item} url={`${base}/${item.id}/content`} />}</div>)}
    {uploads.map(entry => <div key={entry.id}><span>{entry.file.name} · {entry.busy ? '上传中…' : entry.error}</span>{!entry.busy && <><button type="button" className="inline-link" disabled={disabled} onClick={() => void upload(entry)}>重试上传</button><button type="button" className="inline-link" disabled={disabled} onClick={() => setUploads(values => values.filter(value => value.id !== entry.id))}>取消此上传</button></>}</div>)}
    {editable && <label className="task-create-field"><span>添加附件</span><input aria-label="添加任务附件" type="file" multiple disabled={disabled || !!removing} onChange={event => {
      const entries = Array.from(event.target.files ?? []).map(file => ({ id: crypto.randomUUID(), file, busy: true, error: '' }));
      setUploads(values => [...values, ...entries]);
      for (const entry of entries) void upload(entry);
      event.target.value = '';
    }} /></label>}
    {error && <p role="alert">{error} <button type="button" className="inline-link" onClick={() => void refresh()}>重试附件列表</button></p>}
  </section>;
}
