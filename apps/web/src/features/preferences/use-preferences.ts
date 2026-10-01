import { useEffect, useState } from 'react';
import type { Preferences } from '@multivac/contracts';
import { getPreferences } from '../../data/preferences-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

/** 偏好事件与重连共用工作台通道，所有已挂载视图及时跟随服务端。 */
export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState('');
  async function reload() {
    try { setPreferences(await getPreferences()); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '偏好读取失败。'); }
  }
  useEffect(() => { void reload(); }, []);
  useWorkbenchEvents((event) => {
    if (event.type === 'preferences.changed') setPreferences(event.preferences);
    else if (event.type === 'workbench.connected') void reload();
  });
  return { preferences, setPreferences, error, reload };
}
