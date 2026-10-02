import { useRef } from 'react';
import { ImagePlus, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { imageContentUrl } from '@multivac/contracts';
import type { useImageDraft } from './image-draft.js';
import { ImageGallery } from './image-gallery.js';

export function ImageInput({ draft, sessionId }: { draft: ReturnType<typeof useImageDraft>; sessionId: string }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="image-input">
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择图片文件" onChange={event => { draft.add(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
    <button type="button" className="icon-button" title="添加图片" aria-label="添加图片" onClick={() => input.current?.click()}><ImagePlus size={18} /></button>
    <div className="image-draft-list">{draft.items.map(item => {
      const src = item.preview ?? (item.image ? imageContentUrl(sessionId, item.image.id) : undefined);
      return <div className="image-draft-item" key={item.key}>
        {src && item.status !== 'error' ? <ImageGallery sources={[{ url: src, alt: item.name }]} /> : <span className="image-draft-preview" />}
        <button type="button" className="image-remove" aria-label={`移除 ${item.name}`} title="移除图片" onClick={() => draft.remove(item.key)}><X size={14} /></button>
        {item.status === 'uploading' && <span role="status"><LoaderCircle size={14} className="spin" />上传中</span>}
        {item.status === 'error' && <span role="alert">{item.error}{item.file && <button type="button" title="重试上传" aria-label="重试上传" onClick={() => draft.retry(item.key)}><RefreshCw size={14} /></button>}</span>}
      </div>;
    })}</div>
    {draft.error && <p className="send-error" role="alert">{draft.error}</p>}
  </div>;
}
