import { Orbit, PanelRightClose } from 'lucide-react';
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
  /** 当前正在看的工作区会话，作为发送时的上下文。 */
  context?: { sessionId: string; title: string } | null;
  /** 从工作会话交给 Multivac 的引用。 */
  incomingQuote?: { id: number; quote: AssistantQuote } | null;
  onIncomingQuoteHandled?: () => void;
}

/**
 * 停靠在右侧的 Multivac 侧栏（管理与工作区共用）。
 *
 * 与首页是同一个会话：消息、草稿、引用、运行状态和选模都来自共享的会话控制器，
 * 这里只是另一个紧凑形态的呈现实例。
 */
export function MultivacSidebar({
  active, collapsed = false, onCollapse, onExpand, onManageModels, context = null,
  incomingQuote = null, onIncomingQuoteHandled,
}: MultivacSidebarProps) {
  // 收起时授权卡不可见：窄轨入口提示 Multivac 正在等你授权，展开后就地处理。
  const global = useAssistantSession();
  const awaitingAuthorization = global !== undefined &&
    pendingAuthorizations(global.session.authorizations).length > 0;

  if (collapsed) {
    const label = awaitingAuthorization ? '展开 Multivac（等待你的授权）' : '展开 Multivac';
    return (
      <aside className="multivac-sidebar collapsed" aria-label="Multivac 侧栏">
        <button
          type="button"
          className="icon-button multivac-sidebar-expand"
          aria-label={label}
          title={label}
          onClick={onExpand}
        >
          <Orbit aria-hidden="true" />
          {awaitingAuthorization && <span className="attention-dot" aria-hidden="true" />}
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
