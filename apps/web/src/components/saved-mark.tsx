import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** “已保存”标记停留多久：与 `.saved-mark` 的淡出动画同长（按原型约 1.6 秒）。 */
export const SAVED_MARK_DURATION_MS = 1600;

/** 最近一次保存成功的是哪一处；stamp 每次保存递增，用于让重复保存时标记重新出现。 */
export interface SavedFlash<K extends string> {
  savedKey: K | null;
  stamp: number;
  /** 标记某一处刚保存成功：这一处显示“已保存”，到时自动消失；再次调用重新计时。 */
  flash: (key: K) => void;
}

/**
 * 管理各页“修改成功”的反馈：一页一个，按 key 区分是哪一处（如项目的名称、目录、默认约束）。
 * 同一时刻只标记最近保存的那一处，与原型的 useSavedFlash 一致。
 */
export function useSavedFlash<K extends string>(): SavedFlash<K> {
  const [saved, setSaved] = useState<{ key: K | null; stamp: number }>({ key: null, stamp: 0 });
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flash = useCallback((key: K) => {
    setSaved((current) => ({ key, stamp: current.stamp + 1 }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved((current) => ({ ...current, key: null })), SAVED_MARK_DURATION_MS);
  }, []);

  return { savedKey: saved.key, stamp: saved.stamp, flash };
}

/**
 * 修改成功后放在小节标题、名称或按钮旁的“✓ 已保存”，约 1.6 秒后淡出
 * （偏好减少动效时不做淡出，到时直接消失）。只在 target 是最近保存的那一处时出现。
 */
export function SavedMark<K extends string>({ saved, target }: { saved: SavedFlash<K>; target: K }) {
  if (saved.savedKey !== target) return null;
  return (
    // 按 stamp 重新挂载：连续保存同一处时淡出动画从头开始。
    <span key={saved.stamp} className="saved-mark" role="status">
      <Check aria-hidden="true" />
      已保存
    </span>
  );
}
