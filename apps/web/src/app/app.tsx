import {
  ChevronDown,
  CircleCheck,
  Columns2,
  Orbit,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AssistantSessionsProvider } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { MultivacSidebar } from '../features/assistant/multivac-sidebar.js';
import type { AssistantQuote } from '@multivac/contracts';
import { useConfirm } from '../components/confirm-card.js';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';
import { SessionsPage } from '../features/sessions/sessions-page.js';
import { WorkspaceView } from '../features/workspace/workspace-view.js';
import { ManagementNav, ManagementPageFrame } from './management-layout.js';
import { MANAGEMENT_PAGES, managementPage, type ManagementPageId } from './management-nav.js';

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

export function App() {
  const [mode, setMode] = useState<AppMode>('work');
  // 进入管理时回到上次所在的页面，首次进入打开注册表中的第一页。
  const [currentPage, setCurrentPage] = useState<ManagementPageId>(MANAGEMENT_PAGES[0].id);
  // 管理页首次打开后保持挂载，切换页面或离开管理不丢失页面内状态。
  const [openedPages, setOpenedPages] = useState<ReadonlySet<ManagementPageId>>(() => new Set());
  const managementPageRef = useRef<HTMLElement>(null);
  const [modelSettingsDirty, setModelSettingsDirty] = useState(false);
  const [modelSettingsBusy, setModelSettingsBusy] = useState(false);
  const [modelSettingsDiscardSignal, setModelSettingsDiscardSignal] = useState(0);
  // 侧栏开合是用户在管理中的偏好，离开再回来仍保持。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const [workSurface, setWorkSurface] = useState<WorkSurface>('assistant');
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(readWorkspaceSidebarOpen);
  // 工作区当前焦点会话：侧栏据此提示并在发送时作为上下文。
  const [workspaceFocus, setWorkspaceFocus] = useState<{ sessionId: string; title: string } | null>(null);
  // 从工作会话交给 Multivac 的引用；id 递增表示一次新的交接。
  const [handoff, setHandoff] = useState<{ id: number; quote: AssistantQuote } | null>(null);
  // 从管理 · 会话页在工作区打开的会话；id 递增表示一次新的打开。
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<{ id: number; sessionId: string } | null>(null);
  const confirm = useConfirm();
  const managementMode = mode === 'management';
  const sidebarVisible = managementMode && sidebarOpen;
  const assistantVisible = !managementMode && workSurface === 'assistant';
  const workspaceVisible = !managementMode && workSurface === 'workspace';

  useLayoutEffect(() => {
    if (managementMode) managementPageRef.current?.focus({ preventScroll: true });
  }, [managementMode, currentPage]);

  // Esc 先收起侧栏，不连带离开管理；弹层和输入框里的 Esc 只作用于自身。
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

  /** 进入管理并打开指定页面；已在管理中时只切换页面。 */
  function openManagementPage(page: ManagementPageId): void {
    setOpenedPages((current) => current.has(page) ? current : new Set(current).add(page));
    setCurrentPage(page);
    setMode('management');
  }

  /** 离开管理；模型页有未保存的更改时先经确认卡确认，放弃后丢弃草稿。返回是否已离开。 */
  async function returnToWorkMode(): Promise<boolean> {
    if (modelSettingsBusy) return false;
    if (modelSettingsDirty) {
      const discard = await confirm({
        title: '放弃未保存的更改？',
        description: '当前模型配置有未保存的更改，离开后这些更改会丢失。',
        tone: 'danger',
        confirmLabel: '放弃并离开',
        cancelLabel: '继续编辑',
      });
      if (!discard) return false;
      setModelSettingsDiscardSignal((current) => current + 1);
    }
    setModelSettingsDirty(false);
    setMode('work');
    return true;
  }

  /** 在工作区打开会话：离开管理（同样经过离开确认），切到工作区并聚焦这个会话。 */
  async function openSessionInWorkspace(sessionId: string): Promise<void> {
    if (!await returnToWorkMode()) return;
    switchWorkSurface('workspace');
    setWorkspaceOpenRequest((current) => ({ id: (current?.id ?? 0) + 1, sessionId }));
  }

  /**
   * 各管理页的内容；页头、返回与挂载方式由 ManagementPageFrame 统一提供。
   * 新增页面在注册表登记后，在这里补上对应内容（类型保证不会遗漏）。
   */
  const managementPageContent: Record<ManagementPageId, ReactNode> = {
    sessions: (
      <SessionsPage
        active={managementMode && currentPage === 'sessions'}
        onOpenInWorkspace={(sessionId) => void openSessionInWorkspace(sessionId)}
      />
    ),
    models: (
      <ModelSettingsPage
        onDirtyChange={setModelSettingsDirty}
        onBusyChange={setModelSettingsBusy}
        discardSignal={modelSettingsDiscardSignal}
        active={managementMode && currentPage === 'models'}
      />
    ),
  };
  const CurrentPageIcon = managementPage(currentPage).icon;

  return (
    // 会话状态挂在应用层，全局唯一；工作面与后续的其他呈现实例共享它。
    <AssistantSessionsProvider>
      <div className={`app-shell ${managementMode ? 'management-mode' : 'work-mode'}`}>
        <header className="shell-header">
          <button
            type="button"
            className="logo-area"
            data-shell-navigation
            onClick={() => managementMode ? void returnToWorkMode() : openManagementPage(currentPage)}
            aria-label={managementMode ? '返回工作模式' : '打开管理'}
            title={managementMode ? '返回工作模式' : '打开管理'}
            disabled={managementMode && modelSettingsBusy}
          >
            <Orbit aria-hidden="true" />
            <span className="logo-copy">
              <strong>Multivac</strong>
              <small>{managementMode ? '管理' : '工作模式'}</small>
            </span>
            <ChevronDown className="mode-chevron" aria-hidden="true" />
          </button>

          <div className="shell-actions">
            <div className="shell-status" aria-label="当前模式">
              {managementMode
                ? <><CurrentPageIcon aria-hidden="true" /><span>管理 / {managementPage(currentPage).label}</span></>
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
          {managementMode && <ManagementNav current={currentPage} onNavigate={openManagementPage} />}

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
                    openRequest={workspaceOpenRequest}
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

            {/* 管理中的 Multivac 停靠在右侧并挤压管理页，而不是浮层盖住一侧页面。 */}
            <div className={`management-shell${sidebarVisible ? ' with-sidebar' : ''}`} hidden={!managementMode}>
              {MANAGEMENT_PAGES.filter((page) => openedPages.has(page.id)).map((page) => (
                <ManagementPageFrame
                  key={page.id}
                  // 只有当前页接收焦点引用，进入管理或切换页面时由它接管焦点。
                  ref={page.id === currentPage ? managementPageRef : undefined}
                  page={page}
                  hidden={!managementMode || page.id !== currentPage}
                  returnDisabled={modelSettingsBusy}
                  onReturn={() => void returnToWorkMode()}
                >
                  {managementPageContent[page.id]}
                </ManagementPageFrame>
              ))}
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
