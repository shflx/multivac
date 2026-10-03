import { useEffect, useRef, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import type { CollectReadingCommand, ReadingCollectionItem, ReadingCollectionTarget } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { collectReading, createCollectionTarget, listCollectedItems, listCollectionTargets } from '../../data/reading-api.js';
import { BookReferenceLink } from '../assistant/object-links.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export function ReadingCollectCard({ source, close, openNotes }: { source: CollectReadingCommand['source']; close: () => void; openNotes: (targetId: string) => void }) {
  const [targets, setTargets] = useState<ReadingCollectionTarget[]>([]);
  const [targetId, setTargetId] = useState('reading-inbox');
  const [saved, setSaved] = useState<ReadingCollectionItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const command = useRef<CollectReadingCommand | null>(null);
  useEffect(() => { void listCollectionTargets().then(value => setTargets(value.targets)).catch(e => setError((e as Error).message)); }, []);
  async function collect() {
    setBusy(true); setError('');
    try {
      command.current ??= { commandId: crypto.randomUUID(), targetId, source };
      const item = await collectReading(command.current);
      const readback = await listCollectedItems(item.targetId);
      if (!readback.items.some(n => n.id === item.id)) throw new Error('收集结果尚未读回，请核对原命令。');
      setSaved(item);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <ConfirmCard title={saved ? '已收进笔记' : '收进笔记'} confirmLabel={saved ? '查看笔记' : '收集'} cancelLabel={saved ? '返回阅读' : '取消'} busy={busy} error={error} confirmDisabled={!targets.length} onCancel={close} onConfirm={() => { if (saved) { openNotes(saved.targetId); close(); } else void collect(); }}>
    {saved ? <><p>{targets.find(t => t.id === saved.targetId)?.title}</p><blockquote>{saved.body}</blockquote></> : <label className="reading-collect-target">接收目标<select aria-label="接收目标" value={targetId} disabled={Boolean(command.current) || busy} onChange={event => setTargetId(event.target.value)}>{targets.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
  </ConfirmCard>;
}

export function ReadingCollectionPage({ active, request }: { active: boolean; request?: { id: number; targetId: string } | null }) {
  const [targets, setTargets] = useState<ReadingCollectionTarget[]>([]);
  const [targetId, setTargetId] = useState('reading-inbox');
  const [items, setItems] = useState<ReadingCollectionItem[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const createCommand = useRef<string | null>(null);
  async function refresh() {
    const token = ++generation.current;
    try {
      const list = await listCollectionTargets(); const records = await listCollectedItems(targetId);
      if (token === generation.current) { setTargets(list.targets); setItems(records.items); setError(''); }
    } catch (e) { if (token === generation.current) setError((e as Error).message); }
  }
  useEffect(() => { if (active) void refresh(); return () => { ++generation.current; }; }, [active, targetId]);
  useEffect(() => { if (request) setTargetId(request.targetId); }, [request?.id]);
  useWorkbenchEvents(event => { if (active && (event.type === 'workbench.connected' || event.type === 'reading.changed')) void refresh(); });
  async function create() {
    setBusy(true); setError(''); createCommand.current ??= crypto.randomUUID();
    try { const target = await createCollectionTarget(createCommand.current, title); setTargetId(target.id); setCreating(false); createCommand.current = null; setTitle(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function copy(item: ReadingCollectionItem) {
    try { await navigator.clipboard.writeText(`${item.body}\n\n原文：${item.reference.text}\n来源：《${item.bookTitle}》 · ${item.reference.version} · ${item.reference.start.chapterId}/${item.reference.start.paragraphId}:${item.reference.start.offset}–${item.reference.end.paragraphId}:${item.reference.end.offset}${item.discussion ? `\n讨论：${item.discussion.sessionId}/${item.discussion.piEntryId}` : ''}`); }
    catch { setError('复制失败，请重试。'); }
  }
  return <section className="reading-collection-page"><nav aria-label="笔记接收目标">{targets.map(t => <button key={t.id} aria-current={targetId === t.id ? 'true' : undefined} onClick={() => setTargetId(t.id)}>{t.title}</button>)}<button className="reading-command" onClick={() => setCreating(true)}><Plus size={16} />新建目标</button></nav><div className="reading-collection-items">{error && <p role="alert">{error}</p>}{!items.length && <p>暂无收集内容</p>}{items.map(item => <article className="reading-collected-item" key={item.id}><header><strong>{item.bookTitle}</strong><small>{item.kind === 'companion' ? '书伴解释' : item.kind === 'reading-note' ? '阅读笔记' : '原文摘录'}</small><button className="reading-command" title="复制并保留来源" aria-label="复制并保留来源" onClick={() => void copy(item)}><Copy size={16} /></button></header><p>{item.body}</p>{item.kind !== 'excerpt' && <blockquote>{item.reference.text}</blockquote>}<BookReferenceLink reference={item.reference} /><small>{new Date(item.createdAt).toLocaleString()}</small></article>)}</div>
    {creating && <ConfirmCard title="新建笔记接收目标" confirmLabel="创建" busy={busy} error={error} confirmDisabled={!title.trim()} onCancel={() => { setCreating(false); createCommand.current = null; }} onConfirm={() => void create()}><label>目标名称<input aria-label="目标名称" value={title} disabled={Boolean(createCommand.current)} maxLength={100} onChange={event => setTitle(event.target.value)} /></label></ConfirmCard>}
  </section>;
}
