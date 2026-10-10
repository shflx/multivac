import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileUp, LoaderCircle, X } from 'lucide-react';
import { READING_IMPORT_ACCEPT, bookFromImport, importFileError, importKindOf } from './reading-import.js';

// 原型模拟导入进度：约 1.5 秒完成，完成后自动打开书籍。
const PROGRESS_STEP = 20;
const PROGRESS_INTERVAL = 300;

/** 导入书籍：选择或拖入文件，书名默认取文件名，导入中可取消；完成后放进书架并打开。 */
export function ReadingImportDialog({ onImport, onClose }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const dialog = useRef(null);
  const timer = useRef(null);
  const titleId = useId();
  const importing = progress !== null;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector('button, input')?.focus();
    return () => { window.clearInterval(timer.current); opener?.focus(); };
  }, []);

  function choose(next) {
    if (!next) return;
    const problem = importFileError(next);
    setError(problem);
    setFile(problem ? null : next);
  }

  async function submit(event) {
    event.preventDefault();
    if (!file || importing) return;
    const text = ['text', 'markdown'].includes(importKindOf(file.name)) ? await file.text() : '';
    const book = bookFromImport({ id: `import-${crypto.randomUUID()}`, fileName: file.name, title, author, text });
    let value = 0;
    setProgress(value);
    timer.current = window.setInterval(() => {
      value = Math.min(100, value + PROGRESS_STEP);
      setProgress(value);
      if (value < 100) return;
      window.clearInterval(timer.current);
      onImport(book);
    }, PROGRESS_INTERVAL);
  }

  function cancelImport() {
    window.clearInterval(timer.current);
    setProgress(null);
  }

  return createPortal(<div className="reading-import-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) onClose(); }}>
    <form ref={dialog} className="reading-import-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (importing) cancelImport(); else onClose(); } }}>
      <header><div><h2 id={titleId}>导入书籍</h2><p>把书放进书架，继续阅读、标注与讨论。</p></div><button type="button" className="icon-button" aria-label="关闭" disabled={importing} onClick={onClose}><X /></button></header>
      <input ref={input} type="file" accept={READING_IMPORT_ACCEPT} hidden aria-label="选择书籍文件" onChange={(event) => { choose(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
      <button type="button" className={`reading-import-drop ${dragging ? 'dragging' : ''}`} disabled={importing} onClick={() => input.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files?.[0]); }}>
        <FileUp /><strong>{file ? file.name : '选择文件，或拖放到这里'}</strong><small>PDF、EPUB、TXT、Markdown</small>
      </button>
      {error && <p className="reading-import-error" role="alert">{error}</p>}
      <label className="reading-field">书名<input type="text" value={title} disabled={importing} placeholder="自动使用文件名" onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="reading-field">作者<input type="text" value={author} disabled={importing} placeholder="选填" onChange={(event) => setAuthor(event.target.value)} /></label>
      <p className="reading-import-hint">TXT、Markdown 最大 1 MiB。PDF、EPUB 支持大文件；扫描 PDF 请先转换为可识别文字的版本。原型不解析 PDF 与 EPUB，导入后以示例正文代替。</p>
      {importing && <div className="reading-import-progress" role="status"><LoaderCircle className="status-spinner" /><span>正在导入，完成后自动打开书籍。</span><progress max="100" value={progress} aria-label="导入进度" /></div>}
      <footer>{importing ? <button type="button" className="secondary" onClick={cancelImport}>取消导入</button> : <><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={!file}>导入</button></>}</footer>
    </form>
  </div>, document.body);
}
