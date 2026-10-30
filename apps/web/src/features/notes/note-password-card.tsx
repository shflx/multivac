import { useEffect, useState } from 'react';
import { ConfirmCard } from '../../components/confirm-card.js';
import { SettingsCard, SettingsRow } from '../../components/settings-card.js';
import { noteSecurityRequest } from '../../data/note-security-api.js';
import { flushAllNoteVaults } from './note-vault.js';
import './note-security.css';

/** 偏好设置中的笔记密码：未设置时设置，已设置时修改；两次输入一致才提交。 */
export function NotePasswordCard() {
  const [configured, setConfigured] = useState<boolean | null>(null), [loadError, setLoadError] = useState('');
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => {
    try { setConfigured((await noteSecurityRequest<{ configured: boolean }>('/api/note-security')).configured); setLoadError(''); }
    catch (cause) { setLoadError((cause as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  function close() { setOpen(false); setCurrent(''); setPassword(''); setRepeat(''); setError(''); }
  async function submit() {
    if (busy) return;
    if (password !== repeat) { setError('两次输入的新密码不一致。'); return; }
    setBusy(true); setError('');
    try {
      if (configured) {
        await flushAllNoteVaults();
        await noteSecurityRequest('/api/note-security/password', 'PUT', { currentPassword: current, password });
        window.dispatchEvent(new Event('note-password-changed'));
        setNotice('笔记密码已修改，已解锁的笔记需用新密码重新解锁。');
      } else {
        await noteSecurityRequest('/api/note-security/password', 'POST', { password });
        setNotice('笔记密码已设置，可以在笔记中加密。');
      }
      close(); await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <SettingsCard title="笔记" description="加密笔记共用一个密码，逐篇加密，在当前窗口逐篇解锁。">
    <SettingsRow label="笔记密码" hint={loadError || (configured === null ? '正在读取…' : configured ? '已设置。忘记密码无法恢复已加密的笔记。' : '尚未设置。加密笔记前需要先设置。')}
      details="解锁后 15 分钟无操作、刷新或关闭窗口会重新锁定；修改密码后所有窗口需重新解锁。">
      {notice && <span className="preference-value" role="status">{notice}</span>}
      <button type="button" className="secondary-button" disabled={configured === null} onClick={() => { setNotice(''); setOpen(true); }}>{configured ? '修改密码' : '设置密码'}</button>
    </SettingsRow>
    {open && <ConfirmCard title={configured ? '修改笔记密码' : '设置笔记密码'}
      description={configured ? '修改后所有窗口需用新密码重新解锁。' : '所有加密笔记共用这个密码。请妥善保管，忘记后无法恢复已加密的内容。'}
      confirmLabel={configured ? '修改密码' : '设置密码'} cancelLabel="取消" busy={busy} error={error}
      confirmDisabled={!password || !repeat || (!!configured && !current)}
      onConfirm={() => void submit()} onCancel={close}>
      {configured && <label className="note-security-fields">原密码<input type="password" autoComplete="current-password" disabled={busy} value={current} onChange={event => setCurrent(event.target.value)} autoFocus /></label>}
      <label className="note-security-fields">{configured ? '新密码' : '密码'}<input type="password" autoComplete="new-password" disabled={busy} value={password} onChange={event => setPassword(event.target.value)} autoFocus={!configured} /></label>
      <label className="note-security-fields">再次输入<input type="password" autoComplete="new-password" disabled={busy} value={repeat} onChange={event => setRepeat(event.target.value)} /></label>
    </ConfirmCard>}
  </SettingsCard>;
}
