/** 模态层内可以用 Tab 到达的元素。 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

/**
 * Tab 在模态层内循环：返回需要改由程序聚焦的下标；返回 null 时交给浏览器按顺序移动。
 *
 * - index 是当前焦点在可聚焦元素中的下标，-1 表示焦点不在其中（例如落在卡片容器上）。
 * - 从最后一个再 Tab 回到第一个，从第一个 Shift+Tab 回到最后一个。
 * - count 为 0 时返回 -1：没有可聚焦元素，调用方应阻止 Tab 把焦点带出模态层。
 */
export function wrapFocusIndex(count: number, index: number, backwards: boolean): number | null {
  if (count === 0) return -1;
  if (index < 0) return backwards ? count - 1 : 0;
  if (backwards && index === 0) return count - 1;
  if (!backwards && index === count - 1) return 0;
  return null;
}
