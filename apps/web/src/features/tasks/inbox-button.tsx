import { useEffect, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import type { InboxItem } from '@multivac/contracts';
import { useTaskRequests } from './task-requests-provider.js';

interface InboxButtonProps {
  open: boolean;
  /** Inbox 抽屉或管理页 Inbox 正在显示：列表正常更新，不再提示。 */
  inboxVisible: boolean;
  /** 当前正显示的会话：其中的请求已在对话里就地出现，不重复提示。 */
  visibleSessionIds: readonly string[];
  onClick: () => void;
}

/**
 * 顶栏 Inbox 入口。确有新增待处理项时，右上角的数字放大并向外扩一圈，连闪三下（约 4.5 秒）并播报一次，
 * 之后保留静态光晕直到打开 Inbox；
 * 页面在后台时先记下，切回后若仍待处理再合并提示。减少动态效果时只播报、不闪。
 */
export function InboxButton({ open, inboxVisible, visibleSessionIds, onClick }: InboxButtonProps) {
  const { pendingCount, items, arrival } = useTaskRequests();
  const badge = useRef<HTMLSpanElement>(null);
  const waiting = useRef(new Map<string, InboxItem>());
  const [announcement, setAnnouncement] = useState('');
  // 闪完到打开 Inbox 之前，角标保留一圈静态光晕，表示有尚未查看的新增。
  const [fresh, setFresh] = useState(false);
  const latest = useRef({ items, inboxVisible, visibleSessionIds });
  latest.current = { items, inboxVisible, visibleSessionIds };
  const notifyRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let clear: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      const { items: current, inboxVisible: visible, visibleSessionIds: sessions } = latest.current;
      const arrived = [...waiting.current.values()].filter((item) =>
        current.some((value) => value.id === item.id && value.status === 'pending') && !(item.sessionId && sessions.includes(item.sessionId)));
      waiting.current.clear();
      if (visible || !arrived.length) return;
      setFresh(true);
      setAnnouncement(`Inbox 新增 ${arrived.length} 项待处理`);
      clearTimeout(clear);
      clear = setTimeout(() => setAnnouncement(''), 3000);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      // 上一次还在闪时不叠加，连续到达合并为一次。
      const target = badge.current;
      if (!target || target.getAnimations().some((animation) => animation.playState === 'running')) return;
      // 三下、每下约 1.5 秒，总长控制在 5 秒内；起止都落在静态光晕上，结束时不跳变。
      const rest = { transform: 'scale(1)', boxShadow: 'var(--inbox-fresh-halo)' };
      const peak = { transform: 'scale(1.3)', boxShadow: '0 0 0 8px transparent' };
      target.animate([rest, peak, rest, peak, rest, peak, rest], { duration: 4500, easing: 'ease-in-out' });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') notify(); };
    document.addEventListener('visibilitychange', onVisible);
    notifyRef.current = () => { if (document.visibilityState === 'visible') notify(); };
    return () => { document.removeEventListener('visibilitychange', onVisible); clearTimeout(clear); notifyRef.current = () => undefined; };
  }, []);

  useEffect(() => { if (inboxVisible || pendingCount === 0) setFresh(false); }, [inboxVisible, pendingCount]);

  useEffect(() => {
    if (!arrival.seq) return;
    for (const item of arrival.items) waiting.current.set(item.id, item);
    notifyRef.current();
  }, [arrival]);

  return <>
    <button className="shell-inbox" title={`Inbox · ${pendingCount} 项待处理`} aria-label={`Inbox，${pendingCount} 项待处理`} aria-haspopup="dialog" aria-expanded={open} onClick={onClick}>
      <Inbox aria-hidden="true" />
      {pendingCount > 0 && <span ref={badge} className={fresh ? 'inbox-count fresh' : 'inbox-count'} aria-hidden="true">{pendingCount}</span>}
    </button>
    <span className="sr-only" aria-live="polite">{announcement}</span>
  </>;
}
