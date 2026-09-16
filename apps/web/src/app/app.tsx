import {
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  Cpu,
  Orbit,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';

type AppMode = 'work' | 'management';
type ManagementPage = 'models';

export function App() {
  const [mode, setMode] = useState<AppMode>('work');
  const [managementPage, setManagementPage] = useState<ManagementPage>('models');
  const [modelsOpened, setModelsOpened] = useState(false);
  const managementPageRef = useRef<HTMLElement>(null);
  const [modelSettingsDirty, setModelSettingsDirty] = useState(false);
  const [modelSettingsBusy, setModelSettingsBusy] = useState(false);
  const [modelSettingsDiscardSignal, setModelSettingsDiscardSignal] = useState(0);
  const managementMode = mode === 'management';

  useLayoutEffect(() => {
    if (managementMode) managementPageRef.current?.focus({ preventScroll: true });
  }, [managementMode, managementPage]);

  function openManagementPage(page: ManagementPage): void {
    if (page === 'models') setModelsOpened(true);
    setManagementPage(page);
    setMode('management');
  }

  function returnToWorkMode(): void {
    if (modelSettingsBusy) return;
    if (
      modelSettingsDirty &&
      !window.confirm('当前模型配置有未保存的更改，确定离开并放弃吗？')
    ) return;
    if (modelSettingsDirty) {
      setModelSettingsDiscardSignal((current) => current + 1);
    }
    setModelSettingsDirty(false);
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
          disabled={managementMode && modelSettingsBusy}
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

          {modelsOpened && (
            <main
              ref={managementPageRef}
              className="management-page"
              aria-labelledby="models-page-title"
              tabIndex={-1}
              hidden={!managementMode || managementPage !== 'models'}
            >
              <header className="management-page-header">
                <div>
                  <span>管理模式</span>
                  <h1 id="models-page-title">模型</h1>
                  <p>管理模型元数据、查看 Pi 能力与认证状态，并设置全局默认模型。</p>
                </div>
                <button
                  type="button"
                  className="return-work-button"
                  data-shell-navigation
                  onClick={returnToWorkMode}
                  disabled={modelSettingsBusy}
                >
                  <ArrowLeft aria-hidden="true" />
                  返回工作模式
                </button>
              </header>

              <ModelSettingsPage
                onDirtyChange={setModelSettingsDirty}
                onBusyChange={setModelSettingsBusy}
                discardSignal={modelSettingsDiscardSignal}
              />
            </main>
          )}
        </div>
      </div>
    </div>
  );
}
