import { createPortal } from 'react-dom';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { Note } from '@multivac/contracts';
import { activateNote, protectedNote, markProtected, markOrdinary, registerNoteSession, forgetNoteAccess } from '../../data/note-access.js';
import { convertNote, lockNote, noteProtection, noteSecurityRequest, unlockNote } from '../../data/note-security-api.js';
import { assertNoOrdinaryDrafts, flushAllNoteVaults, flushNoteVault, migrateOrdinaryDrafts, prepareNoteVault, protectionMarker, restoreOrdinaryDrafts, collectPeerDrafts, protectPeerDrafts } from './note-vault.js';

export const convertingNotes = new Set<string>();
function refresh(id: string) { window.dispatchEvent(new CustomEvent('note-protection-changed', { detail: id })); }

export function LockedNote({ id, state, onUnlocked }: { id: string; state: string; onUnlocked(): void }) {
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <form className="note-security-card" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); const value = password; setPassword('');
    try {
      await unlockNote(id, value);
      if (state !== 'encrypted') { const recovered = await convertNote(id, 'recover'); if (recovered.state === 'plain') markOrdinary(id); }
      if ((await noteProtection(id)).state !== 'plain') {
        await prepareNoteVault(id);
        if (localStorage.getItem(protectionMarker(id)) !== 'encrypted') {
          const discussions = await noteSecurityRequest<{ discussions: { sessionId: string }[] }>(`/api/notes/${id}/discussions`);
          const ids = discussions.discussions.map(discussion => discussion.sessionId); ids.forEach(sessionId => registerNoteSession(id, sessionId));
          const peers = await collectPeerDrafts(id, ids);
          await migrateOrdinaryDrafts(id, ids); await protectPeerDrafts(id, peers);
          localStorage.setItem(protectionMarker(id), 'encrypted');
        }
        markProtected(id);
      }
      activateNote(id); onUnlocked();
    } catch (error) { forgetNoteAccess(id); setError((error as Error).message); }
    finally { setBusy(false); }
  }}><h2>{state === 'encrypted' ? '加密笔记' : '笔记转换待恢复'}</h2><p>输入共用密码，仅解锁当前窗口中的这篇笔记。</p><label>共用密码<input type="password" autoComplete="current-password" value={password} required disabled={busy} onChange={event => setPassword(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? '正在核对…' : state === 'encrypted' ? '解锁笔记' : '解锁并恢复转换'}</button>{error && <p role="alert">{error}</p>}<small>连续 15 分钟无操作后锁定。刷新、关闭窗口或服务重启需重新解锁。忘记密码无法恢复旧内容。</small></form>;
}

