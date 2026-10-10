import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MultivacIcon } from '../components/multivac-icon.js';
import { ConfirmProvider } from '../components/confirm-card.js';
import { AccessIdentityError, loginRemote, logoutRemote, readAccessIdentity, type AccessIdentity } from '../data/access-api.js';
import { AssistantSessionsProvider, useAssistantSession } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { RemoteConversationContext } from '../features/assistant/remote-context.js';
import { GlobalEventsProvider } from '../features/events/global-events-provider.js';
import { ProposalsProvider, useProposalsStore } from '../features/proposals/proposals-provider.js';

const DRAFT_KEY = 'multivac.remote.unsent-draft';

/** 身份确定后才初始化 Provider；登录前不请求任何对话或工作台数据。 */
export function AccessEntry({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<AccessIdentity | null>(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const readVersion = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    try {
      const value = await readAccessIdentity();
      if (mounted.current && version === readVersion.current) { setIdentity(value); setConnectionError(''); }
    } catch (cause) {
      if (!mounted.current || version !== readVersion.current) return;
      setConnectionError(cause instanceof Error ? cause.message : '连接失败，请重试。');
      if (cause instanceof AccessIdentityError && cause.status === 403) setIdentity({ kind: 'remote', authenticated: false, loginEnabled: false });
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onCheck = () => void refresh();
    window.addEventListener('multivac.access-check', onCheck);
    window.addEventListener('focus', onCheck);
    const timer = window.setInterval(onCheck, 5000);
    return () => { mounted.current = false; ++readVersion.current; window.clearInterval(timer); window.removeEventListener('multivac.access-check', onCheck); window.removeEventListener('focus', onCheck); };
  }, [refresh]);

  async function login(): Promise<void> {
    if (busy || !token) return;
    setBusy(true); setError(''); ++readVersion.current;
    try { await loginRemote(token); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败。'); }
    finally { setToken(''); setBusy(false); }
  }
  async function logout(): Promise<void> {
    if (busy) return;
    setBusy(true); setError(''); ++readVersion.current;
    try { await logoutRemote(); setIdentity({ kind: 'remote', authenticated: false, loginEnabled: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '退出失败。'); }
    finally { setBusy(false); }
  }
  if (identity?.kind === 'local') return children;
  if (identity?.authenticated) return <RemoteConversationContext.Provider value={true}>
    <div className="remote-entry">
      <header className="remote-header"><span><MultivacIcon />Multivac</span><button type="button" disabled={busy} onClick={() => void logout()}>退出登录</button></header>
      {(error || connectionError) && <p role="alert" className="remote-error">{error || connectionError}</p>}
      <GlobalEventsProvider><ConfirmProvider><ProposalsProvider><AssistantSessionsProvider>
        <RemoteConversation />
      </AssistantSessionsProvider></ProposalsProvider></ConfirmProvider></GlobalEventsProvider>
    </div>
  </RemoteConversationContext.Provider>;
  return <main className="remote-login"><form onSubmit={event => { event.preventDefault(); void login(); }}>
    <MultivacIcon /><h1>连接 Multivac</h1>
    <p>{identity ? identity.loginEnabled ? '输入本机配置的访问 token，继续你的对话。' : '外部访问已关闭或地址不匹配，请在本机检查配置。' : '正在检查访问入口。'}</p>
    {identity?.loginEnabled && <><label htmlFor="access-token">访问 token</label><input id="access-token" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096} value={token} onChange={event => setToken(event.target.value)} disabled={busy} /><button type="submit" disabled={busy || !token}>{busy ? '正在登录…' : '登录'}</button></>}
    {error && <p role="alert">{error}</p>}
    {connectionError && <p role="alert">{connectionError}</p>}
    {(!identity || !identity.loginEnabled) && <button type="button" onClick={() => void refresh()}>重新检查</button>}
    {identity && <p>未发送的文字草稿保留在当前浏览器标签页。</p>}
  </form></main>;
}

function RemoteConversation() {
  const entry = useAssistantSession();
  const proposals = useProposalsStore();
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (entry?.session.status !== 'ready') return;
    try {
      if (!restored.current) {
        restored.current = true;
        const draft = sessionStorage.getItem(DRAFT_KEY);
        if (draft !== null && draft !== entry.session.pageState.draft) { entry.session.updateDraft(draft); return; }
      }
      sessionStorage.setItem(DRAFT_KEY, entry.session.pageState.draft);
    } catch { /* 存储不可用时不阻断发送；保留会话原有保存错误反馈。 */ }
  }, [entry]);
  useEffect(() => {
    let disposed = false; let reading = false;
    const refresh = async () => {
      if (disposed || reading) return;
      reading = true;
      try { await proposals.refresh(); } catch { /* 401/403 经统一 API 通知登录入口，网络错误保留已有卡片。 */ }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [proposals]);
  return <AssistantView />;
}
