import { ObjectLink } from './object-links.js';
import { useState } from 'react';
import { CircleAlert, Download, Eye, EyeOff, File, FileText, Image, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { MessageAttachments } from '@multivac/contracts';
import { TaskAttachmentPreview } from '../tasks/task-attachment-preview.js';
import { sessionAttachmentBase, type useFileDraft } from './file-draft.js';
import { formatBytes } from '../workspace/temp-retention.js';
import './file-input.css';

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
const KIND_ICON = { text: FileText, image: Image, download: File };

/** 卡片图标：上传前按扩展名猜测，上传后以服务端判定的读取能力为准。 */
function kindOf(name: string, capability?: keyof typeof KIND_ICON): keyof typeof KIND_ICON {
  return capability ?? (IMAGE_NAME.test(name) ? 'image' : 'text');
}

/** 待发送文件：输入框上方一排文件卡片，上传中、失败与移除都在卡片内处理。 */
export function FileDraftPreview({ draft, disabled }: { draft: ReturnType<typeof useFileDraft>; disabled: boolean }) {
  if (!draft.items.length && !draft.error) return null;
  const uploading = draft.items.some(item => item.status === 'uploading');
  return <div className="conversation-files conversation-file-draft" aria-label="待发送文件">
    <div className="conversation-file-list">
      {draft.items.map(item => {
        const kind = kindOf(item.name, item.attachment?.capability);
        const Icon = KIND_ICON[kind];
        return <div className={`conversation-file task-attachment-row ${item.status}`} key={item.id}>
          <span className={`conversation-file-icon ${kind}`}>{item.status === 'uploading' ? <LoaderCircle className="spin" aria-hidden="true" /> : item.status === 'error' ? <CircleAlert aria-hidden="true" /> : <Icon aria-hidden="true" />}</span>
          <span className="conversation-file-copy">
            <strong title={item.name}>{item.name}</strong>
            {item.status === 'error' ? <small role="alert" title={item.error}>{item.error || '上传失败'}</small>
              : <small>{item.status === 'uploading' ? '上传中…' : formatBytes(item.bytes)}{item.status === 'ready' && <span className="sr-only">，已上传</span>}</small>}
          </span>
          {item.status === 'error' && item.file && <button type="button" className="conversation-file-action" disabled={disabled} onClick={() => draft.retry(item.id)} aria-label="重试上传" title="重试上传"><RotateCcw aria-hidden="true" /></button>}
          <button type="button" className="conversation-file-action" disabled={disabled || item.status === 'uploading'} onClick={() => void draft.remove(item.id)} aria-label={`移除附件 ${item.name}`} title="移除"><X aria-hidden="true" /></button>
        </div>;
      })}
      {draft.items.length > 1 && <button type="button" className="conversation-file-clear" disabled={disabled || uploading} title="从当前草稿移除全部文件，已发送消息中的原件保留" onClick={() => draft.discard()}>清空附件</button>}
    </div>
    {draft.error && <p className="conversation-file-error" role="alert">{draft.error}</p>}
  </div>;
}

/** 消息中的文件：一行说明归属（已附到任务 / 未使用 / 已过期），下面是文件卡片，读取时在卡片下方展开。 */
export function MessageFiles({ files, sessionId }: { files: MessageAttachments; sessionId: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const base = sessionAttachmentBase(sessionId, files.draftId);
  return <div className="conversation-files conversation-message-files" aria-label="消息附件">
    <div className="conversation-file-status">
      {files.expired ? <span>已过期清理</span> : files.taskId ? <><span className="attached">已附到任务</span><ObjectLink target={{ kind: 'task', id: files.taskId }}>查看任务</ObjectLink></> : <span>未使用</span>}
    </div>
    <div className="conversation-file-list">
      {files.attachments.map(item => {
        const Icon = KIND_ICON[item.capability];
        const open = preview === item.id && !files.expired;
        return <div className={`conversation-file task-attachment-row ${open ? 'previewing' : ''} ${files.expired ? 'expired' : ''}`} key={item.id}>
          <span className={`conversation-file-icon ${item.capability}`}><Icon aria-hidden="true" /></span>
          <span className="conversation-file-copy"><strong title={item.name}>{item.name}</strong><small>{formatBytes(item.bytes)}</small></span>
          {!files.expired && <>
            {item.capability !== 'download' && <button type="button" className="conversation-file-action" aria-expanded={open} onClick={() => setPreview(open ? null : item.id)} aria-label={open ? '收起预览' : '读取'} title={open ? '收起预览' : '预览'}>{open ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button>}
            <a className="conversation-file-action" href={`${base}/${item.id}/content`} download={item.name} aria-label="下载" title="下载"><Download aria-hidden="true" /></a>
          </>}
          {open && <TaskAttachmentPreview attachment={item} url={`${base}/${item.id}/content`} />}
        </div>;
      })}
    </div>
  </div>;
}
