/**
 * 应用外壳的面板与快捷键：面板跳转（⌘G / Ctrl+G）、Multivac 侧栏（⌘J / Ctrl+J）与工作区、管理中的 Esc。
 *
 * 这里集中放按键规则；按键监听与界面在 App、PanelSwitcher、ShortcutHelp 中。
 */

/** 三个面板：Multivac 首页、工作区与管理。管理叠在进入前的面板之上，离开即回到那里。 */
export type ShellPanel = 'assistant' | 'workspace' | 'management';

/** 面板跳转中的顺序，也是数字键 1–3 对应的面板。 */
export const PANEL_ORDER: readonly ShellPanel[] = ['assistant', 'workspace', 'management'];

/** 外壳级快捷键：打开面板跳转，或叫出 / 收起 Multivac 侧栏。 */
export type ShellShortcut = 'panel-switcher' | 'multivac-sidebar';

/** 判断按键所需的字段（取自 KeyboardEvent）。 */
export interface ShortcutKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 按下的是否为外壳级快捷键。
 *
 * ⌘ 与 Ctrl 在各系统上都认（与工作区已有的 ⌘J、⌘\ 一致）；带 Alt 或 Shift 的组合不算，
 * 留给浏览器（如 ⇧⌘G 查找上一个）。输入框聚焦时同样响应（与原型一致）：这两个组合在输入框里没有编辑含义。
 */
export function shellShortcut(event: ShortcutKeyInput): ShellShortcut | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'g') return 'panel-switcher';
  if (key === 'j') return 'multivac-sidebar';
  return null;
}

/** 面板跳转打开时默认选中“下一个”面板：⌘G 后直接回车即可切换。 */
export function defaultPanelIndex(current: ShellPanel): number {
  return (PANEL_ORDER.indexOf(current) + 1) % PANEL_ORDER.length;
}

/** 在面板之间循环移动选中项（step 为 1 或 -1）。 */
export function stepPanelIndex(index: number, step: number): number {
  return (index + step + PANEL_ORDER.length) % PANEL_ORDER.length;
}

/** 数字键 1–3 直接跳到对应面板；其他按键返回 null。 */
export function panelForDigit(key: string): ShellPanel | null {
  if (!/^[1-9]$/u.test(key)) return null;
  return PANEL_ORDER[Number(key) - 1] ?? null;
}

/** 快捷键的修饰键按系统显示：macOS 与 iOS 用 ⌘，其余用 Ctrl。 */
export function modifierKeyLabel(platform: string): string {
  return /Mac|iPhone|iPad/u.test(platform) ? '⌘' : 'Ctrl';
}

/**
 * 自己处理 Esc 的层：确认卡等模态层、面板跳转、“?”菜单、模型选择菜单，以及各种弹出菜单与说明浮层。
 * 这些层打开（且可见）时，Esc 只作用于它们。
 */
const ESCAPE_LAYER_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="menu"]',
  '.model-selector-menu',
].join(', ');

/** 输入控件：其中的 Esc 只作用于自身（如取消改名），不收起侧栏、也不离开管理。 */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * 工作区与管理中的 Esc 是否应交给外壳（先收起侧栏，在管理中再离开管理）。以下情况不交给外壳：
 * - 已被别处处理（defaultPrevented）；
 * - 有可见的弹层（见 ESCAPE_LAYER_SELECTOR）：隐藏面板里遗留的弹层不算，否则会让 Esc 永远失效；
 * - 焦点在输入控件里。
 * 在自身 onKeyDown 里处理 Esc 并阻止冒泡的弹层（确认卡、改名输入框等）根本不会走到这里。
 */
export function shellOwnsEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (event.target instanceof Element && event.target.closest(EDITABLE_SELECTOR)) return false;
  const layers = document.querySelectorAll(ESCAPE_LAYER_SELECTOR);
  return ![...layers].some((layer) => layer.checkVisibility());
}
