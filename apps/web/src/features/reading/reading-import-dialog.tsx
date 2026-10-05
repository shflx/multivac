import { useId, useRef, useState } from 'react';
import { BookOpen, FileUp, Upload } from 'lucide-react';
import { ConfirmCard } from '../../components/confirm-card.js';

export function ReadingImportDialog({ file, title, author, busy, cancellable, error, onFile, onTitle, onAuthor, onSubmit, onCancel }: {
  file: File | null; title: string; author: string; busy: boolean; cancellable: boolean; error: string;
  onFile: (file: File) => void; onTitle: (title: string) => void; onAuthor: (author: string) => void;
  onSubmit: () => void; onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hint = useId();
  const [dragging, setDragging] = useState(false);
  const size = file ? file.size < 1024 * 1024 ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB` : '';
  return <ConfirmCard title="导入书籍" description="把书放进书架，继续阅读、标注与讨论。" icon={BookOpen}
    confirmLabel={busy ? '导入中' : '导入'} cancelLabel={busy ? '取消导入' : '取消'} busy={busy} allowCancelWhileBusy={cancellable}
    confirmDisabled={!file || !title.trim()} error={error} onConfirm={onSubmit} onCancel={onCancel}>
    <div className="reading-import-content">
      <div className={`reading-import-drop${dragging ? ' dragging' : ''}${file ? ' selected' : ''}`}
        onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={event => { event.preventDefault(); setDragging(false); if (!busy && event.dataTransfer.files[0]) onFile(event.dataTransfer.files[0]); }}>
        <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="书籍文件" disabled={busy} accept=".txt,.md,.pdf,.epub,text/plain,text/markdown,application/pdf,application/epub+zip" onChange={event => { if (event.target.files?.[0]) onFile(event.target.files[0]); }} />
        <button type="button" className="reading-import-choose" autoFocus disabled={busy} aria-describedby={hint} onClick={() => input.current?.click()}>
          {file ? <BookOpen aria-hidden="true" /> : <FileUp aria-hidden="true" />}
          <strong>{file ? file.name : '选择文件，或拖放到这里'}</strong>
          <span>{file ? `${file.name.split('.').at(-1)?.toUpperCase()} · ${size} · 点击更换` : 'PDF、EPUB、TXT、Markdown'}</span>
        </button>
      </div>
      <div className="reading-import-fields">
        <label>书名<input value={title} disabled={busy} maxLength={200} placeholder="自动使用文件名" onChange={event => onTitle(event.target.value)} /></label>
        <label>作者 <span>选填</span><input aria-label="作者" value={author} disabled={busy} maxLength={200} placeholder="作者姓名" onChange={event => onAuthor(event.target.value)} /></label>
      </div>
      <p id={hint} className="reading-import-hint">TXT、Markdown 最大 1 MiB。PDF、EPUB 支持大文件；扫描 PDF 请先转换为可识别文字的版本。</p>
      {busy && <p className="reading-import-progress" role="status"><Upload size={15} aria-hidden="true" />正在导入，完成后自动打开书籍。</p>}
    </div>
  </ConfirmCard>;
}
