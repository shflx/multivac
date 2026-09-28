import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app.js';
import { ConfirmProvider } from './components/confirm-card.js';
import { WorkspaceSessionsProvider } from './features/workspace/workspace-sessions-provider.js';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmProvider>
      {/* 工作会话列表在应用内只有一份，工作区与管理中的页面共用。 */}
      <WorkspaceSessionsProvider>
        <App />
      </WorkspaceSessionsProvider>
    </ConfirmProvider>
  </StrictMode>,
);
