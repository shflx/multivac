import { Layers, Orbit, PanelLeftClose, PanelRight } from 'lucide-react';
import type { AssistantQuote } from '@multivac/contracts';
import { AssistantView } from './assistant-view.js';
import type { MultivacFocus } from './multivac-focus.js';

/**
 * 叫出或收起侧栏的快捷键：⌘J / Ctrl+J（与 ⌘\ / Ctrl+\ 切换工作区条互不冲突），工作区与管理相同。
 * 由应用外壳统一监听；这里只用于提示文字（hint）与 aria-keyshortcuts 的写法（keys）。
 */
export const MULTIVAC_SIDEBAR_SHORTCUT = {
  hint: /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘J' : 'Ctrl+J',
  keys: 'Meta+J Control+J',
};

/** 侧栏与页面并排（挤压页面）还是浮在页面上（覆盖页面右侧、不改变页面排版）。 */
export type SidebarDock = 'push' | 'overlay';

/** 并排 / 浮层只记在本机：刷新后保持，不随账号或服务端同步。 */
const SIDEBAR_DOCK_STORAGE_KEY = 'multivac.sidebar.dock';
/** 旧版把工作区侧栏的开合记在本机；开合现在不持久化，遗留的记录清掉。 */
const LEGACY_SIDEBAR_STORAGE_KEY = 'multivac.workspace.multivac-sidebar';

export function rememberedSidebarDock(): SidebarDock {
  try {
    return localStorage.getItem(SIDEBAR_DOCK_STORAGE_KEY) === 'overlay' ? 'overlay' : 'push';
  } catch {
    return 'push';
  }
}

export function rememberSidebarDock(dock: SidebarDock): void {
  try {
    localStorage.setItem(SIDEBAR_DOCK_STORAGE_KEY, dock);
  } catch {
    // 本机存储不可用时只在本页生效。
  }
}

export function forgetLegacySidebarState(): void {
  try {
    localStorage.removeItem(LEGACY_SIDEBAR_STORAGE_KEY);
  } catch {
    // 本机存储不可用时没有需要清理的记录。
  }
}

interface MultivacSidebarProps {
  /** 侧栏是否正在显示（已展开，且当前面板是工作区或管理）。 */
  visible: boolean;
  dock: SidebarDock;
  onDockChange: (dock: SidebarDock) => void;
  onCollapse: () => void;
  onManageModels: () => void;
  /** 叫出或收起侧栏的快捷键：hint 用于提示文字，keys 为 aria-keyshortcuts 的写法。 */
  shortcut?: { hint: string; keys: string };
  /** 当前面板正在看的对象（工作区的焦点会话），作为发送时的上下文。 */
  context?: MultivacFocus | null;
  /** 交给 Multivac 的引用。 */
  incomingQuote?: { id: number; quote: AssistantQuote } | null;
  onIncomingQuoteHandled?: () => void;
  /** 请求把焦点交给侧栏输入区（明确叫出侧栏时）；数值变化即一次新的请求。 */
  focusRequest?: number;
}

/**
 * Multivac 侧栏：工作区与管理共用的同一个呈现实例，停靠在当前面板右侧。
 *
 * 与首页是同一个会话：消息、草稿、引用、运行状态和选模都来自共享的会话控制器，
 * 这里只是另一个紧凑形态的呈现实例。收起时不留窄轨，只经 ⌘J、“?”菜单或顶栏的授权提示叫出；
 * 收起、切换面板与切换并排 / 浮层都只改变显示，呈现保持挂载，阅读位置与上次的焦点位置都还在。
 */
export function MultivacSidebar({
  visible, dock, onDockChange, onCollapse, onManageModels, shortcut, context = null, incomingQuote = null,
  onIncomingQuoteHandled, focusRequest,
}: MultivacSidebarProps) {
  const overlay = dock === 'overlay';
  const hint = shortcut ? `（${shortcut.hint}）` : '';
  const dockLabel = overlay ? '改为与页面并排' : '改为浮在页面上';

  return (
    <aside className={`multivac-sidebar${overlay ? ' floating' : ''}`} aria-label="Multivac 侧栏" hidden={!visible}>
      <header>
        <div>
          <Orbit aria-hidden="true" />
          <span>
            <strong>Multivac</strong>
            <small>与首页是同一个对话 · 开始干活即收起</small>
          </span>
        </div>
        <div className="multivac-sidebar-tools">
          {/* 并排会挤窄页面，浮层不动页面但会盖住右侧一部分，按当下的内容切换。 */}
          <button
            type="button"
            className="multivac-sidebar-tool"
            aria-label={dockLabel}
            title={dockLabel}
            onClick={() => onDockChange(overlay ? 'push' : 'overlay')}
          >
            {overlay ? <PanelRight aria-hidden="true" /> : <Layers aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="multivac-sidebar-tool"
            aria-label="收起 Multivac"
            aria-keyshortcuts={shortcut?.keys}
            title={`收起 Multivac${hint}`}
            onClick={onCollapse}
          >
            <PanelLeftClose aria-hidden="true" />
          </button>
        </div>
      </header>
      <AssistantView
        variant="sidebar"
        active={visible}
        context={context}
        incomingQuote={incomingQuote}
        {...(onIncomingQuoteHandled ? { onIncomingQuoteHandled } : {})}
        {...(focusRequest !== undefined ? { focusRequest } : {})}
        onManageModels={onManageModels}
      />
    </aside>
  );
}
