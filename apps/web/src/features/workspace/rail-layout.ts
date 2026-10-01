/** 与原型一致：每栏至少留 360px 阅读空间，停靠导航占 240px。 */
export const WORKSPACE_RAIL_WIDTH = 240;
export const WORKSPACE_READABLE_COLUMN_WIDTH = 360;
export function railIsCrowded(width: number, columns: number): boolean {
  return (width - WORKSPACE_RAIL_WIDTH) / columns < WORKSPACE_READABLE_COLUMN_WIDTH;
}
export const RAIL_STORAGE_KEY = 'multivac.workspace.rail';
export function rememberedRailOpen(): boolean {
  try { return localStorage.getItem(RAIL_STORAGE_KEY) !== 'closed'; }
  catch { return true; }
}
