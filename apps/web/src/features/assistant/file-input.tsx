import { ObjectLink } from './object-links.js';
import { useState } from 'react';
import type { MessageAttachments } from '@multivac/contracts';
import { TaskAttachmentPreview } from '../tasks/task-attachment-preview.js';
import { sessionAttachmentBase, type useFileDraft } from './file-draft.js';
import './file-input.css';

export function FileDraftPreview({ draft, disabled }: { draft: ReturnType<typeof useFileDraft>; disabled: boolean }) {
  if (!draft.items.length && !draft.error) return null;
  return <div className="conversation-files" aria-label="待发送文件">
    {draft.items.map(item => <div className="task-attachment-row" key={item.id}>
      <span>{item.name} · {item.bytes.toLocaleString()} 字节 · {item.status === 'uploading' ? '上传中…' : item.status === 'ready' ? '已上传' : '上传失败'}</span>
      {item.error && <span role="alert">{item.error}</span>}
      {item.status === 'error' && item.file && <button type="button" className="inline-link" disabled={disabled} onClick={() => draft.retry(item.id)}>重试上传</button>}
      <button type="button" className="inline-link" disabled={disabled || item.status === 'uploading'} onClick={() => void draft.remove(item.id)} aria-label={`移除附件 ${item.name}`}>移除</button>
    </div>)}
    {draft.error && <p role="alert">{draft.error}</p>}
  </div>;
}

export function MessageFiles({ files, sessionId }: { files: MessageAttachments; sessionId: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const base = sessionAttachmentBase(sessionId, files.draftId);
  return <div className="conversation-files" aria-label="消息附件">
    <small>{files.expired ? '已过期清理' : files.taskId ? '已附到任务' : '未使用'}</small>
    {files.attachments.map(item => <div className="task-attachment-row" key={item.id}>
      <span>{item.name} · {item.bytes.toLocaleString()} 字节</span>
      {!files.expired && <>
        {item.capability !== 'download' && <button type="button" className="inline-link" onClick={() => setPreview(preview === item.id ? null : item.id)}>{preview === item.id ? '收起预览' : '读取'}</button>}
        <a className="inline-link" href={`${base}/${item.id}/content`} download={item.name}>下载</a>
      </>}
      {preview === item.id && !files.expired && <TaskAttachmentPreview attachment={item} url={`${base}/${item.id}/content`} />}
    </div>)}
    {files.taskId && <small>任务：<ObjectLink target={{ kind: 'task', id: files.taskId }}>查看任务</ObjectLink></small>}
  </div>;
}
