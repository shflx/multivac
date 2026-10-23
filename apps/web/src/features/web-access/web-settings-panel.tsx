import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Info } from 'lucide-react';
import type { WebSettings } from '@multivac/contracts';
import { SettingsCard, SettingsRow } from '../../components/settings-card.js';
import { useConfirm } from '../../components/confirm-card.js';
import { AssistantApiError } from '../../data/assistant-api.js';
import { getWebSettings, saveWebSettings } from '../../data/web-settings-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import './web-settings.css';

export function WebSettingsPanel({ active, onDirtyChange, onBusyChange, discardSignal }: {
  active: boolean; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void; discardSignal: number;
}) {
  const [snapshot, setSnapshot] = useState<WebSettings | null>(null);
  const [enabled, setEnabled] = useState(false), [key, setKey] = useState(''), [base, setBase] = useState(0);
  const [edited, setEdited] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState<{ commandId: string; revision: number } | null>(null);
  const dirty = edited || Boolean(key);
  const state = useRef({ dirty, pending }); state.current = { dirty, pending };
  const generation = useRef(0), mounted = useRef(true);
  const confirm = useConfirm();
  const adopt = useCallback((value: WebSettings) => {
    setSnapshot(value); setBase(value.revision); setEnabled(value.enabled); setEdited(false); setKey('');
  }, []);
  const load = useCallback(async (discard = false) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const value = await getWebSettings();
      if (!mounted.current || token !== generation.current) return;
      setSnapshot(value);
      const command = state.current.pending;
      if (command && value.lastCommandId === command.commandId) {
        setPending(null); adopt(value); setError(''); setNotice('已核对，配置已保存');
      } else if (command && value.revision > command.revision) {
        setPending(null); setError('配置已再次变化，请核对当前状态；原保存结果不能仅凭当前状态确认。');
      } else if (discard || (!state.current.dirty && !command)) { adopt(value); setError(''); }
    } catch (cause) { if (mounted.current && token === generation.current) setError(cause instanceof Error ? cause.message : '网页配置读取失败。'); }
    finally { if (mounted.current && token === generation.current) setLoading(false); }
  }, [adopt]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { if (active) void load(); else setKey(''); }, [active, load]);
  useEffect(() => { if (discardSignal) { setKey(''); setEdited(false); void load(true); } }, [discardSignal, load]);
  useEffect(() => { onDirtyChange(dirty || Boolean(pending)); return () => onDirtyChange(false); }, [dirty, pending, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useWorkbenchEvents(event => { if (event.type === 'web-settings.changed' || event.type === 'workbench.connected') void load(); });

  const locked = snapshot?.source === 'environment';
  const stale = Boolean(snapshot && dirty && base !== snapshot.revision);
  const disabled = busy || loading || locked || Boolean(pending) || stale;
  async function save(clearKey = false) {
    if (!snapshot || disabled) return;
    const command = { commandId: crypto.randomUUID(), revision: clearKey ? snapshot.revision : base };
    const apiKey = key.trim();
    generation.current++; setLoading(false); setBusy(true); setError(''); setNotice(''); setPending(command); setKey('');
    try {
      const value = await saveWebSettings({ ...command, enabled: clearKey ? false : enabled, provider: 'deepseek',
        ...(clearKey ? { clearKey: true } : apiKey ? { apiKey } : {}) });
      generation.current++; setLoading(false);
      adopt(value); setPending(null); setNotice(clearKey ? '密钥已移除，网页能力已关闭' : '已保存，新配置即时生效');
    } catch (cause) {
      const rejected = cause instanceof AssistantApiError && cause.status >= 400 && cause.status < 500;
      if (rejected) setPending(null);
      setError(rejected ? cause.message : '保存结果待核对。请点击“核对保存结果”，不要重复提交密钥。');
    } finally { setBusy(false); }
  }
  async function removeKey() {
    if (await confirm({ title: '移除网页 API Key？', description: '移除本实例保存的密钥，并关闭网页搜索与读取。', tone: 'danger', confirmLabel: '移除密钥' })) await save(true);
  }
  return <div className="web-settings-panel" data-web-settings>
    <SettingsCard title="网页搜索与读取"
      description="让 Multivac 搜索最新信息、读取你提供的网页链接，对全局 Multivac、工作会话和后台任务生效。查询与链接会发送给所选服务商。">
      {!snapshot ? <div className="web-settings-state" aria-live="polite">{error || '正在读取网页配置…'}{error && <button className="secondary-button" onClick={() => void load()}>重试</button>}</div> : <>
        {locked && <p className="web-settings-locked" role="status"><Info aria-hidden="true" />当前由环境变量配置。若要在此修改，请先移除网页环境变量并重启服务。</p>}
        <SettingsRow label="启用网页能力" hint="保存后即时生效。关闭后不再发起新的网页请求。">
          <button type="button" role="switch" aria-label="启用网页能力" className="preference-switch" aria-checked={enabled} disabled={disabled}
            onClick={() => { setEnabled(!enabled); setEdited(true); setNotice(''); }}><span aria-hidden="true" /></button>
        </SettingsRow>
        <SettingsRow label="服务商" hint="与会话使用的模型独立。">
          <span className="web-settings-select">
            <select aria-label="网页服务商" value="deepseek" disabled={disabled} onChange={() => {}}><option value="deepseek">DeepSeek</option></select>
            <ChevronDown aria-hidden="true" />
          </span>
        </SettingsRow>
        <SettingsRow label="API Key" hint={snapshot.configured ? '已配置。留空保留现有密钥，填写新值可替换。' : '尚未配置。密钥仅保存在本实例，保存后不回显。'}>
          <input type="password" aria-label="网页 API Key" autoComplete="new-password" spellCheck={false} maxLength={4096}
            placeholder={snapshot.configured ? '输入新密钥以替换' : '输入 DeepSeek API Key'} value={key} disabled={disabled}
            onChange={event => { setKey(event.target.value); setNotice(''); }} />
        </SettingsRow>
        <div className="web-settings-actions">
          <button type="button" className="primary-button" disabled={disabled || !dirty || (enabled && !snapshot.configured && !key.trim())} onClick={() => void save()}>{busy ? '正在保存…' : '保存网页配置'}</button>
          {/* 配置变化经工作台事件自动重读，只在有草稿或保存待核对时才需要手动操作。 */}
          {pending ? <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void load()}>核对保存结果</button>
            : dirty && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void load(true)}>放弃修改并刷新</button>}
          {/* 结果紧跟操作按钮显示；下次修改时清除。 */}
          {notice && <span className="web-settings-saved" role="status"><Check aria-hidden="true" />{notice}</span>}
          {snapshot.configured && <button type="button" className="secondary-button danger web-settings-remove" disabled={disabled || dirty} onClick={() => void removeKey()}>移除密钥</button>}
        </div>
        {stale && <p className="form-error" role="alert">配置已在别处修改。草稿已保留，请放弃修改并刷新后重新核对。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </>}
    </SettingsCard>
  </div>;
}
