import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app.js';
import { ConfirmProvider } from './components/confirm-card.js';
import { AssistantSessionsProvider } from './features/assistant/assistant-session.js';
import { AuthorizationGrantsProvider } from './features/authorizations/authorization-grants-provider.js';
import { GlobalEventsProvider } from './features/events/global-events-provider.js';
import { ProposalsProvider } from './features/proposals/proposals-provider.js';
import { WorkbenchSyncProvider } from './features/workbench/workbench-sync-provider.js';
import { WorkspaceSessionsProvider } from './features/workspace/workspace-sessions-provider.js';
import './styles/base.css';
import { TaskRequestsProvider } from './features/tasks/task-requests-provider.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 每个窗口只有一条全局事件流：所有会话的流式事件与工作台变更都经它送达，按会话分发。 */}
    <GlobalEventsProvider>
      <ConfirmProvider>
        {/* 工作会话列表在应用内只有一份，工作区与管理中的页面共用。 */}
        <WorkspaceSessionsProvider>
          {/* 记住的授权在应用内只有一份：项目详情、会话授权窗口与标题栏的工作目录浮层共用，撤销后三处同时更新。 */}
          <AuthorizationGrantsProvider>
            {/* 全局 Multivac 对话内的提议（确认卡）只有一份：首页与侧栏中的同一张卡状态一致。 */}
            <ProposalsProvider>
              {/* 别处（其他窗口、Multivac）的变化经全局事件流中的工作台变更写回上面几份共享列表，现场交给工作区按版本应用。 */}
              <WorkbenchSyncProvider>
                {/* 会话状态全局唯一：首页、工作区、Multivac 侧栏与管理共用，外壳也据此判断侧栏的去留。 */}
                <AssistantSessionsProvider>
                  <TaskRequestsProvider><App /></TaskRequestsProvider>
                </AssistantSessionsProvider>
              </WorkbenchSyncProvider>
            </ProposalsProvider>
          </AuthorizationGrantsProvider>
        </WorkspaceSessionsProvider>
      </ConfirmProvider>
    </GlobalEventsProvider>
  </StrictMode>,
);
