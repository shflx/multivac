import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { IMAGE_ACCEPT, acceptImages, draftImageOf, sentImages } from './image-draft.js';
import { ImageGallery } from './image-gallery.jsx';

// 原型模拟上传耗时；文件名含 “fail” 的图片首次上传失败，用来体验重试。
const UPLOAD_DELAY = 700;

/** 输入框的图片草稿：选择、粘贴或拖入后模拟上传，可移除、重试；发送时取走已上传的图片。 */
export function useImageDraft() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const timers = useRef(new Map());
  const attempts = useRef(new Map());
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  function upload(key, name) {
    const attempt = (attempts.current.get(key) || 0) + 1;
    attempts.current.set(key, attempt);
    setItems((current) => current.map((item) => item.key === key ? { ...item, status: 'uploading', error: '' } : item));
    timers.current.set(key, window.setTimeout(() => {
      timers.current.delete(key);
      const failed = /fail/iu.test(name) && attempt === 1;
      setItems((current) => current.map((item) => item.key === key ? { ...item, status: failed ? 'error' : 'ready', error: failed ? '上传失败，请重试。' : '' } : item));
    }, UPLOAD_DELAY));
  }

  function add(files) {
    const images = files.filter((file) => IMAGE_ACCEPT.split(',').includes(file.type));
    const result = acceptImages(items, images);
    setError(images.length < files.length ? '仅支持 PNG、JPEG、WebP 或 GIF 图片。' : result.error);
    const added = result.accepted.map((file) => draftImageOf(file, crypto.randomUUID(), URL.createObjectURL(file)));
    setItems((current) => [...current, ...added]);
    added.forEach((item) => upload(item.key, item.name));
  }

  function remove(key) {
    const item = items.find((value) => value.key === key);
    window.clearTimeout(timers.current.get(key));
    if (item?.preview) URL.revokeObjectURL(item.preview);
    setItems((current) => current.filter((value) => value.key !== key));
    setError('');
  }

  /** 发送后清空草稿；图片地址交给消息继续使用，不在这里释放。 */
  function take() {
    const images = sentImages(items);
    setItems([]);
    setError('');
    return images;
  }

  return { items, error, add, remove, retry: (key) => upload(key, items.find((item) => item.key === key)?.name || ''), take };
}

/** 图片入口留在输入区底栏，点击加号直接打开系统文件选择框。 */
export function ImageInputButton({ draft }) {
  const input = useRef(null);
  return <>
    <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple hidden aria-label="选择图片文件" onChange={(event) => { draft.add([...(event.currentTarget.files || [])]); event.currentTarget.value = ''; }} />
    <button type="button" className="icon-button composer-image-add" title="添加图片" aria-label="添加图片" onClick={() => input.current?.click()}><Plus /></button>
  </>;
}

/** 只有附件或错误时才显示预览区，空草稿不占输入框上方的位置。 */
export function ImageDraftPreview({ draft }) {
  if (!draft.items.length && !draft.error) return null;
  return <div className="image-input">
    {!!draft.items.length && <div className="image-draft-list">{draft.items.map((item) => <div className="image-draft-item" key={item.key}>
      {item.status !== 'error' ? <ImageGallery sources={[{ url: item.preview, alt: item.name }]} /> : <span className="image-draft-preview" />}
      <button type="button" className="image-remove" aria-label={`移除 ${item.name}`} title="移除图片" onClick={() => draft.remove(item.key)}><X /></button>
      {item.status === 'uploading' && <span className="image-draft-status" role="status"><LoaderCircle className="status-spinner" />上传中</span>}
      {item.status === 'error' && <span className="image-draft-status error" role="alert">{item.error}<button type="button" title="重试上传" aria-label="重试上传" onClick={() => draft.retry(item.key)}><RefreshCw /></button></span>}
    </div>)}</div>}
    {draft.error && <p className="image-draft-error" role="alert">{draft.error}</p>}
  </div>;
}

/** 粘贴与拖入图片：交给输入区外层，文字粘贴不受影响。 */
export function imageTransferHandlers(draft) {
  const filesOf = (transfer) => [...(transfer?.files || [])].filter((file) => file.type.startsWith('image/'));
  return {
    onPaste: (event) => { const files = filesOf(event.clipboardData); if (files.length) { event.preventDefault(); draft.add(files); } },
    onDragOver: (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); },
    onDrop: (event) => { const files = filesOf(event.dataTransfer); if (files.length) { event.preventDefault(); draft.add(files); } },
  };
}
