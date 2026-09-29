import { useEffect, useRef } from 'react';
import { startsWork } from '../features/assistant/sidebar-collapse.js';

/** 用户按下或按 Tab 之后多久之内的焦点变化，算作用户自己把焦点移过去的。 */
const USER_FOCUS_WINDOW_MS = 1000;

/**
 * 按下的位置所属的输入区域：点在输入区本身，或点在会话输入区里（如折叠输入区的“继续当前工作…”，
 * 按下后输入区展开、下一帧才把焦点交给输入框）。
 */
function pointerRegion(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.assistant-composer') ?? target;
}

/**
 * 监听“开始在页面里干活”：用户在工作面（工作区或管理页）里点进、或用 Tab 移进输入框与编辑器（见 startsWork）。
 *
 * 只认用户自己把焦点移进去的：按下的位置就是这个输入框（或它的标签、所在的会话输入区），
 * 或者刚按过 Tab。程序移动的焦点不算，例如切换面板或点选会话时工作区把焦点交给当前会话的输入区、
 * 关闭弹层后焦点回到触发元素。经 portal 渲染到工作面之外的确认卡不属于工作面，其中的输入框不算。
 */
export function useWorkStarted(surfaces: () => readonly (Element | null)[], onWorkStarted: () => void): void {
  const surfacesRef = useRef(surfaces);
  surfacesRef.current = surfaces;
  const onWorkStartedRef = useRef(onWorkStarted);
  onWorkStartedRef.current = onWorkStarted;

  useEffect(() => {
    let pointer: { region: Element | null; label: HTMLLabelElement | null; at: number } | null = null;
    let tabAt = Number.NEGATIVE_INFINITY;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      pointer = { region: pointerRegion(target), label: target?.closest('label') ?? null, at: performance.now() };
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') tabAt = performance.now();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !startsWork(target)) return;
      if (!surfacesRef.current().some((surface) => surface?.contains(target))) return;
      const now = performance.now();
      const clicked = pointer !== null && now - pointer.at <= USER_FOCUS_WINDOW_MS &&
        (pointer.region?.contains(target) === true || pointer.label?.control === target);
      const tabbed = now - tabAt <= USER_FOCUS_WINDOW_MS;
      if (clicked || tabbed) onWorkStartedRef.current();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);
}
