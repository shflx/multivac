import { Orbit, PanelRightClose } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { AssistantQuote } from '@multivac/contracts';
import { AssistantView } from './assistant-view.js';
import { useAssistantSession } from './assistant-session.js';
import { pendingAuthorizations } from './tool-authorizations.js';

interface MultivacSidebarProps {
  active: boolean;
  /** 收起为 44px 窄轨（工作区）；管理中收起即隐藏，由外层决定是否渲染。 */
  collapsed?: boolean;
  onCollapse: () => void;
  onExpand?: () => void;
  onManageModels: () => void;
  /** 标题下的说明：侧栏在这里的用法。 */
  note?: string;
  /** 叫出或收起侧栏的快捷键：hint 用于提示文字，keys 为 aria-keyshortcuts 的写法。 */
  shortcut?: { hint: string; keys: string };
  /** 当前正在看的工作区会话，作为发送时的上下文。 */
  context?: { sessionId: string; title: string } | null;
  /** 从工作会话交给 Multivac 的引用。 */
  incomingQuote?: { id: number; quote: AssistantQuote } | null;
  onIncomingQuoteHandled?: () => void;
  /** 请求把焦点交给侧栏输入区（明确叫出侧栏时）；数值变化即一次新的请求。 */
  focusRequest?: number;
}

/**
 * 停靠在右侧的 Multivac 侧栏（管理与工作区共用）。
 *
 * 与首页是同一个会话：消息、草稿、引用、运行状态和选模都来自共享的会话控制器，
 * 这里只是另一个紧凑形态的呈现实例。
 *
 * 工作区里收起为窄轨时，会话呈现保持挂载、只是不显示：再次展开时阅读位置、
 * 选区之外的界面状态和上次的焦点位置都还在。
 */
export function MultivacSidebar({
  active, collapsed = false, onCollapse, onExpand, onManageModels, note = '与首页是同一个对话',
  shortcut, context = null, incomingQuote = null, onIncomingQuoteHandled, focusRequest,
}: MultivacSidebarProps) {
  // 收起时授权卡不可见：窄轨入口提示 Multivac 正在等你授权，展开后就地处理。
  const global = useAssistantSession();
  const awaitingAuthorization = global !== undefined &&
    pendingAuthorizations(global.session.authorizations).length > 0;
  const rootRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  // 收起按钮随收起卸载，焦点会先落到页面根上，因此在按下时就记下要把焦点交给窄轨入口。
  const focusRailRef = useRef(false);

  // 焦点在侧栏里时收起（收起按钮、快捷键）：焦点交给窄轨入口，不落到页面根上。
  useLayoutEffect(() => {
    if (!collapsed) return;
    const focused = document.activeElement;
    if (focusRailRef.current || (focused && focused !== expandRef.current && rootRef.current?.contains(focused))) {
      expandRef.current?.focus({ preventScroll: true });
    }
    focusRailRef.current = false;
  }, [collapsed]);

  const hint = shortcut ? `（${shortcut.hint}）` : '';
  const expandLabel = awaitingAuthorization ? '展开 Multivac（等待你的授权）' : '展开 Multivac';

  return (
    <aside ref={rootRef} className={`multivac-sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Multivac 侧栏">
      {collapsed ? (
        <button
          ref={expandRef}
          type="button"
          className="icon-button multivac-sidebar-expand"
          aria-label={expandLabel}
          aria-keyshortcuts={shortcut?.keys}
          title={awaitingAuthorization ? `展开 Multivac${hint}：等待你的授权` : `展开 Multivac${hint}`}
          onClick={onExpand}
        >
          <Orbit aria-hidden="true" />
          {awaitingAuthorization && <span className="attention-dot" aria-hidden="true" />}
        </button>
      ) : (
        <header>
          <div>
            <Orbit aria-hidden="true" />
            <span>
              <strong>Multivac</strong>
              <small>{note}</small>
            </span>
          </div>
          <button
            type="button"
            className="multivac-sidebar-collapse"
            aria-label="收起 Multivac"
            aria-keyshortcuts={shortcut?.keys}
            title={`收起 Multivac${hint}`}
            onClick={() => {
              focusRailRef.current = true;
              onCollapse();
            }}
          >
            <PanelRightClose aria-hidden="true" />
          </button>
        </header>
      )}
      <AssistantView
        variant="sidebar"
        active={active && !collapsed}
        context={context}
        incomingQuote={incomingQuote}
        {...(onIncomingQuoteHandled ? { onIncomingQuoteHandled } : {})}
        {...(focusRequest !== undefined ? { focusRequest } : {})}
        onManageModels={onManageModels}
      />
    </aside>
  );
}
