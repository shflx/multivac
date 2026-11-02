import { useEffect, useState } from 'react';
import type { TaskAttachment } from '@multivac/contracts';

/** 预览只渲染受控纯文本或已校验图片；不执行附件 HTML 或自动加载外链。 */
export function TaskAttachmentPreview({ attachment, url }: { attachment: TaskAttachment; url: string }) {
  const [text, setText] = useState('');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = '';
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) { const result = await response.json(); throw new Error(result.error?.message ?? '预览读取失败'); }
        if (attachment.capability === 'image') {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob); setImage(objectUrl);
        } else {
          const body = await response.text();
          if (!controller.signal.aborted) setText(body.length > 40000 ? `${body.slice(0,40000)}\n\n（预览已截断为 40000 字，下载可获取完整原件。）` : body);
        }
      } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, attachment.capability]);
  return <div className="task-attachment-preview" aria-label={`预览：${attachment.name}`}>
    {loading && <p role="status">正在读取预览…</p>}{error && <p role="alert">{error}</p>}
    {image && <img src={image} alt={attachment.name} />}{!loading && !error && attachment.capability === 'text' && <pre>{text}</pre>}
  </div>;
}
