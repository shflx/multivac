import { useEffect, useRef, useState } from 'react';
import { newCommandId } from '../../data/command-id.js';
import { IMAGE_LIMITS, ImageAttachmentSchema, type ImageAttachment } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { Check } from 'typebox/value';

export interface DraftImage { key: string; name: string; image?: ImageAttachment | undefined; file?: File; preview?: string; status: 'uploading' | 'ready' | 'error'; error?: string | undefined }

export function useImageDraft(sessionId: string, changed: () => void) {
  const storageKey = `multivac.image-draft:${sessionId}`;
  const [items, setItems] = useState<DraftImage[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as DraftImage[];
      return stored.filter(item => typeof item.key === 'string' && typeof item.name === 'string').slice(0, IMAGE_LIMITS.count).map(item => {
        const image = item.image && Check(ImageAttachmentSchema, item.image) && item.image.sessionId === sessionId ? item.image : undefined;
        return { key: item.key, name: item.name, image, status: image ? 'ready' : 'error', error: image ? undefined : '上传未完成，请重新选择图片。' };
      });
    } catch { return []; }
  });
  const current = useRef(items);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const requests = useRef(new Map<string, AbortController>());
  function update(next: DraftImage[]) {
    current.current = next; setItems(next);
    localStorage.setItem(storageKey, JSON.stringify(next.map(({ key, name, image, status }) => ({ key, name, image, status }))));
  }
  useEffect(() => {
    alive.current = true;
    for (const item of current.current) if (item.image) {
      void fetchJson<ImageAttachment>(`/api/sessions/${encodeURIComponent(sessionId)}/images/${item.image.id}`, undefined, ImageAttachmentSchema).catch(() => {
        if (alive.current) update(current.current.map(value => value.key === item.key ? { ...value, status: 'error', error: '图片已失效，请移除后重新上传。' } : value));
      });
    }
    return () => { alive.current = false; for (const controller of requests.current.values()) controller.abort(); for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview); };
  }, [sessionId]);

  async function upload(item: DraftImage) {
    if (!item.file) return;
    const controller = new AbortController(); requests.current.set(item.key, controller);
    update(current.current.map(value => value.key === item.key ? { ...value, status: 'uploading', error: undefined } : value));
    try {
      const image = await fetchJson<ImageAttachment>(`/api/sessions/${encodeURIComponent(sessionId)}/images`, { method: 'POST', body: item.file, signal: controller.signal }, ImageAttachmentSchema);
      if (!alive.current || !current.current.some(value => value.key === item.key)) return;
      if (current.current.some(value => value.key !== item.key && value.image?.id === image.id)) {
        if (item.preview) URL.revokeObjectURL(item.preview);
        update(current.current.filter(value => value.key !== item.key)); return;
      }
      update(current.current.map(value => value.key === item.key ? { ...value, image, status: 'ready' } : value));
    } catch (cause) {
      if (alive.current && !controller.signal.aborted) update(current.current.map(value => value.key === item.key ? { ...value, status: 'error', error: cause instanceof Error ? cause.message : '上传失败，请重试。' } : value));
    } finally { requests.current.delete(item.key); }
  }
  function add(files: File[]) {
    setError('');
    if (current.current.length + files.length > IMAGE_LIMITS.count || files.reduce((sum, file) => sum + file.size, current.current.reduce((sum, item) => sum + (item.file?.size ?? item.image?.bytes ?? 0), 0)) > IMAGE_LIMITS.totalBytes) { setError('最多 4 张图片，总大小不超过 20 MiB。'); return; }
    for (const file of files) {
      if (file.size > IMAGE_LIMITS.bytes) { setError('单图上限为 10 MiB。'); continue; }
      const item: DraftImage = { key: newCommandId(), name: file.name || '剪贴板图片', file, preview: URL.createObjectURL(file), status: 'uploading' };
      update([...current.current, item]); changed(); void upload(item);
    }
  }
  function remove(key: string) {
    const item = current.current.find(value => value.key === key);
    requests.current.get(key)?.abort();
    if (item?.preview) URL.revokeObjectURL(item.preview);
    update(current.current.filter(value => value.key !== key)); changed(); setError('');
    if (item?.image) void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/images/${item.image.id}`, { method: 'DELETE' });
  }
  function clear(ids: readonly string[]) {
    for (const item of current.current) if (item.image && ids.includes(item.image.id) && item.preview) URL.revokeObjectURL(item.preview);
    update(current.current.filter(item => !item.image || !ids.includes(item.image.id)));
  }
  async function restore(ids: readonly string[], isCurrent: () => boolean = () => true) {
    for (const id of ids) {
      if (current.current.some(item => item.image?.id === id)) continue;
      try {
        const image = await fetchJson<ImageAttachment>(`/api/sessions/${encodeURIComponent(sessionId)}/images/${id}`, undefined, ImageAttachmentSchema);
        if (alive.current && isCurrent() && !current.current.some(item => item.image?.id === id)) update([...current.current, { key: id, name: '图片', image, status: 'ready' as const }].slice(0, IMAGE_LIMITS.count));
      } catch { setError('发送的图片无法恢复，请重新上传。'); }
    }
  }
  return { items, error, add, remove, retry: (key: string) => { const item = current.current.find(value => value.key === key); if (item) void upload(item); }, clear, restore, ids: () => current.current.flatMap(item => item.status === 'ready' && item.image ? [item.image.id] : []), ready: items.every(item => item.status === 'ready') };
}
