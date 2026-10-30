import { ConfirmCard } from '../../components/confirm-card.js';
import { Lock, LockKeyhole, LockOpen } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePageOpener } from '../assistant/object-links.js';
import './note-security.css';
import type { Note } from '@multivac/contracts';
import { activateNote, protectedNote, markProtected, markOrdinary, registerNoteSession, forgetNoteAccess } from '../../data/note-access.js';
import { convertNote, lockNote, noteProtection, noteSecurityRequest, unlockNote } from '../../data/note-security-api.js';
import { assertNoOrdinaryDrafts, flushNoteVault, migrateOrdinaryDrafts, prepareNoteVault, protectionMarker, restoreOrdinaryDrafts, collectPeerDrafts, protectPeerDrafts } from './note-vault.js';

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
  }}>
    <span className="note-security-icon" aria-hidden="true"><LockKeyhole /></span>
    <h2>{state === 'encrypted' ? '这篇笔记已加密' : '笔记转换待恢复'}</h2>
    <p>输入笔记密码，仅在当前窗口解锁这一篇。</p>
    <input type="password" aria-label="笔记密码" placeholder="笔记密码" autoComplete="current-password" value={password} required disabled={busy} autoFocus onChange={event => setPassword(event.target.value)} />
    {error && <p className="note-security-error" role="alert">{error}</p>}
    <button type="submit" disabled={busy || !password}>{busy ? '正在核对…' : state === 'encrypted' ? '解锁笔记' : '解锁并恢复转换'}</button>
    <small>15 分钟无操作、刷新或关闭窗口后会重新锁定。</small>
  </form>;
}

/**
 * 工具栏锁按钮是加锁切换：普通笔记点击加密；已解锁的加密笔记点击立即锁定。
 * 取消加密是低频操作，挂到底栏的加密状态旁（decryptRoot）。
 */
export function NoteEncryptionActions({ note, save, blocked, onBusy, decryptRoot }: { note: Note; save(): Promise<Note | null>; blocked: boolean; onBusy(value: boolean): void; decryptRoot: HTMLElement | null }) {
  const [mode, setMode] = useState<'setup' | 'encrypt' | 'decrypt' | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  // 首次加密只用公钥；曾加密又取消的笔记沿用原逐篇密钥，需要密码打开。
  const [needPassword, setNeedPassword] = useState(false), [password, setPassword] = useState('');
  const openPage = usePageOpener();
  const encrypted = protectedNote(note.id);
  async function convert() {
    if ((mode !== 'encrypt' && mode !== 'decrypt') || busy) return;
    const action = mode; setBusy(true); setError(''); onBusy(true);
    try {
      const saved = await save(); if (!saved) throw new Error('请先完成保存，核对未知结果和版本冲突。');
      if (action === 'encrypt') {
        assertNoOrdinaryDrafts(note.id);
        // 普通笔记不应持有解锁凭证；清掉此前取消加密遗留的凭证，确保加密走免密码签发，响应丢失时进入恢复核对。
        forgetNoteAccess(note.id);
        if (needPassword) { await unlockNote(note.id, password); setPassword(''); }
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
        // 已恢复普通存储，不再需要解锁凭证：撤销服务端凭证，及时释放其持有的私钥。
        await lockNote(note.id).catch(() => forgetNoteAccess(note.id));
      }
      setMode(null); refresh(note.id);
    } catch (error) {
      setError((error as Error).message);
      try { const status = await noteProtection(note.id); if (status.state === 'plain') localStorage.removeItem(protectionMarker(note.id)); else { markProtected(note.id); localStorage.setItem(protectionMarker(note.id), action === 'encrypt' ? 'transition' : status.state); refresh(note.id); } } catch { /* 未知结果保留转换标记，阻止旧控制器写回。 */ }
    } finally { convertingNotes.delete(note.id); setBusy(false); onBusy(false); }
  }
  /** 加密前核对是否已设置笔记密码；未设置时提示前往「偏好」设置。 */
  async function startEncrypt() {
    setError('');
    try {
      const [status, protection] = await Promise.all([noteSecurityRequest<{ configured: boolean }>('/api/note-security'), noteProtection(note.id)]);
      setNeedPassword(!!protection.needsPassword); setPassword('');
      setMode(status.configured ? 'encrypt' : 'setup');
    } catch (error) { setError((error as Error).message); }
  }
  async function lockNow() {
    setError('');
    try { const saved = await save(); if (!saved) throw new Error('请先核对保存结果。'); await flushNoteVault(note.id); await lockNote(note.id); refresh(note.id); }
    catch (error) { setError((error as Error).message); }
  }

  return <span className="note-encryption-actions">
    {encrypted
      ? <button type="button" className="note-lock-toggle active" disabled={blocked || busy} aria-label="锁定笔记" title="已解锁 · 点击锁定" onClick={() => void lockNow()}><LockOpen size={16} aria-hidden="true" /></button>
      : <button type="button" className="note-lock-toggle" disabled={blocked || busy} aria-label="加密此笔记" title="加密此笔记" onClick={() => void startEncrypt()}><Lock size={16} aria-hidden="true" /></button>}
    {encrypted && decryptRoot && createPortal(<button type="button" className="note-decrypt-link" disabled={blocked || busy} onClick={() => { setMode('decrypt'); setError(''); }}>取消加密</button>, decryptRoot)}
    {mode === 'setup' && <ConfirmCard title="尚未设置笔记密码" description="所有加密笔记共用一个密码。请先在「偏好」中设置笔记密码，再回来加密此笔记。"
      confirmLabel={openPage ? '前往设置' : '知道了'} cancelLabel="返回"
      onConfirm={() => { setMode(null); openPage?.('preferences'); }} onCancel={() => setMode(null)} />}
    {(mode === 'encrypt' || mode === 'decrypt') && <ConfirmCard title={mode === 'encrypt' ? '加密此笔记' : '取消加密'}
      description={mode === 'decrypt' ? '确认后，正文、历史、图片及所属讨论恢复普通存储。'
        : needPassword ? '这篇笔记曾经加密过，将沿用原来的密钥，请输入笔记密码确认。'
          : '正文、历史、图片及所属讨论都会加密保存。之后在其他窗口或重新打开时，需要输入笔记密码解锁。'}
      confirmLabel={mode === 'encrypt' ? '加密' : '取消加密'} cancelLabel="返回" busy={busy} error={error}
      confirmDisabled={mode === 'encrypt' && needPassword && !password}
      onConfirm={() => void convert()} onCancel={() => { setMode(null); setPassword(''); setError(''); }}>
      {mode === 'encrypt' && needPassword && <label className="note-security-fields">笔记密码<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} autoFocus /></label>}
    </ConfirmCard>}{error && !mode && <span className="notes-error" role="alert">{error}</span>}
  </span>;
}
