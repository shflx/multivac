import { useCallback, useRef, useState } from 'react';
import { emptyReading, readingStorageKey, restoreReading, type ReadingScene } from './reading-scene.js';

export type UpdateReading = (change: (scene: ReadingScene) => ReadingScene) => void;

export function useReadingScene(workspaceId: string, sessionId: string, root: string): [ReadingScene, UpdateReading] {
  const key = readingStorageKey(workspaceId, sessionId);
  const load = () => { try { return restoreReading(localStorage.getItem(key), root); } catch { return emptyReading(root); } };
  const [stored, setStored] = useState(() => ({ key, scene: load() }));
  let scene = stored.scene;
  if (stored.key !== key || scene.root !== root) {
    scene = load();
    setStored({ key, scene });
  }
  const latest = useRef({ key, scene });
  latest.current = { key, scene };
  const update = useCallback<UpdateReading>((change) => {
    const current = latest.current;
    const base = current.key === key && current.scene.root === root ? current.scene : load();
    const next = { key, scene: change(base) };
    // 先落盘再请求呈现切换；父布局在同一事件中卸载此实例也不会丢失更新。
    latest.current = next;
    try { localStorage.setItem(key, JSON.stringify(next.scene)); } catch { /* 存储不可用时仍保留本次页面的阅读现场。 */ }
    setStored(next);
  }, [key, root]);
  return [scene, update];
}
