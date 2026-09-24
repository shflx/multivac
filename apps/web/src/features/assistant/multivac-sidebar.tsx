import { Orbit, PanelRightClose } from 'lucide-react';
import { AssistantView } from './assistant-view.js';

interface MultivacSidebarProps {
  active: boolean;
  onCollapse: () => void;
  onManageModels: () => void;
}

/**
 * 管理模式右侧停靠的 Multivac 侧栏。
 *
 * 与首页是同一个会话：消息、草稿、引用、运行状态和选模都来自共享的会话控制器，
 * 这里只是另一个紧凑形态的呈现实例。
 */
export function MultivacSidebar({ active, onCollapse, onManageModels }: MultivacSidebarProps) {
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
      <AssistantView variant="sidebar" active={active} onManageModels={onManageModels} />
    </aside>
  );
}
