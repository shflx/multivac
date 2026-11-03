import { useEffect, useRef, useState } from 'react';
import { Check } from 'typebox/value';
import { GLOBAL_ASSISTANT_SESSION_ID, TASK_ATTACHMENT_LIMITS as LIMITS, TaskAttachmentSchema, type TaskAttachment } from '@multivac/contracts';

export interface DraftFile { id: string; name: string; bytes: number; file?: File; attachment?: TaskAttachment; status: 'uploading' | 'ready' | 'error'; error?: string | undefined }
interface FileDraftState { draftId: string; items: DraftFile[] }
export const sessionAttachmentBase = (sessionId: string, draftId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/attachment-drafts/${encodeURIComponent(draftId)}/attachments`;
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? '附件操作失败，请重试。');
  return result;
}

/** 与会话控制器共用一份草稿；浏览器只存身份及清单，不存文件正文。 */
export function useFileDraft(sessionId: string, changed: () => void) {
  const enabled = sessionId === GLOBAL_ASSISTANT_SESSION_ID;
  const key = `multivac.file-draft:${sessionId}`;
  const [state, setState] = useState<FileDraftState>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (enabled && /^[a-f0-9-]{36}$/.test(stored?.draftId) && Array.isArray(stored.items)) return { draftId: stored.draftId, items: stored.items.filter((item: DraftFile) => /^[a-f0-9-]{36}$/.test(item.id) && typeof item.name === 'string' && Number.isSafeInteger(item.bytes)).slice(0, LIMITS.count).map((item: DraftFile) => ({ id: item.id, name: item.name, bytes: item.bytes, ...(item.attachment && Check(TaskAttachmentSchema, item.attachment) ? { attachment: item.attachment, status: 'ready' } : { status: 'error', error: '上传未完成，请移除后重新选择文件。' }) })) };
    } catch { /* 损坏草稿不构造文件或读取本地路径。 */ }
    return { draftId: crypto.randomUUID(), items: [] };
  });
  const current = useRef(state), alive = useRef(true);
  const [error, setError] = useState('');
  function update(next: FileDraftState) {
    current.current = next; setState(next);
    try { localStorage.setItem(key, JSON.stringify({ draftId: next.draftId, items: next.items.map(({ id, name, bytes, attachment }) => ({ id, name, bytes, attachment })) })); }
    catch { setError('附件草稿无法保存到浏览器，刷新前请完成发送。'); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!enabled || !current.current.items.length) return;
    const draftId = current.current.draftId;
    void request(sessionAttachmentBase(sessionId, draftId)).then(result => {
      if (!alive.current || current.current.draftId !== draftId) return;
      const stored = result.attachments as TaskAttachment[];
      update({ ...current.current, items: current.current.items.map(item => {
        const attachment = stored.find(value => value.id === item.id);
        return attachment ? { ...item, attachment, status: 'ready', error: undefined } : { ...item, status: 'error', error: '文件未上传完成，请移除后重新选择。' };
      }) });
    }).catch(cause => {
      if (alive.current && current.current.draftId === draftId) update({ ...current.current, items: current.current.items.map(item => ({ ...item, status: 'error', error: (cause as Error).message })) });
    });
  }, [sessionId]);
  async function upload(item: DraftFile, draftId: string) {
    if (!item.file) return;
    const active = () => alive.current && current.current.draftId === draftId && current.current.items.some(value => value.id === item.id);
    update({ ...current.current, items: current.current.items.map(value => value.id === item.id ? { ...value, status: 'uploading', error: undefined } : value) });
    try {
      const attachment = await request(`${sessionAttachmentBase(sessionId, draftId)}/${item.id}?name=${encodeURIComponent(item.name)}`, { method: 'PUT', body: item.file });
      if (active()) update({ ...current.current, items: current.current.items.map(value => value.id === item.id ? { ...value, attachment, status: 'ready' } : value) });
    } catch (cause) {
      if (active()) update({ ...current.current, items: current.current.items.map(value => value.id === item.id ? { ...value, status: 'error', error: (cause as Error).message } : value) });
    }
  }
  function add(files: File[]) {
    if (!enabled) return;
    setError('');
    if (files.some(file => !file.size || file.size > LIMITS.bytes)) { setError('文件不能为空，单文件上限 10 MiB。'); return; }
    if (current.current.items.length + files.length > LIMITS.count || [...current.current.items, ...files.map(file => ({ bytes: file.size }))].reduce((sum, item) => sum + item.bytes, 0) > LIMITS.totalBytes) { setError('最多 20 个文件，总大小不超过 50 MiB。'); return; }
    const draftId = current.current.draftId;
    const items: DraftFile[] = files.map(file => ({ id: crypto.randomUUID(), name: file.name, bytes: file.size, file, status: 'uploading' }));
    update({ draftId, items: [...current.current.items, ...items] }); changed();
    for (const item of items) void upload(item, draftId);
  }
  async function remove(id: string) {
    const draftId = current.current.draftId;
    if (current.current.items.some(item => item.id === id && item.status === 'uploading')) return;
    try {
      const response = await fetch(`${sessionAttachmentBase(sessionId, draftId)}/${id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) { const result = await response.json(); throw new Error(result.error?.message ?? '移除失败'); }
      if (alive.current && current.current.draftId === draftId) { update({ ...current.current, items: current.current.items.filter(item => item.id !== id) }); setError(''); changed(); }
    } catch (cause) { if (alive.current) setError((cause as Error).message); }
  }
  function clear(draftId?: string) {
    if (draftId && current.current.draftId === draftId) { update({ draftId: crypto.randomUUID(), items: [] }); setError(''); }
  }
  async function restore(draftId?: string, isCurrent: () => boolean = () => true) {
    if (!enabled || !draftId || current.current.items.length && current.current.draftId !== draftId) return;
    try {
      const result = await request(sessionAttachmentBase(sessionId, draftId));
      if (alive.current && isCurrent()) update({ draftId, items: result.attachments.map((attachment: TaskAttachment) => ({ id: attachment.id, name: attachment.name, bytes: attachment.bytes, attachment, status: 'ready' })) });
    } catch (cause) { if (alive.current && isCurrent()) setError(`附件无法恢复：${(cause as Error).message}`); }
  }
  return { items: state.items, error, add, remove, clear, restore,
    retry: (id: string) => { const item = current.current.items.find(item => item.id === id); if (item) void upload(item, current.current.draftId); },
    id: () => current.current.items.length ? current.current.draftId : undefined,
    ready: state.items.every(item => item.status === 'ready'),
  };
}
