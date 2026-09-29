import {
  Columns2,
  LayoutDashboard,
  Orbit,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AssistantSessionsProvider } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { MultivacSidebar } from '../features/assistant/multivac-sidebar.js';
import { useConfirm } from '../components/confirm-card.js';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';
import { AuthorizationRecordsPage } from '../features/authorizations/authorization-records-page.js';
import { PreferencesPage } from '../features/preferences/preferences-page.js';
import { ProjectsPage, type ProjectSettingsRequest } from '../features/projects/projects-page.js';
import { SessionsPage } from '../features/sessions/sessions-page.js';
import { WorkspaceShell, type WorkspaceOpenRequest } from '../features/workspace/workspace-shell.js';
import { ManagementNav, ManagementPageFrame } from './management-layout.js';
import { MANAGEMENT_PAGES, managementPage, type ManagementPageId } from './management-nav.js';

type AppMode = 'work' | 'management';
/** 管理之外的两个工作面：Multivac 首页与工作区，二者都保持挂载。 */
type WorkSurface = 'assistant' | 'workspace';

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
  // 从管理 · 会话页在工作区打开的会话及其所在的工作区；id 递增表示一次新的打开。
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceOpenRequest | null>(null);
  // 从工作区切换菜单“项目设置”打开的项目；id 递增表示一次新的打开。
  const [projectSettingsRequest, setProjectSettingsRequest] = useState<ProjectSettingsRequest | null>(null);
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

  /** 打开设置 · 项目并选中指定项目（默认工作区不属于项目时为 null，保留页面上的选择）。 */
  function openProjectSettings(projectId: string | null): void {
    setProjectSettingsRequest((current) => ({ id: (current?.id ?? 0) + 1, projectId }));
    openManagementPage('projects');
  }

  /** 离开管理，回到进入前的工作面；模型页有未保存的更改时先经确认卡确认，放弃后丢弃草稿。返回是否已离开。 */
  async function leaveManagement(): Promise<boolean> {
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

  /** Logo 即“回到 Multivac”：任何一层点它都回到首页；在管理中等同离开管理，经过同样的离开确认。 */
  async function goHome(): Promise<void> {
    if (managementMode && !await leaveManagement()) return;
    switchWorkSurface('assistant');
  }

  /** 在工作区打开会话：离开管理（同样经过离开确认），切到会话所在的工作区并聚焦这个会话。 */
  async function openSessionInWorkspace(session: { sessionId: string; workspaceId: string }): Promise<void> {
    if (!await leaveManagement()) return;
    switchWorkSurface('workspace');
    setWorkspaceOpenRequest((current) => ({
      id: (current?.id ?? 0) + 1, sessionId: session.sessionId, workspaceId: session.workspaceId,
    }));
  }

  /**
   * 各管理页的内容；页头、返回与挂载方式由 ManagementPageFrame 统一提供。
   * 新增页面在注册表登记后，在这里补上对应内容（类型保证不会遗漏）。
   */
  const managementPageContent: Record<ManagementPageId, ReactNode> = {
    sessions: (
      <SessionsPage
        active={managementMode && currentPage === 'sessions'}
        onOpenInWorkspace={(session) => void openSessionInWorkspace(session)}
      />
    ),
    projects: <ProjectsPage request={projectSettingsRequest} />,
    authorizations: <AuthorizationRecordsPage active={managementMode && currentPage === 'authorizations'} />,
    models: (
      <ModelSettingsPage
        onDirtyChange={setModelSettingsDirty}
        onBusyChange={setModelSettingsBusy}
        discardSignal={modelSettingsDiscardSignal}
        active={managementMode && currentPage === 'models'}
      />
    ),
    preferences: <PreferencesPage active={managementMode && currentPage === 'preferences'} />,
  };

  return (
    // 会话状态挂在应用层，全局唯一；工作面与后续的其他呈现实例共享它。
    <AssistantSessionsProvider>
      <div className={`app-shell ${managementMode ? 'management-mode' : 'work-mode'}`}>
        {/* 顶栏：Logo 单独一列（与管理导航同宽），管理中左侧是当前页面名，右侧是操作。 */}
        <header className="shell-header">
          <button
            type="button"
            className="logo-area"
            data-shell-navigation
            onClick={() => void goHome()}
            aria-label="回到 Multivac"
            title="回到 Multivac"
            disabled={managementMode && modelSettingsBusy}
          >
            <Orbit aria-hidden="true" />
            <span className="logo-copy">
              <strong>Multivac</strong>
              {managementMode && <small>管理</small>}
            </span>
          </button>

          {managementMode && <div className="shell-page-name">{managementPage(currentPage).label}</div>}

          <div className="shell-actions">
            {!managementMode && (
              <>
                <button
                  type="button"
                  className="shell-toggle"
                  onClick={() => switchWorkSurface(workSurface === 'assistant' ? 'workspace' : 'assistant')}
                >
                  {workSurface === 'assistant'
                    ? <><Columns2 aria-hidden="true" /><span>进入工作区</span></>
                    : <><Orbit aria-hidden="true" /><span>返回 Multivac</span></>}
                </button>
                {/* 进入管理的显式入口（Logo 已改为回到首页）。 */}
                <button
                  type="button"
                  className="shell-toggle"
                  data-shell-navigation
                  onClick={() => openManagementPage(currentPage)}
                >
                  <LayoutDashboard aria-hidden="true" />
                  <span>管理</span>
                </button>
              </>
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
                {/* 工作区右侧常驻同一个 Multivac（默认收起、用完即收）；工作区按剩余宽度排版。 */}
                <WorkspaceShell
                  active={workspaceVisible}
                  onManageModels={() => openManagementPage('models')}
                  onManageProject={openProjectSettings}
                  openRequest={workspaceOpenRequest}
                />
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
                  onReturn={() => void leaveManagement()}
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
