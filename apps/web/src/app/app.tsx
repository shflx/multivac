import {
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  Cpu,
  Orbit,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { AssistantView } from '../features/assistant/assistant-view.js';

type AppMode = 'work' | 'management';
type ManagementPage = 'models';

export function App() {
  const [mode, setMode] = useState<AppMode>('work');
  const [managementPage, setManagementPage] = useState<ManagementPage>('models');
  const managementPageRef = useRef<HTMLElement>(null);
  const managementMode = mode === 'management';

  useLayoutEffect(() => {
    if (managementMode) managementPageRef.current?.focus({ preventScroll: true });
  }, [managementMode, managementPage]);

  function openManagementPage(page: ManagementPage): void {
    setManagementPage(page);
    setMode('management');
  }

  function returnToWorkMode(): void {
    setMode('work');
  }

  return (
    <div className={`app-shell ${managementMode ? 'management-mode' : 'work-mode'}`}>
      <header className="shell-header">
        <button
          type="button"
          className="logo-area"
          data-shell-navigation
          onClick={() => managementMode ? returnToWorkMode() : openManagementPage('models')}
          aria-label={managementMode ? '返回工作模式' : '打开管理模式'}
          title={managementMode ? '返回工作模式' : '打开管理模式'}
        >
          <Orbit aria-hidden="true" />
          <span className="logo-copy">
            <strong>Multivac</strong>
            <small>{managementMode ? '管理模式' : '工作模式'}</small>
          </span>
          <ChevronDown className="mode-chevron" aria-hidden="true" />
        </button>

        <div className="shell-status" aria-label="当前模式">
          {managementMode
            ? <><Cpu aria-hidden="true" /><span>管理模式 / 模型</span></>
            : <><CircleCheck aria-hidden="true" /><span>Pi 会话已连接</span></>}
        </div>
      </header>

      <div className="shell-body">
        {managementMode && (
          <aside className="management-sidebar" aria-label="管理导航">
            <nav>
              <button
                type="button"
                className={managementPage === 'models' ? 'active' : ''}
                aria-current={managementPage === 'models' ? 'page' : undefined}
                onClick={() => openManagementPage('models')}
              >
                <Cpu aria-hidden="true" />
                <span>模型</span>
              </button>
            </nav>
          </aside>
        )}

        <div className="shell-content">
          <div className="work-surface" hidden={managementMode}>
            <AssistantView
              active={!managementMode}
              onManageModels={() => openManagementPage('models')}
            />
          </div>

          {managementMode && managementPage === 'models' && (
            <main
              ref={managementPageRef}
              className="management-page"
              aria-labelledby="models-page-title"
              tabIndex={-1}
            >
              <header className="management-page-header">
                <div>
                  <span>管理模式</span>
                  <h1 id="models-page-title">模型</h1>
                  <p>模型管理将在 MODEL-01 中接入。当前页面仅保留稳定挂载位置。</p>
                </div>
                <button
                  type="button"
                  className="return-work-button"
                  data-shell-navigation
                  onClick={returnToWorkMode}
                >
                  <ArrowLeft aria-hidden="true" />
                  返回工作模式
                </button>
              </header>

              <div className="model-page-mount" data-management-page="models">
                <Cpu aria-hidden="true" />
                <h2>模型配置尚未实现</h2>
                <p>此处是 MODEL-01 的页面挂载位置，不提供模拟配置或不可用操作。</p>
              </div>
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
