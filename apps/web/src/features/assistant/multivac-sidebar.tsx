import { Orbit, PanelRightClose } from 'lucide-react';
import type { AssistantQuote } from '@multivac/contracts';
import { AssistantView } from './assistant-view.js';

interface MultivacSidebarProps {
  active: boolean;
  /** 收起为 44px 窄轨（工作区）；管理模式里收起即隐藏，由外层决定是否渲染。 */
  collapsed?: boolean;
  onCollapse: () => void;
  onExpand?: () => void;
  onManageModels: () => void;
  /** 当前正在看的工作区会话，作为发送时的上下文。 */
  context?: { sessionId: string; title: string } | null;
  /** 从工作会话交给 Multivac 的引用。 */
  incomingQuote?: { id: number; quote: AssistantQuote } | null;
  onIncomingQuoteHandled?: () => void;
}

/**
 * 停靠在右侧的 Multivac 侧栏（管理模式与工作区共用）。
 *
 * 与首页是同一个会话：消息、草稿、引用、运行状态和选模都来自共享的会话控制器，
 * 这里只是另一个紧凑形态的呈现实例。
 */
export function MultivacSidebar({
  active, collapsed = false, onCollapse, onExpand, onManageModels, context = null,
  incomingQuote = null, onIncomingQuoteHandled,
}: MultivacSidebarProps) {
  if (collapsed) {
    return (
      <aside className="multivac-sidebar collapsed" aria-label="Multivac 侧栏">
        <button
          type="button"
          className="icon-button multivac-sidebar-expand"
          aria-label="展开 Multivac"
          title="展开 Multivac"
          onClick={onExpand}
        >
          <Orbit aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="multivac-sidebar" aria-label="Multivac 侧栏">
      <header>
        <div>
          <Orbit aria-hidden="true" />
          <span>
            <strong>Multivac</strong>
            <small>与首页是同一个对话</small>
          </span>
        </div>
        <button
          type="button"
          className="multivac-sidebar-collapse"
          aria-label="收起 Multivac"
          title="收起 Multivac"
          onClick={onCollapse}
        >
          <PanelRightClose aria-hidden="true" />
        </button>
      </header>
      <AssistantView
        variant="sidebar"
        active={active}
        context={context}
        incomingQuote={incomingQuote}
        {...(onIncomingQuoteHandled ? { onIncomingQuoteHandled } : {})}
        onManageModels={onManageModels}
      />
    </aside>
  );
}
