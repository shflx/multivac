import { Orbit } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AssistantSessionsProvider } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { MULTIVAC_SIDEBAR_SHORTCUT, MultivacSidebar } from '../features/assistant/multivac-sidebar.js';
import { useConfirm } from '../components/confirm-card.js';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';
import { AuthorizationRecordsPage } from '../features/authorizations/authorization-records-page.js';
import { PreferencesPage } from '../features/preferences/preferences-page.js';
import { ProjectsPage, type ProjectSettingsRequest } from '../features/projects/projects-page.js';
import { SessionsPage } from '../features/sessions/sessions-page.js';
import { WorkspaceShell, type WorkspaceOpenRequest } from '../features/workspace/workspace-shell.js';
import { ManagementNav, ManagementPageFrame } from './management-layout.js';
import { MANAGEMENT_PAGES, managementPage, type ManagementPageId } from './management-nav.js';
import { PanelSwitcher } from './panel-switcher.js';
import { shellOwnsEscape, shellShortcut, type ShellPanel, type ShellShortcut } from './shell-shortcuts.js';
import { ShortcutHelp } from './shortcut-help.js';

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
  const [workSurface, setWorkSurface] = useState<WorkSurface>('assistant');
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  // 工作区侧栏的开合由工作区自己管理：这里只记下它报告的状态（“?”菜单据此写“显示 / 收起”），
  // 并以递增的请求让它叫出或收起。
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false);
  const [workspaceSidebarToggle, setWorkspaceSidebarToggle] = useState(0);
  const [panelSwitcherOpen, setPanelSwitcherOpen] = useState(false);
  // 从管理 · 会话页在工作区打开的会话及其所在的工作区；id 递增表示一次新的打开。
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceOpenRequest | null>(null);
  // 从工作区切换菜单“项目设置”打开的项目；id 递增表示一次新的打开。
  const [projectSettingsRequest, setProjectSettingsRequest] = useState<ProjectSettingsRequest | null>(null);
  const confirm = useConfirm();
  const managementMode = mode === 'management';
  const sidebarVisible = managementMode && sidebarOpen;
  const assistantVisible = !managementMode && workSurface === 'assistant';
  const workspaceVisible = !managementMode && workSurface === 'workspace';
  /** 当前所在的面板：管理叠在进入前的面板之上时算“管理”。 */
  const currentPanel: ShellPanel = managementMode ? 'management' : workSurface;
  // Multivac 侧栏能在工作区与管理中叫出；首页本身就是 Multivac 对话。
  const canToggleSidebar = managementMode || workSurface === 'workspace';

  useLayoutEffect(() => {
    if (managementMode) managementPageRef.current?.focus({ preventScroll: true });
  }, [managementMode, currentPage]);

  // 外壳快捷键：⌘G / Ctrl+G 打开面板跳转，⌘J / Ctrl+J 在工作区与管理中叫出或收起 Multivac 侧栏。
  // 模态层（确认卡、对话框、面板跳转本身）打开时按键只属于该层；首页不拦截 ⌘J，留给浏览器。
  const shortcutRef = useRef<(shortcut: ShellShortcut) => boolean>(() => false);
  shortcutRef.current = (shortcut) => {
    if (shortcut === 'panel-switcher') {
      setPanelSwitcherOpen(true);
      return true;
    }
    if (!canToggleSidebar) return false;
    toggleSidebar();
    return true;
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shellShortcut(event);
      if (!shortcut || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      if (shortcutRef.current(shortcut)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // 管理中的 Esc：侧栏开着时先收起侧栏，再按一次回到进入管理前的面板（经过离开确认）。
  // 弹层、确认卡、输入框与菜单里的 Esc 只作用于自身，判定见 shellOwnsEscape。
  const escapeRef = useRef<() => void>(() => undefined);
  escapeRef.current = () => {
    if (sidebarOpen) collapseSidebar();
    else void leaveManagement();
  };
  useEffect(() => {
    if (!managementMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!shellOwnsEscape(event)) return;
      event.preventDefault();
      escapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [managementMode]);

  function switchWorkSurface(surface: WorkSurface): void {
    if (surface === 'workspace') setWorkspaceOpened(true);
    setWorkSurface(surface);
  }

  function collapseSidebar(): void {
    // 焦点在侧栏里（收起按钮、侧栏里按 ⌘J 或 Esc）时交给当前管理页，不随侧栏卸载落到页面根上。
    const focusInSidebar = document.activeElement?.closest('.management-shell .multivac-sidebar');
    setSidebarOpen(false);
    if (focusInSidebar) managementPageRef.current?.focus({ preventScroll: true });
  }

  /** 叫出或收起当前面板的 Multivac 侧栏：管理中是停靠侧栏，工作区里交给工作区自己处理。 */
  function toggleSidebar(): void {
    if (managementMode) {
      if (sidebarOpen) collapseSidebar();
      else setSidebarOpen(true);
    } else if (workSurface === 'workspace') {
      setWorkspaceSidebarToggle((current) => current + 1);
    }
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

  /**
   * 面板跳转：去管理时保留原来的面板（Esc 或再跳回即可返回）；从管理跳走等同离开管理，
   * 经过同样的离开确认。跳到当前所在的面板什么也不做。
   */
  async function goToPanel(panel: ShellPanel): Promise<void> {
    setPanelSwitcherOpen(false);
    if (panel === currentPanel) return;
    if (panel === 'management') {
      openManagementPage(currentPage);
      return;
    }
    if (managementMode && !await leaveManagement()) return;
    switchWorkSurface(panel);
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
   * 各管理页的内容；页头与挂载方式由 ManagementPageFrame 统一提供。
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

          {/* 右侧各层一致：面板跳转（⌘G）与侧栏（⌘J）靠快捷键，“?”里列出并可直接点。 */}
          <div className="shell-actions">
            <ShortcutHelp
              sidebarOpen={managementMode ? sidebarOpen : workspaceSidebarOpen}
              canToggleSidebar={canToggleSidebar}
              onToggleSidebar={toggleSidebar}
              onOpenPanelSwitcher={() => setPanelSwitcherOpen(true)}
            />
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
                  sidebarToggleRequest={workspaceSidebarToggle}
                  onSidebarOpenChange={setWorkspaceSidebarOpen}
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
                >
                  {managementPageContent[page.id]}
                </ManagementPageFrame>
              ))}
              {sidebarVisible && (
                <MultivacSidebar
                  active={sidebarVisible}
                  onCollapse={collapseSidebar}
                  shortcut={MULTIVAC_SIDEBAR_SHORTCUT}
                  onManageModels={() => openManagementPage('models')}
                />
              )}
            </div>
          </div>
        </div>

        {panelSwitcherOpen && (
          <PanelSwitcher
            current={currentPanel}
            onPick={(panel) => void goToPanel(panel)}
            onClose={() => setPanelSwitcherOpen(false)}
          />
        )}
      </div>
    </AssistantSessionsProvider>
  );
}
