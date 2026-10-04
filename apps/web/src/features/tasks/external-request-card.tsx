import { useTaskRequests } from './task-requests-provider.js';
import type { InboxItem } from '@multivac/contracts';
import { InboxItemSchema } from '@multivac/contracts';
import { Type } from 'typebox';
import { fetchJson } from '../../data/assistant-api.js';
import { useState } from 'react';

export function ExternalRequestCard({ item }: { item: InboxItem }) {
  const { store, pending, errors } = useTaskRequests();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const request = item.external;
  if (!request || !store) return null;
  async function reconcile() {
    setChecking(true); setError('');
    try { const result = await fetchJson<{ item: InboxItem }>(`/api/inbox/${encodeURIComponent(item.id)}/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, Type.Object({ item: InboxItemSchema })); store!.applyInbox(result.item); }
    catch { setError('远端核对失败，请稍后重试；没有再次执行发布。'); }
    finally { setChecking(false); }
  }
  return <section className="proposal-card" aria-label="Git 外发授权">
    <h3>发布固定 Git 提交</h3><p>仅创建新的远端分支；不会覆盖已有分支。</p>
    <dl><dt>目标</dt><dd>{request.target} · {request.ref}</dd><dt>提交</dt><dd><code>{request.commit}</code></dd><dt>认证</dt><dd>{request.account}</dd></dl>
    <pre>{request.summary}</pre><p role="status">{request.result}</p>
    <p>授权不代表执行成功，也不会自动完成来源任务。</p>
    {(error || errors[item.id]) && <p role="alert">{error || errors[item.id]}</p>}
    {item.status === 'pending' && <footer className="receipt-actions"><button disabled={pending.has(item.id)} onClick={() => void store.decideItem(item, 'deny')}>拒绝发布</button><button disabled={pending.has(item.id)} onClick={() => void store.decideItem(item, 'once')}>仅批准这次发布</button></footer>}
    {request.status === 'unknown' && <button disabled={checking} onClick={() => void reconcile()}>只读核对远端结果</button>}
  </section>;
}
