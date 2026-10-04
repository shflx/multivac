import { Columns2, LayoutDashboard, type LucideIcon } from 'lucide-react';
import { MultivacIcon } from '../components/multivac-icon.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CommandPalette, PaletteFooter } from './command-palette.js';
import { MANAGEMENT_NAV, managementSummary } from './management-nav.js';
import {
  PANEL_ORDER,
  defaultPanelIndex,
  panelForDigit,
  stepPanelIndex,
  type ShellPanel,
} from './shell-shortcuts.js';
import { Keys, MOD_KEY } from './shortcut-help.js';

/** 面板跳转中的三项：名称、一句说明与图标（说明只写已实现的内容）。 */
const PANELS: Record<ShellPanel, { label: string; hint: string; icon: LucideIcon | typeof MultivacIcon }> = {
  assistant: { label: 'Multivac', hint: '和 Multivac 对话，交代与安排工作', icon: MultivacIcon },
  workspace: { label: '工作区', hint: '工作会话，并排或聚焦地干活', icon: Columns2 },
  management: { label: '管理', hint: managementSummary(MANAGEMENT_NAV), icon: LayoutDashboard },
};

interface PanelSwitcherProps {
  /** 当前所在的面板：管理叠在现场之上时算“管理”。 */
  current: ShellPanel;
  onPick: (panel: ShellPanel) => void;
  onClose: () => void;
}

/**
 * ⌘G 面板跳转：屏幕上方居中的一张小卡，列出 Multivac、工作区与管理。
 *
 * 默认选中下一个面板，所以 ⌘G 后直接回车就能切换；再按 ⌘G（⇧⌘G 反向）或上下方向键移动，
 * 数字键 1–3 直接跳，回车确认，Esc 或点空白关闭。
 *
 * 它是模态层：打开时焦点移入列表；按键在窗口捕获阶段由它先处理且不再往下传，
 * 即使焦点被下层异步抢走（如会话加载完成后输入区取得焦点），按键也不会落到下层的输入框或全局快捷键上。
 * 关闭或跳转前先把焦点还给打开前的元素，跳到别的面板后由那个面板接管焦点。
 */
export function PanelSwitcher({ current, onPick, onClose }: PanelSwitcherProps) {
  const [index, setIndex] = useState(() => defaultPanelIndex(current));
  // 打开面板跳转的元素：首次渲染时焦点还在它上面。
  const [previousFocus] = useState(() => document.activeElement);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const optionId = useId();

  // 在绘制前接管焦点：卡片一出现，按键（数字、回车）就落在列表上，不会先落到下层的输入框里。
  useLayoutEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  function restoreFocus(): void {
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }

  // 先还焦点再执行：离开管理可能弹出离开确认卡，卡片关闭后要把焦点还给原来的元素，而不是已卸载的列表。
  function pick(panel: ShellPanel): void {
    restoreFocus();
    onPick(panel);
  }

  function close(): void {
    restoreFocus();
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent): void {
    // 模态层：按键不再传给下层（Esc 离开管理、⌘J、⌘\ 等全局快捷键与输入框）；
    // 其他 ⌘ / Ctrl 组合仍交给浏览器（如刷新）。
    event.stopPropagation();
    if (!(event.metaKey || event.ctrlKey)) event.preventDefault();
    if (!dialogRef.current?.contains(document.activeElement)) listRef.current?.focus({ preventScroll: true });
    const move = (step: number) => {
      event.preventDefault();
      setIndex((value) => stepPanelIndex(value, step));
    };

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
      move(event.shiftKey ? -1 : 1);
    } else if (event.key === 'ArrowDown') {
      move(1);
    } else if (event.key === 'ArrowUp') {
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(PANEL_ORDER[index]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else {
      // 数字键直接跳；Tab 等其他按键已被拦下（卡片里只有列表一个焦点位置）。
      const panel = panelForDigit(event.key);
      if (panel) pick(panel);
    }
  }

  const keyDownRef = useRef(handleKeyDown);
  keyDownRef.current = handleKeyDown;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyDownRef.current(event);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);

  return (
    <CommandPalette title="面板跳转" onClose={close} dialogRef={dialogRef} panel>
        <header className="palette-head">
          <strong id={titleId}>跳转到</strong>
          <span><Keys keys={[MOD_KEY, 'G']} /> 换下一个</span>
        </header>
        <ul
          ref={listRef}
          className="palette-list"
          role="listbox"
          aria-label="面板"
          tabIndex={0}
          aria-activedescendant={`${optionId}-${index}`}
        >
          {PANEL_ORDER.map((panel, position) => {
            const { label, hint, icon: Icon } = PANELS[panel];
            return (
              <li
                key={panel}
                id={`${optionId}-${position}`}
                role="option"
                aria-selected={position === index}
                aria-current={panel === current ? 'true' : undefined}
                className={`palette-item${position === index ? ' selected' : ''}`}
                onMouseEnter={() => setIndex(position)}
                onClick={() => pick(panel)}
              >
                <span className="palette-icon"><Icon aria-hidden="true" /></span>
                <span className="palette-text">
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
                {panel === current ? <em>当前</em> : <kbd aria-hidden="true">{position + 1}</kbd>}
              </li>
            );
          })}
        </ul>
      <PaletteFooter panel />
    </CommandPalette>
  );
}
