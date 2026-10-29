import { useEffect, useState } from 'react';
import { protectedNote, sessionNoteOwner } from '../../data/note-access.js';
import { loadNoteImageContent } from '../../data/note-image-content.js';

/** 普通图片沿用原 URL；笔记讨论图片以请求头授权，Blob 随呈现实例释放。 */
export function useImageContent(source: string, attempt: number) {
  const session = /^\/api\/sessions\/([^/]+)\/images\//u.exec(source);
  const owner = session && sessionNoteOwner(decodeURIComponent(session[1]!));
  const protectedImage = !!owner && protectedNote(owner);
  const [content, setContent] = useState<{ source: string; url?: string; error: boolean }>({ source, error: false });
  useEffect(() => {
    if (!protectedImage) return;
    const controller = new AbortController(); let blob: string | undefined;
    setContent({ source, error: false });
    void loadNoteImageContent(source, controller.signal).then(url => {
      if (controller.signal.aborted) URL.revokeObjectURL(url);
      else { blob = url; setContent({ source, url, error: false }); }
    }, () => { if (!controller.signal.aborted) setContent({ source, error: true }); });
    return () => { controller.abort(); if (blob) URL.revokeObjectURL(blob); };
  }, [source, attempt, protectedImage]);
  return protectedImage ? content.source === source ? content : { source, error: false } : { source, url: source, error: false };
}
