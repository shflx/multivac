import { Orbit } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AssistantQuote } from '@multivac/contracts';
import { useAssistantSession } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { workspaceSessionFocus, type MultivacFocus } from '../features/assistant/multivac-focus.js';
import {
  MULTIVAC_SIDEBAR_SHORTCUT,
  MultivacSidebar,
  forgetLegacySidebarState,
  rememberSidebarDock,
  rememberedSidebarDock,
  type SidebarDock,
} from '../features/assistant/multivac-sidebar.js';
import { sidebarCollapsesWhenWorking } from '../features/assistant/sidebar-collapse.js';
import { pendingAuthorizations } from '../features/assistant/tool-authorizations.js';
import { useConfirm } from '../components/confirm-card.js';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';
import { AuthorizationRecordsPage } from '../features/authorizations/authorization-records-page.js';
import { PreferencesPage } from '../features/preferences/preferences-page.js';
import { ProjectsPage, type ProjectSettingsRequest } from '../features/projects/projects-page.js';
import { SessionsPage } from '../features/sessions/sessions-page.js';
import { WorkspaceShell, type WorkspaceOpenRequest } from '../features/workspace/workspace-shell.js';
import { DesktopOnlyNotice } from './desktop-only-notice.js';
import { ManagementNav, ManagementPageFrame } from './management-layout.js';
import { MANAGEMENT_PAGES, managementPage, type ManagementPageId } from './management-nav.js';
import { useNarrowViewport } from './narrow-viewport.js';
import { PanelSwitcher } from './panel-switcher.js';
import { shellOwnsEscape, shellShortcut, type ShellPanel, type ShellShortcut } from './shell-shortcuts.js';
import { ShortcutHelp } from './shortcut-help.js';
import { useWorkStarted } from './work-started.js';

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
  const managementShellRef = useRef<HTMLDivElement>(null);
  const [modelSettingsDirty, setModelSettingsDirty] = useState(false);
  const [modelSettingsBusy, setModelSettingsBusy] = useState(false);
  const [modelSettingsDiscardSignal, setModelSettingsDiscardSignal] = useState(0);
  const [workSurface, setWorkSurface] = useState<WorkSurface>('assistant');
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  const workspaceSurfaceRef = useRef<HTMLDivElement>(null);
  // Multivac 侧栏只有一个展开状态：工作区与管理共用，切换面板时侧栏不跳。每次打开页面都从收起开始。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // 侧栏首次叫出时才挂载，之后收起、切换面板都只隐藏：会话呈现不重建，阅读位置与焦点记忆都在。
  const [sidebarMounted, setSidebarMounted] = useState(false);
  const [sidebarDock, setSidebarDock] = useState<SidebarDock>(rememberedSidebarDock);
  const [sidebarFocusRequest, setSidebarFocusRequest] = useState(0);
  // 叫出侧栏前的焦点：在工作区里收起时还给它。
  const sidebarReturnFocusRef = useRef<HTMLElement | null>(null);
  // 交给 Multivac 的引用；id 递增表示一次新的交接。
  const [handoff, setHandoff] = useState<{ id: number; quote: AssistantQuote } | null>(null);
  // 工作区的当前焦点会话，作为侧栏的上下文。
  const [workspaceFocus, setWorkspaceFocus] = useState<{ sessionId: string; title: string } | null>(null);
  const [panelSwitcherOpen, setPanelSwitcherOpen] = useState(false);
  // 从管理 · 会话页在工作区打开的会话及其所在的工作区；id 递增表示一次新的打开。
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceOpenRequest | null>(null);
  // 从工作区切换菜单“项目设置”打开的项目；id 递增表示一次新的打开。
  const [projectSettingsRequest, setProjectSettingsRequest] = useState<ProjectSettingsRequest | null>(null);
  const confirm = useConfirm();
  const global = useAssistantSession()?.session;
  const managementMode = mode === 'management';
  // 窄屏只保留 Multivac 首页：工作区与管理改为“请在桌面使用”的提示，外壳快捷键不响应。
  // 提示只替换呈现，工作区、管理页与侧栏仍保持挂载（隐藏），回到宽屏时现场原样。
  const narrow = useNarrowViewport();
  const showManagement = managementMode && !narrow;
  const desktopOnly = narrow && (managementMode || workSurface === 'workspace');
  const assistantVisible = !managementMode && workSurface === 'assistant';
  const workspaceVisible = !managementMode && workSurface === 'workspace' && !narrow;
  /** 当前所在的面板：管理叠在进入前的面板之上时算“管理”。 */
  const currentPanel: ShellPanel = managementMode ? 'management' : workSurface;
  // Multivac 侧栏能在工作区与管理中叫出；首页本身就是 Multivac 对话，窄屏只保留首页。
  const canToggleSidebar = !narrow && (managementMode || workSurface === 'workspace');
  const sidebarVisible = sidebarOpen && (workspaceVisible || showManagement);
  // 并排时挤压当前页面（管理页随之收窄内边距），浮层时覆盖在页面右侧、页面排版不变。
  const sidebarPushes = sidebarVisible && sidebarDock === 'push';
  // 侧栏收起时 Multivac 在等授权：顶栏给出提示，点它叫出侧栏就地处理（首页本身就显示授权卡）。
  const awaitingAuthorization = global !== undefined && pendingAuthorizations(global.authorizations).length > 0;
  const showAuthorizationAttention = awaitingAuthorization && canToggleSidebar && !sidebarVisible;
  /** 侧栏正在看的对象：工作区的焦点会话。 */
  const sidebarContext: MultivacFocus | null = workspaceVisible ? workspaceSessionFocus(workspaceFocus) : null;

  useEffect(() => {
    forgetLegacySidebarState();
  }, []);

  useLayoutEffect(() => {
    if (showManagement) managementPageRef.current?.focus({ preventScroll: true });
  }, [showManagement, currentPage]);

  // 外壳快捷键：⌘G / Ctrl+G 打开面板跳转，⌘J / Ctrl+J 在工作区与管理中叫出或收起 Multivac 侧栏。
  // 模态层（确认卡、对话框、面板跳转本身）打开时按键只属于该层；首页不拦截 ⌘J，留给浏览器。
  const shortcutRef = useRef<(shortcut: ShellShortcut) => boolean>(() => false);
  shortcutRef.current = (shortcut) => {
    if (narrow) return false;
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

  // 工作区与管理中的 Esc：侧栏开着时先收起侧栏；在管理中再按一次回到进入管理前的面板（经过离开确认）。
  // 弹层、确认卡、输入框与菜单里的 Esc 只作用于自身，判定见 shellOwnsEscape。
  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    if (sidebarVisible) collapseSidebar();
    else if (showManagement) void leaveManagement();
    else return false;
    return true;
  };
  useEffect(() => {
    if (!showManagement && !workspaceVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (shellOwnsEscape(event) && escapeRef.current()) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showManagement, workspaceVisible]);

  // 开始干活即收起：用户在工作区或管理页里点进、Tab 进输入框或编辑器时，如果 Multivac 已处理完、
  // 侧栏里也没有未发出的草稿或引用，侧栏随之收起；还在处理或有未发出的内容时保持展开，不打断用户。
  // 点选、滚动、查看都不收，“正在看…”跟着选中的对象变，方便接着说“这个”。
  useWorkStarted(
    () => [workspaceVisible ? workspaceSurfaceRef.current : null, showManagement ? managementShellRef.current : null],
    () => {
      if (sidebarVisible && global && sidebarCollapsesWhenWorking(global)) setSidebarOpen(false);
    },
  );

  function switchWorkSurface(surface: WorkSurface): void {
    if (surface === 'workspace') setWorkspaceOpened(true);
    setWorkSurface(surface);
  }

  /** 展开侧栏；记下展开前的焦点，在工作区里收起时还给它。 */
  function openSidebar(): void {
    const focused = document.activeElement;
    sidebarReturnFocusRef.current = focused instanceof HTMLElement && !focused.closest('.multivac-sidebar')
      ? focused
      : null;
    setSidebarMounted(true);
    setSidebarOpen(true);
  }

  /** 明确叫出侧栏（⌘J、“?”菜单、顶栏的授权提示）：展开并把焦点交给侧栏输入区，工作区与管理相同。 */
  function summonSidebar(): void {
    openSidebar();
    setSidebarFocusRequest((current) => current + 1);
  }

  /**
   * 收起侧栏。焦点在侧栏里（收起按钮、侧栏里按 ⌘J 或 Esc）时交还给当前面板，不随侧栏隐藏落到页面根上：
   * 管理中交给当前管理页；工作区里还给叫出侧栏前的位置，它已不在时交给工作区。
   */
  function collapseSidebar(): void {
    const focusInSidebar = document.activeElement?.closest('.multivac-sidebar');
    setSidebarOpen(false);
    if (!focusInSidebar) return;
    if (showManagement) {
      managementPageRef.current?.focus({ preventScroll: true });
      return;
    }
    const previous = sidebarReturnFocusRef.current;
    const surface = workspaceSurfaceRef.current;
    if (previous?.isConnected && surface?.contains(previous) && previous.checkVisibility()) {
      previous.focus({ preventScroll: true });
    } else {
      surface?.focus({ preventScroll: true });
    }
  }

  /** 叫出或收起 Multivac 侧栏（⌘J 与“?”菜单）；只在工作区与管理中可用。 */
  function toggleSidebar(): void {
    if (!canToggleSidebar) return;
    if (sidebarVisible) collapseSidebar();
    else summonSidebar();
  }

  /** 交给 Multivac：展开侧栏，把引用写入侧栏输入区并聚焦；当前会话保持原样。 */
  function handToMultivac(quote: AssistantQuote): void {
    openSidebar();
    setHandoff((current) => ({ id: (current?.id ?? 0) + 1, quote }));
  }

  /** 切换并排 / 浮层：只记在本机，刷新后保持。 */
  function changeSidebarDock(dock: SidebarDock): void {
    rememberSidebarDock(dock);
    setSidebarDock(dock);
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
        active={showManagement && currentPage === 'sessions'}
        onOpenInWorkspace={(session) => void openSessionInWorkspace(session)}
      />
    ),
    projects: <ProjectsPage request={projectSettingsRequest} />,
    authorizations: <AuthorizationRecordsPage active={showManagement && currentPage === 'authorizations'} />,
    models: (
      <ModelSettingsPage
        onDirtyChange={setModelSettingsDirty}
        onBusyChange={setModelSettingsBusy}
        discardSignal={modelSettingsDiscardSignal}
        active={showManagement && currentPage === 'models'}
      />
    ),
    preferences: <PreferencesPage active={showManagement && currentPage === 'preferences'} />,
  };

  return (
    <div className={`app-shell ${showManagement ? 'management-mode' : 'work-mode'}${narrow ? ' narrow' : ''}`}>
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
            {showManagement && <small>管理</small>}
          </span>
        </button>

        {showManagement && <div className="shell-page-name">{managementPage(currentPage).label}</div>}

        {/* 右侧各层一致：面板跳转（⌘G）与侧栏（⌘J）靠快捷键，“?”里列出并可直接点。窄屏没有快捷键，不放“?”。 */}
        <div className="shell-actions">
          {showAuthorizationAttention && (
            <>
              <button
                type="button"
                className="shell-attention"
                aria-label="Multivac 等待你的授权，打开侧栏处理"
                title={`Multivac 等待你的授权：打开侧栏处理（${MULTIVAC_SIDEBAR_SHORTCUT.hint}）`}
                onClick={summonSidebar}
              >
                <span className="shell-attention-dot" aria-hidden="true" />
                <span>等待你的授权</span>
              </button>
              <span className="shell-divider" aria-hidden="true" />
            </>
          )}
          {!narrow && (
            <ShortcutHelp
              sidebarOpen={sidebarVisible}
              canToggleSidebar={canToggleSidebar}
              onToggleSidebar={toggleSidebar}
              onOpenPanelSwitcher={() => setPanelSwitcherOpen(true)}
            />
          )}
        </div>
      </header>

      <div className="shell-body">
        {showManagement && <ManagementNav current={currentPage} onNavigate={openManagementPage} />}

        <div className="shell-content">
          {desktopOnly && (
            <DesktopOnlyNotice
              surface={managementMode ? '管理' : '工作区'}
              onGoHome={() => void goHome()}
              goHomeDisabled={managementMode && modelSettingsBusy}
            />
          )}

          <div className="work-surface" hidden={!assistantVisible}>
            <AssistantView
              active={assistantVisible}
              onManageModels={() => openManagementPage('models')}
            />
          </div>

          {/* 工作区首次进入后保持挂载：来回切换不重建会话，也不丢草稿、阅读位置与焦点。 */}
          {workspaceOpened && (
            <div
              ref={workspaceSurfaceRef}
              className="work-surface"
              hidden={!workspaceVisible}
              tabIndex={-1}
            >
              <WorkspaceShell
                active={workspaceVisible}
                onManageModels={() => openManagementPage('models')}
                onManageProject={openProjectSettings}
                openRequest={workspaceOpenRequest}
                onFocusChange={setWorkspaceFocus}
                onHandToMultivac={handToMultivac}
              />
            </div>
          )}

          <div
            ref={managementShellRef}
            className={`management-shell${sidebarPushes ? ' with-sidebar' : ''}`}
            hidden={!showManagement}
          >
            {MANAGEMENT_PAGES.filter((page) => openedPages.has(page.id)).map((page) => (
              <ManagementPageFrame
                key={page.id}
                // 只有当前页接收焦点引用，进入管理或切换页面时由它接管焦点。
                ref={page.id === currentPage ? managementPageRef : undefined}
                page={page}
                hidden={!showManagement || page.id !== currentPage}
              >
                {managementPageContent[page.id]}
              </ManagementPageFrame>
            ))}
          </div>

          {/*
            Multivac 侧栏：工作区与管理共用同一个呈现实例，停靠在当前面板右侧；并排时挤压页面
            （管理页按自身可用宽度排版，工作区的并排栏不窄于 320px，放不下时工作区自己横向滚动），
            浮层时覆盖在页面右侧。首页本身就是 Multivac 对话，不显示侧栏。
          */}
          {sidebarMounted && (
            <MultivacSidebar
              visible={sidebarVisible}
              dock={sidebarDock}
              onDockChange={changeSidebarDock}
              onCollapse={collapseSidebar}
              onManageModels={() => openManagementPage('models')}
              shortcut={MULTIVAC_SIDEBAR_SHORTCUT}
              context={sidebarContext}
              incomingQuote={handoff}
              onIncomingQuoteHandled={() => setHandoff(null)}
              focusRequest={sidebarFocusRequest}
            />
          )}
        </div>
      </div>

      {panelSwitcherOpen && !narrow && (
        <PanelSwitcher
          current={currentPanel}
          onPick={(panel) => void goToPanel(panel)}
          onClose={() => setPanelSwitcherOpen(false)}
        />
      )}
    </div>
  );
}
