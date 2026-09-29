import { useSyncExternalStore } from 'react';

/**
 * 窄屏的判定（与原型一致）：视口不超过 760px。窄屏只保留 Multivac 首页，
 * 工作区与管理改为“请在桌面使用”的提示，不做窄屏自适应排版。
 */
export const NARROW_VIEWPORT_QUERY = '(max-width: 760px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

/** 当前视口是否为窄屏，随窗口宽度变化实时更新。 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
