import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageDays, UsageStatistics } from '@multivac/contracts';
import { getUsageStatistics } from '../../data/usage-api.js';

/** 页面保持挂载；范围变化取消旧读取，迟到结果不串范围。 */
export function useUsageStatistics(active: boolean, days: UsageDays) {
  const [data, setData] = useState<UsageStatistics | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (controller.current) return;
    const sequence = ++request.current;
    const current = new AbortController();
    controller.current = current;
    setLoading(true); setError('');
    try {
      const result = await getUsageStatistics(days, current.signal);
      if (request.current === sequence) setData(result);
    } catch (cause) {
      if (request.current === sequence && !current.signal.aborted) setError(cause instanceof Error ? cause.message : '统计读取失败，请重试');
    } finally {
      if (request.current === sequence) { controller.current = null; setLoading(false); }
    }
  }, [days]);
  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
      request.current++; controller.current?.abort(); controller.current = null;
    };
  }, [active, load]);
  return { data: data?.days === days ? data : null, error, loading, refresh: load };
}
