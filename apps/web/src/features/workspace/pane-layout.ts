/** 并排时每栏的最小宽度（px）；放不下时工作区横向滚动。 */
export const MIN_PANE_WIDTH = 320;

/** 只调整分隔线相邻的两栏，保留两栏总宽与其他栏的宽度。 */
export function resizePair(widths: readonly number[], index: number, delta: number): number[] {
  if (index < 0 || index >= widths.length - 1) return [...widths];
  const total = widths[index]! + widths[index + 1]!;
  const minimum = Math.min(MIN_PANE_WIDTH, total / 2);
  const left = Math.max(minimum, Math.min(total - minimum, widths[index]! + delta));
  return widths.map((width, position) => position === index ? left : position === index + 1 ? total - left : width);
}

/**
 * 调整第 index 与 index + 1 栏之间的分隔线。
 * 放得下时两栏此消彼长、总宽不变；放不下（已横向滚动）时只调整左侧这一栏，
 * 右侧各栏随之平移，否则所有栏都卡在最小宽度上无法调整。
 */
export function resizeColumns(widths: readonly number[], index: number, delta: number, overflowing: boolean): number[] {
  if (!overflowing) return resizePair(widths, index, delta);
  if (index < 0 || index >= widths.length - 1) return [...widths];
  return widths.map((width, position) => position === index ? Math.max(MIN_PANE_WIDTH, width + delta) : width);
}

/**
 * 网格列定义：未调整过为等宽；保存的列宽按比例铺满，总和超出可用宽度时按像素排布并横向滚动。
 * 每栏都不小于最小宽度。
 */
export function gridColumns(count: number, widths: readonly number[] | undefined, available: number): string {
  if (!widths || widths.length !== count) return Array.from({ length: count }, () => `minmax(${MIN_PANE_WIDTH}px, 1fr)`).join(' ');
  const total = widths.reduce((sum, width) => sum + width, 0) + widths.length - 1;
  return total > available
    ? widths.map((width) => `${Math.max(MIN_PANE_WIDTH, Math.round(width))}px`).join(' ')
    : widths.map((width) => `minmax(${MIN_PANE_WIDTH}px, ${width}fr)`).join(' ');
}

/** 可访问性数值：分隔线左侧一栏在相邻两栏中的占比（百分数），未调整过为 50。 */
export function pairPercent(widths: readonly number[] | undefined, index: number): number {
  const left = widths?.[index];
  const right = widths?.[index + 1];
  if (left === undefined || right === undefined) return 50;
  return Math.round(left / (left + right) * 100);
}
