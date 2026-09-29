import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app.js';
import { ConfirmProvider } from './components/confirm-card.js';
import { AssistantSessionsProvider } from './features/assistant/assistant-session.js';
import { WorkspaceSessionsProvider } from './features/workspace/workspace-sessions-provider.js';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmProvider>
      {/* 工作会话列表在应用内只有一份，工作区与管理中的页面共用。 */}
      <WorkspaceSessionsProvider>
        {/* 会话状态全局唯一：首页、工作区、Multivac 侧栏与管理共用，外壳也据此判断侧栏的去留。 */}
        <AssistantSessionsProvider>
          <App />
        </AssistantSessionsProvider>
      </WorkspaceSessionsProvider>
    </ConfirmProvider>
  </StrictMode>,
);
