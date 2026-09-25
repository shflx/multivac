import {
  ArrowLeft,
  ChevronDown,
  CircleCheck,
  Columns2,
  Cpu,
  Orbit,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AssistantSessionsProvider } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { MultivacSidebar } from '../features/assistant/multivac-sidebar.js';
import type { AssistantQuote } from '@multivac/contracts';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';
import { WorkspaceView } from '../features/workspace/workspace-view.js';

type AppMode = 'work' | 'management';
/** 工作模式下的两个工作面：Multivac 首页与工作区，二者都保持挂载。 */
type WorkSurface = 'assistant' | 'workspace';

/** 工作区 Multivac 侧栏的折叠状态保存在本机，跨进出工作区与刷新保留；默认展开。 */
const WORKSPACE_SIDEBAR_STORAGE_KEY = 'multivac.workspace.multivac-sidebar';

function readWorkspaceSidebarOpen(): boolean {
  try {
    return localStorage.getItem(WORKSPACE_SIDEBAR_STORAGE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function writeWorkspaceSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(WORKSPACE_SIDEBAR_STORAGE_KEY, open ? 'expanded' : 'collapsed');
  } catch {
    // 本机存储不可用时只在本次页面内保持状态。
  }
}
type ManagementPage = 'models';

export function App() {
  const [mode, setMode] = useState<AppMode>('work');
  const [managementPage, setManagementPage] = useState<ManagementPage>('models');
  const [modelsOpened, setModelsOpened] = useState(false);
  const managementPageRef = useRef<HTMLElement>(null);
  const [modelSettingsDirty, setModelSettingsDirty] = useState(false);
  const [modelSettingsBusy, setModelSettingsBusy] = useState(false);
  const [modelSettingsDiscardSignal, setModelSettingsDiscardSignal] = useState(0);
  // 侧栏开合是用户在管理模式里的偏好，离开再回来仍保持。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const [workSurface, setWorkSurface] = useState<WorkSurface>('assistant');
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(readWorkspaceSidebarOpen);
  // 工作区当前焦点会话：侧栏据此提示并在发送时作为上下文。
  const [workspaceFocus, setWorkspaceFocus] = useState<{ sessionId: string; title: string } | null>(null);
  // 从工作会话交给 Multivac 的引用；id 递增表示一次新的交接。
  const [handoff, setHandoff] = useState<{ id: number; quote: AssistantQuote } | null>(null);
  const managementMode = mode === 'management';
  const sidebarVisible = managementMode && sidebarOpen;
  const assistantVisible = !managementMode && workSurface === 'assistant';
  const workspaceVisible = !managementMode && workSurface === 'workspace';

  useLayoutEffect(() => {
    if (managementMode) managementPageRef.current?.focus({ preventScroll: true });
  }, [managementMode, managementPage]);

  // Esc 先收起侧栏，不连带离开管理模式；弹层和输入框里的 Esc 只作用于自身。
  useEffect(() => {
    if (!sidebarVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('.model-selector-menu')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
      collapseSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarVisible]);

  function toggleWorkspaceSidebar(open: boolean): void {
    setWorkspaceSidebarOpen(open);
    writeWorkspaceSidebarOpen(open);
  }

  /** 交给 Multivac：展开侧栏，把引用写入侧栏输入区并聚焦；当前会话保持原样。 */
  function handToMultivac(quote: AssistantQuote): void {
    toggleWorkspaceSidebar(true);
    setHandoff((current) => ({ id: (current?.id ?? 0) + 1, quote }));
  }

  function switchWorkSurface(surface: WorkSurface): void {
    if (surface === 'workspace') setWorkspaceOpened(true);
    setWorkSurface(surface);
  }

  function collapseSidebar(): void {
    setSidebarOpen(false);
    sidebarToggleRef.current?.focus({ preventScroll: true });
  }

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
    // 会话状态挂在应用层，全局唯一；工作面与后续的其他呈现实例共享它。
    <AssistantSessionsProvider>
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

          <div className="shell-actions">
            <div className="shell-status" aria-label="当前模式">
              {managementMode
                ? <><Cpu aria-hidden="true" /><span>管理模式 / 模型</span></>
                : <><CircleCheck aria-hidden="true" /><span>Pi 会话已连接</span></>}
            </div>
            {!managementMode && (
              <button
                type="button"
                className="shell-toggle"
                onClick={() => switchWorkSurface(workSurface === 'assistant' ? 'workspace' : 'assistant')}
              >
                {workSurface === 'assistant'
                  ? <><Columns2 aria-hidden="true" /><span>进入工作区</span></>
                  : <><Orbit aria-hidden="true" /><span>返回 Multivac</span></>}
              </button>
            )}
            {managementMode && (
              <button
                type="button"
                ref={sidebarToggleRef}
                className={`shell-toggle${sidebarOpen ? ' active' : ''}`}
                aria-pressed={sidebarOpen}
                title={sidebarOpen ? '收起 Multivac 侧栏' : '打开 Multivac 侧栏'}
                onClick={() => sidebarOpen ? collapseSidebar() : setSidebarOpen(true)}
              >
                <Orbit aria-hidden="true" />
                <span>Multivac</span>
              </button>
            )}
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
            <div className="work-surface" hidden={!assistantVisible}>
              <AssistantView
                active={assistantVisible}
                onManageModels={() => openManagementPage('models')}
              />
            </div>

            {/* 工作区首次进入后保持挂载：来回切换不重建会话，也不丢草稿、阅读位置与焦点。 */}
            {workspaceOpened && (
              <div className="work-surface" hidden={!workspaceVisible}>
                {/* 工作区右侧常驻同一个 Multivac；工作区按剩余宽度排版。 */}
                <div className="workspace-shell">
                  <WorkspaceView
                    active={workspaceVisible}
                    onManageModels={() => openManagementPage('models')}
                    onFocusChange={setWorkspaceFocus}
                    onHandToMultivac={handToMultivac}
                  />
                  <MultivacSidebar
                    active={workspaceVisible && workspaceSidebarOpen}
                    collapsed={!workspaceSidebarOpen}
                    onCollapse={() => toggleWorkspaceSidebar(false)}
                    onExpand={() => toggleWorkspaceSidebar(true)}
                    onManageModels={() => openManagementPage('models')}
                    context={workspaceFocus}
                    incomingQuote={handoff}
                    onIncomingQuoteHandled={() => setHandoff(null)}
                  />
                </div>
              </div>
            )}

            {/* 管理模式里的 Multivac 停靠在右侧并挤压管理页，而不是浮层盖住一侧页面。 */}
            <div className={`management-shell${sidebarVisible ? ' with-sidebar' : ''}`} hidden={!managementMode}>
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
                      <p>管理模型配置、认证与连接状态，并设置全局默认模型。</p>
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
                    active={managementMode}
                  />
                </main>
              )}
              {sidebarVisible && (
                <MultivacSidebar
                  active={sidebarVisible}
                  onCollapse={collapseSidebar}
                  onManageModels={() => openManagementPage('models')}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </AssistantSessionsProvider>
  );
}
