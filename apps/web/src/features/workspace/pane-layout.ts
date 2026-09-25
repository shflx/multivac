/** 并排时每栏的最小宽度（px）；总宽不足两倍时两栏均分。 */
export const MIN_PANE_WIDTH = 320;
/** 默认两栏等宽。 */
export const DEFAULT_SPLIT = 0.5;

/** 把左栏占比夹在合法范围内；非有限值回退为等宽。 */
export function clampSplit(split: number, totalWidth: number): number {
  if (!Number.isFinite(split)) return DEFAULT_SPLIT;
  if (!(totalWidth > 0)) return Math.min(1, Math.max(0, split));
  const minimum = Math.min(MIN_PANE_WIDTH, totalWidth / 2) / totalWidth;
  return Math.min(1 - minimum, Math.max(minimum, split));
}

/**
 * 拖动或键盘调整分隔线：按像素位移计算新的左栏占比，两栏都不小于最小宽度。
 * 只调整相邻两栏，总宽度不变。
 */
export function resizeSplit(split: number, totalWidth: number, deltaPx: number): number {
  if (!(totalWidth > 0)) return clampSplit(split, totalWidth);
  return clampSplit(split + deltaPx / totalWidth, totalWidth);
}

/** 可访问性数值：左栏占比的百分数。 */
export function splitPercent(split: number): number {
  return Math.round(split * 100);
}
