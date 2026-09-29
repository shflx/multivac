import { CircleHelp } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { modifierKeyLabel } from './shell-shortcuts.js';

/** 快捷键的修饰键按系统显示：macOS 用 ⌘，其余用 Ctrl。 */
export const MOD_KEY = modifierKeyLabel(navigator.platform);

/** 键帽：把“⌘ G”这类组合键画成几枚小键。 */
export function Keys({ keys }: { keys: readonly string[] }) {
  return <span className="keys" aria-hidden="true">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>;
}

interface ShortcutHelpProps {
  /** Multivac 侧栏当前是否展开（决定条目写“显示”还是“收起”）。 */
  sidebarOpen: boolean;
  /** 当前面板能否叫出侧栏：工作区与管理可以，首页本身就是 Multivac 对话。 */
  canToggleSidebar: boolean;
  onToggleSidebar: () => void;
  onOpenPanelSwitcher: () => void;
}

/**
 * 顶栏右侧的“?”：点开列出面板跳转与 Multivac 侧栏两组快捷键，以及管理中 Esc 的用法。
 * 条目本身也是按钮，不用快捷键的人点一下即可执行。
 *
 * 点别处、按 Esc、焦点离开或按下任何 ⌘ / Ctrl 组合键（正在用快捷键）时收起。
 */
export function ShortcutHelp({ sidebarOpen, canToggleSidebar, onToggleSidebar, onOpenPanelSwitcher }: ShortcutHelpProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 只收起菜单：外壳见到菜单还开着就不处理这次 Esc（不收起侧栏、不离开管理）。
        event.preventDefault();
        if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true });
        setOpen(false);
      } else if (event.metaKey || event.ctrlKey) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /** 执行条目：先收起菜单、把焦点还给“?”，再执行（面板跳转关闭后焦点回到这里）。 */
  const run = (action: () => void) => () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    action();
  };

  return (
    <div
      ref={rootRef}
      className="shortcut-help"
      onBlur={(event) => {
        // Tab 离开菜单时收起；点别处由 pointerdown 处理。
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`icon-button shortcut-help-trigger${open ? ' active' : ''}`}
        aria-label="快捷键"
        title="快捷键"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <CircleHelp aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="shortcut-help-menu" role="dialog" aria-label="快捷键">
          <button type="button" aria-keyshortcuts="Meta+G Control+G" onClick={run(onOpenPanelSwitcher)}>
            <Keys keys={[MOD_KEY, 'G']} />
            <span>
              <strong>面板跳转</strong>
              <small>在 Multivac、工作区、管理之间切换</small>
            </span>
          </button>
          <button
            type="button"
            aria-keyshortcuts="Meta+J Control+J"
            disabled={!canToggleSidebar}
            onClick={run(onToggleSidebar)}
          >
            <Keys keys={[MOD_KEY, 'J']} />
            <span>
              <strong>{sidebarOpen && canToggleSidebar ? '收起' : '显示'} Multivac 侧栏</strong>
              <small>{canToggleSidebar ? '在工作区与管理中叫出，与首页是同一个对话' : '首页本身就是 Multivac 对话'}</small>
            </span>
          </button>
          <p className="shortcut-help-note">在管理中按 Esc 回到原来的面板</p>
        </div>
      )}
    </div>
  );
}
