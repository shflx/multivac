import { useEffect, useRef, useState } from 'react';
import { Type } from 'typebox';
import { InboxItemSchema, InboxListSchema, type InboxItem, type InboxList } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { newCommandId } from '../../data/command-id.js';

const PREFIX = '/api/assistant/confirmations';
const ItemResponse = Type.Object({ item: InboxItemSchema }, { additionalProperties: false });

/** 只呈现当前全局对话提出的外发请求，没有 Inbox 总览和其他会话入口。 */
export function ConversationConfirmations() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const reading = useRef(false);
  const seen = useRef(new Set<string>());
  const refresh = async () => {
    if (reading.current) return;
    reading.current = true;
    const version = ++generation.current;
    const result: InboxItem[] = []; let offset: number | null = 0;
    try {
      do {
        const page: InboxList = await fetchJson(`${PREFIX}?offset=${offset}&limit=100`, undefined, InboxListSchema);
        if (version !== generation.current) return;
        result.push(...page.items); offset = page.nextOffset;
      } while (offset !== null);
      for (const item of result) if (['pending', 'unknown'].includes(item.status)) seen.current.add(item.id);
      setItems(result); setError('');
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : '确认请求读取失败。'); }
    finally { reading.current = false; }
  };
  useEffect(() => {
    void refresh(); const timer = window.setInterval(() => void refresh(), 2000);
    return () => { ++generation.current; window.clearInterval(timer); };
  }, []);
  return <section className="conversation-confirmations" aria-label="当前对话外发确认">
    {error && <p role="alert">{error}<button type="button" onClick={() => void refresh()}>重新读取</button></p>}
    {items.filter(item => item.status === 'pending' || item.status === 'unknown' || seen.current.has(item.id)).map(item => <ExternalConfirmation key={item.id} item={item} onChanged={next => setItems(current => current.map(value => value.id === next.id ? next : value))} />)}
  </section>;
}

function ExternalConfirmation({ item, onChanged }: { item: InboxItem; onChanged: (item: InboxItem) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const external = item.external;
  async function decide(decision: 'once' | 'deny'): Promise<void> {
    if (busy) return;
    setBusy(true); setError('');
    const storageKey = `multivac.remote.confirmation:${item.id}:${item.revision}:${decision}`;
    let commandId = newCommandId();
    try { commandId = sessionStorage.getItem(storageKey) ?? commandId; sessionStorage.setItem(storageKey, commandId); } catch { /* 存储不可用仍按此次命令执行，结果未知不自动重发。 */ }
    try {
      const result = await fetchJson<{ item: InboxItem }>(`${PREFIX}/${encodeURIComponent(item.id)}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, revision: item.revision, decision }),
      }, ItemResponse);
      onChanged(result.item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '决定结果未知，请核对当前请求。'); }
    finally { setBusy(false); }
  }
  async function reconcile(): Promise<void> {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await fetchJson<{ item: InboxItem }>(`${PREFIX}/${encodeURIComponent(item.id)}/reconcile`, { method: 'POST' }, ItemResponse); onChanged(result.item); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '结果仍待核对。'); }
    finally { setBusy(false); }
  }
  if (!external) return null;
  if (!['pending', 'unknown'].includes(item.status)) return <section className="task-receipt proposal-card confirmed" aria-label="当前对话外发结果"><strong>{item.title}</strong><p>{external.result}</p></section>;
  return <section className="task-receipt proposal-card pending" aria-label="当前对话 Git 外发确认">
    <strong>{item.title}</strong>
    <dl><div><dt>仓库</dt><dd>{external.repository}</dd></div><div><dt>目标</dt><dd>{external.target}</dd></div><div><dt>分支</dt><dd>{external.ref}</dd></div><div><dt>固定提交</dt><dd>{external.commit}</dd></div><div><dt>认证</dt><dd>{external.account}</dd></div></dl>
    <pre>{external.summary}</pre><p>{external.result}</p>
    {error && <p role="alert">{error}</p>}
    <footer className="receipt-actions">{item.status === 'pending' ? <><button type="button" disabled={busy} onClick={() => void decide('deny')}>拒绝</button><button type="button" disabled={busy} onClick={() => void decide('once')}>单次批准发布</button></> : <button type="button" disabled={busy} onClick={() => void reconcile()}>只读核对结果</button>}</footer>
  </section>;
}