export function NoteEncryptionActions({ note, save, blocked, onBusy }: { note: Note; save(): Promise<Note | null>; blocked: boolean; onBusy(value: boolean): void }) {
  const [mode, setMode] = useState<'encrypt' | 'decrypt' | null>(null), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const encrypted = protectedNote(note.id);
  async function convert() {
    if (!mode || busy) return;
    const action = mode; setBusy(true); setError(''); onBusy(true);
    try {
      const saved = await save(); if (!saved) throw new Error('请先完成保存，核对未知结果和版本冲突。');
      if (action === 'encrypt') {
        assertNoOrdinaryDrafts(note.id);
        const status = await noteSecurityRequest<{ configured: boolean }>('/api/note-security');
        if (!status.configured) await noteSecurityRequest('/api/note-security/password', 'POST', { password });
        await unlockNote(note.id, password); setPassword('');
        convertingNotes.add(note.id); localStorage.setItem(protectionMarker(note.id), 'transition');
        const discussions = await noteSecurityRequest<{ discussions: { sessionId: string }[] }>(`/api/notes/${note.id}/discussions`);
        const ids = discussions.discussions.map(discussion => discussion.sessionId); ids.forEach(id => registerNoteSession(note.id, id));
        const peers = await collectPeerDrafts(note.id, ids);
        assertNoOrdinaryDrafts(note.id);
        const result = await convertNote(note.id, action, saved.revision);
        if (result.state !== 'encrypted') throw new Error('笔记转换尚未完成，请恢复后核对。');
        await prepareNoteVault(note.id); await migrateOrdinaryDrafts(note.id, ids); await protectPeerDrafts(note.id, peers);
        markProtected(note.id); activateNote(note.id); localStorage.setItem(protectionMarker(note.id), 'encrypted');
      } else {
        convertingNotes.add(note.id);
        await flushNoteVault(note.id);
        const discussions = await noteSecurityRequest<{ discussions: { sessionId: string }[] }>(`/api/notes/${note.id}/discussions`);
        const peers = await collectPeerDrafts(note.id, discussions.discussions.map(discussion => discussion.sessionId));
        await protectPeerDrafts(note.id, peers);
        // 在原逐篇密钥仍可用时先核对各窗口的草稿密文；转换成功后才恢复普通写入。
        const result = await convertNote(note.id, action, saved.revision);
        if (result.state !== 'plain') throw new Error('取消加密尚未完成，请恢复后核对。');
        await restoreOrdinaryDrafts(note.id); markOrdinary(note.id); localStorage.removeItem(protectionMarker(note.id));
      }
      setMode(null); refresh(note.id);
    } catch (error) {
      setError((error as Error).message);
      try { const status = await noteProtection(note.id); if (status.state === 'plain') localStorage.removeItem(protectionMarker(note.id)); else { markProtected(note.id); localStorage.setItem(protectionMarker(note.id), action === 'encrypt' ? 'transition' : status.state); refresh(note.id); } } catch { /* 未知结果保留转换标记，阻止旧控制器写回。 */ }
    } finally { convertingNotes.delete(note.id); setBusy(false); onBusy(false); }
  }
  return <span className="note-encryption-actions">
    {encrypted && <button type="button" disabled={blocked || busy} onClick={async () => { setError(''); try { const saved = await save(); if (!saved) throw new Error('请先核对保存结果。'); await flushNoteVault(note.id); await lockNote(note.id); refresh(note.id); } catch (error) { setError((error as Error).message); } }}>锁定</button>}
    <button type="button" disabled={blocked || busy} onClick={() => { setMode(encrypted ? 'decrypt' : 'encrypt'); setError(''); }}>{encrypted ? '取消加密' : '加密此笔记'}</button>
    {mode && <span className="note-security-dialog" role="dialog" aria-modal="true" aria-label={mode === 'encrypt' ? '加密此笔记' : '取消加密'}>
      <strong>{mode === 'encrypt' ? '加密此笔记' : '取消加密'}</strong><p>{mode === 'encrypt' ? '所有加密笔记共用一个密码。首次使用会设置密码，其他笔记保持普通状态。忘记密码无法恢复旧内容。' : '确认后，正文、历史、图片及所属讨论恢复普通存储。'}</p>
      {mode === 'encrypt' && <label>共用密码<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>}
      <button type="button" disabled={busy || mode === 'encrypt' && !password} onClick={() => void convert()}>{busy ? '正在转换，请保持页面打开…' : '确认'}</button><button type="button" disabled={busy} onClick={() => { setMode(null); setPassword(''); }}>返回</button>
    </span>}{error && <span className="notes-error" role="alert">{error}</span>}
  </span>;
}

export function NotePasswordSettings() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(''), [password, setPassword] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  function close() { setOpen(false); setCurrent(''); setPassword(''); setMessage(''); }
  return <>
    <button type="button" aria-label="共用密码设置" title="共用密码设置" onClick={() => setOpen(true)}><KeyRound size={15} /></button>
    {open && createPortal(<div className="note-security-overlay"><form className="note-security-card note-password-settings" role="dialog" aria-modal="true" aria-label="修改共用密码" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setMessage('');
      const old = current, next = password; setCurrent(''); setPassword('');
      try {
        await flushAllNoteVaults();
        await noteSecurityRequest('/api/note-security/password', 'PUT', { currentPassword: old, password: next });
        window.dispatchEvent(new Event('note-password-changed'));
        setMessage('共用密码已修改，请使用新密码逐篇解锁。');
      } catch (error) { setMessage((error as Error).message); }
      finally { setBusy(false); }
    }}>
      <strong>修改共用密码</strong><p>忘记密码无法恢复旧密文。修改后所有窗口需重新解锁。</p>
      <label>原密码<input type="password" required autoComplete="current-password" disabled={busy} value={current} onChange={event => setCurrent(event.target.value)} /></label>
      <label>新密码<input type="password" required autoComplete="new-password" disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy} type="submit">{busy ? '正在修改…' : '修改密码'}</button>
      <button disabled={busy} type="button" onClick={close}>关闭密码设置</button>
      {message && <p role="status">{message}</p>}
    </form></div>, document.body)}
  </>;
}
