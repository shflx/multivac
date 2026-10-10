/** 返回到原位置时，同时保留焦点来自鼠标还是键盘，避免快捷键把背景元素变成键盘选中态。 */
export interface FocusReturn {
  element: HTMLElement;
  visible: boolean;
}

const POINTER_RETURN_ATTRIBUTE = 'data-pointer-focus-return';
let clearPointerReturn: (() => void) | null = null;

export function captureFocusReturn(element: Element | null = document.activeElement): FocusReturn | null {
  if (!(element instanceof HTMLElement)) return null;
  return { element, visible: element.matches(':focus-visible') && !element.hasAttribute(POINTER_RETURN_ATTRIBUTE) };
}

export function restoreFocusReturn(target: FocusReturn | null): boolean {
  if (!target?.element.isConnected || !target.element.checkVisibility()) return false;
  clearPointerReturn?.();
  const { element, visible } = target;
  if (!visible) {
    // 只抑制恢复时的描边；下一次键盘导航清除标记，继续使用组件原有的焦点提示。
    element.setAttribute(POINTER_RETURN_ATTRIBUTE, '');
    const clear = () => {
      element.removeAttribute(POINTER_RETURN_ATTRIBUTE);
      element.removeEventListener('blur', clear);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', navigate, true);
      clearPointerReturn = null;
    };
    const navigate = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey &&
          ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '].includes(event.key)) clear();
    };
    const pointer = (event: PointerEvent) => {
      // 再次点击同一个已聚焦元素未必触发 focus 事件，保留标记，避免旧键盘状态重新露出描边。
      if (!(event.target instanceof Node) || !element.contains(event.target)) clear();
    };
    element.addEventListener('blur', clear);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', navigate, true);
    clearPointerReturn = clear;
  }
  element.focus({ preventScroll: true });
  const focused = document.activeElement === element;
  if (!focused) clearPointerReturn?.();
  return focused;
}
