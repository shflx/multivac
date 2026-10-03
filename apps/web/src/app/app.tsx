import { MultivacIcon } from '../components/multivac-icon.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'typebox/value';
import {
  CurrentViewSnapshotSchema,
  type AssistantQuote,
  type CurrentViewSnapshot,
  type ManagementSelection,
  type Project,
  type WindowNavigationTarget,
  type WorkspaceSession,
} from '@multivac/contracts';
import { useAssistantSession } from '../features/assistant/assistant-session.js';
import { AssistantView } from '../features/assistant/assistant-view.js';
import { CurrentViewContext, currentViewSnapshot, type WorkspaceViewReport } from '../features/assistant/current-view.js';
import {
  projectFocus,
  workspaceSessionFocus,
  type MultivacFocus,
} from '../features/assistant/multivac-focus.js';
import {
  MULTIVAC_SIDEBAR_SHORTCUT,
  MultivacSidebar,
  forgetLegacySidebarState,
  rememberSidebarDock,
  rememberedSidebarDock,
  type SidebarDock,
} from '../features/assistant/multivac-sidebar.js';
import { sidebarCollapsesWhenWorking } from '../features/assistant/sidebar-collapse.js';
import { ObjectLinkProvider } from '../features/assistant/object-links.js';
import { pendingAuthorizations } from '../features/assistant/tool-authorizations.js';
import { useConfirm } from '../components/confirm-card.js';
import { ModelSettingsPage } from '../features/models/model-settings-page.js';
import { PreferencesPage } from '../features/preferences/preferences-page.js';
import { ReadingApp } from '../features/reading/reading-app.js';
import { ConversationsPage } from '../features/reading/reading-conversations.js';
import { ReadingCollectionPage } from '../features/reading/reading-collection.js';
import type { BookReference, ReadingMessageSource } from '@multivac/contracts';
import { ProjectsPage, type ProjectSettingsRequest } from '../features/projects/projects-page.js';
import { ArchivePage, type ArchivePageRequest } from '../features/archive/archive-page.js';
import { windowId } from '../data/window-id.js';
import { useWorkbenchEvents } from '../features/workbench/workbench-sync-provider.js';
import { navigationToFollow } from '../features/workbench/workbench-sync.js';
import { WorkspaceShell, type WorkspaceOpenRequest } from '../features/workspace/workspace-shell.js';
import { rememberedWorkspaceId } from '../features/workspace/workspaces.js';
import { DesktopOnlyNotice } from './desktop-only-notice.js';
import { ManagementNav, ManagementPageFrame } from './management-layout.js';
import { MANAGEMENT_PAGES, managementPage, resolveManagementPage, type ManagementPageId } from './management-nav.js';
import { TaskPanel } from '../features/tasks/task-panel.js';
import { useTasks } from '../features/tasks/tasks-provider.js';
import { useWorkspaceStores } from '../features/workspace/workspace-sessions-provider.js';
import { useNarrowViewport } from './narrow-viewport.js';
import { QuickSwitcher } from './quick-switcher.js';
import { PanelSwitcher } from './panel-switcher.js';
import { shellOwnsEscape, shellShortcut, type ShellPanel, type ShellShortcut } from './shell-shortcuts.js';
import { ShortcutHelp } from './shortcut-help.js';
import { useWorkStarted } from './work-started.js';

type AppMode = 'work' | 'management';
/** 管理之外的两个工作面：Multivac 首页与工作区，二者都保持挂载。 */
type WorkSurface = 'assistant' | 'workspace';

export function App() {
  const taskState = useTasks();
  const [navigationError, setNavigationError] = useState('');
  const workspaceStores = useWorkspaceStores();
  const [mode, setMode] = useState<AppMode>('work');
  // 进入管理时回到上次所在的页面，首次进入打开注册表中的第一页。
  const [currentPage, setCurrentPage] = useState<ManagementPageId>(MANAGEMENT_PAGES[0].id);
  // 管理页首次打开后保持挂载，切换页面或离开管理不丢失页面内状态。
  const [openedPages, setOpenedPages] = useState<ReadonlySet<ManagementPageId>>(() => new Set());
  const [readingRequest, setReadingRequest] = useState<{ id: number; bookId: string; sessionId?: string; position?: import('@multivac/contracts').BookPosition; version?: string } | null>(null);
  const [collectionRequest, setCollectionRequest] = useState<{ id: number; targetId: string } | null>(null);
  const [readingFocus, setReadingFocus] = useState<{ title: string; reference: BookReference; discussionId: string | null } | null>(null);
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
  // 各面板正在看的对象：工作区的焦点会话、归档页与项目页选中的对象，分别作为当前视图与侧栏的上下文。
  const [workspaceFocus, setWorkspaceFocus] = useState<{ sessionId: string; title: string } | null>(null);
  const [selectedSession, setSelectedSession] = useState<WorkspaceSession | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  // 工作区视图报告的当前工作区与界面呈现的现场；向 Multivac 发送消息时作为当前视图带上。
  const [workspaceView, setWorkspaceView] = useState<WorkspaceViewReport | null>(null);
  const railToggleRef = useRef<(() => void) | null>(null);
  const [railVisible, setRailVisible] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [panelSwitcherOpen, setPanelSwitcherOpen] = useState(false);
  // 从设置 · 归档页在工作区打开的会话及其所在的工作区；id 递增表示一次新的打开。
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<WorkspaceOpenRequest | null>(null);
  // 从工作区切换菜单“项目设置”打开的项目；id 递增表示一次新的打开。
  const [projectSettingsRequest, setProjectSettingsRequest] = useState<ProjectSettingsRequest | null>(null);
  // Multivac 打开归档页时要选中的会话；id 递增表示一次新的打开。
  const [archivePageRequest, setArchivePageRequest] = useState<ArchivePageRequest | null>(null);
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
  /** 侧栏正在看的对象：工作区的焦点会话，管理中项目页选中的对象；其他页面没有。 */
  const sidebarContext: MultivacFocus | null = workspaceVisible
    ? workspaceSessionFocus(workspaceFocus)
    : showManagement && currentPage === 'projects' ? projectFocus(selectedProject)
    : showManagement && currentPage === 'tasks' && taskState.selected ? { ref: { kind: 'task', taskId: taskState.selected }, label: `任务「${taskState.tasks.find((task) => task.taskId === taskState.selected)?.title ?? taskState.selected}」` } : null;
  const activeReadingFocus = showManagement && currentPage === 'reading' ? readingFocus : null;

  /**
   * 本窗口的当前视图（发送时读取一次）：面板、窄屏、当前工作区与各栏、管理页与选中对象。
   * 快照不符合契约（例如本机记住的工作区 id 已损坏）时不带，服务端如实说明拿不到，而不是让消息发不出去。
   */
  const currentViewRef = useRef<CurrentViewSnapshot | null>(null);
  const view = currentViewSnapshot({
    panel: managementMode ? 'management' : workSurface === 'workspace' ? 'workspace' : 'home',
    narrow,
    workspace: workspaceView,
    rememberedWorkspaceId: rememberedWorkspaceId(),
    managementPage: currentPage,
    selectedSessionId: selectedSession?.sessionId ?? null,
    selectedProjectId: selectedProject?.projectId ?? null,
    selectedTaskId: taskState.selected,
  });
  currentViewRef.current = Check(CurrentViewSnapshotSchema, view) ? view : null;
  if (currentViewRef.current && activeReadingFocus) currentViewRef.current = { ...currentViewRef.current, reading: { bookId: activeReadingFocus.reference.bookId, version: activeReadingFocus.reference.version, start: activeReadingFocus.reference.start, end: activeReadingFocus.reference.end, discussionId: activeReadingFocus.discussionId } };
  const readCurrentView = useCallback(() => currentViewRef.current, []);

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
    if (shortcut === 'quick-switcher') {
      if (!workspaceVisible && !showManagement) return false;
      setPanelSwitcherOpen(false); setQuickSwitcherOpen(true); return true;
    }
    if (shortcut === 'panel-switcher') {
      setQuickSwitcherOpen(false); setPanelSwitcherOpen(true);
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
  async function openManagementPage(page: ManagementPageId): Promise<void> {
    if (managementMode && page !== currentPage && !await allowManagementChange()) return;
    // 兼容旧页面状态及历史回执；未知页回到注册表默认页，避免空白容器。
    page = resolveManagementPage(page);
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
  async function allowManagementChange(): Promise<boolean> {
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
    return true;
  }

  async function leaveManagement(): Promise<boolean> {
    if (!await allowManagementChange()) return false;
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

  /**
   * 进入工作区：离开管理（同样经过离开确认），切到工作区面板与指定的工作区；给出会话时把输入焦点交给它
   * （layout 为 focus 时同时聚焦查看它）。
   */
  async function enterWorkspace(request: Omit<WorkspaceOpenRequest, 'id'>): Promise<void> {
    if (!await leaveManagement()) return;
    switchWorkSurface('workspace');
    setWorkspaceOpenRequest((current) => ({ id: (current?.id ?? 0) + 1, ...request }));
  }

  /** 在工作区打开会话：切到会话所在的工作区并聚焦这个会话。 */
  async function openSessionInWorkspace(session: { sessionId: string; workspaceId: string }): Promise<void> {
    await enterWorkspace({ workspaceId: session.workspaceId, sessionId: session.sessionId, layout: 'focus' });
  }

  async function openTask(taskId: string): Promise<void> {
    if (!await allowManagementChange()) return;
    try { await taskState.store?.open(taskId); setNavigationError(''); await openManagementPage('tasks'); }
    catch (failure) { setNavigationError(failure instanceof Error ? failure.message : '任务未打开。'); }
  }
  async function openTaskSession(sessionId: string): Promise<void> {
    try {
      await workspaceStores.sessions.ensureLoaded();
      const session = workspaceStores.sessions.snapshot()?.find((item) => item.sessionId === sessionId);
      if (!session || session.archivedAt) throw new Error('执行会话不存在或已归档，请从归档页核对。');
      setNavigationError(''); await openSessionInWorkspace(session);
    } catch (failure) { setNavigationError(failure instanceof Error ? failure.message : '执行会话未打开。'); }
  }

  /** 切到某个工作区（对话中的工作区链接、回执上的“切到工作区”）：现场不变，与工作区切换菜单相同。 */
  async function openWorkspace(workspaceId: string): Promise<void> {
    await enterWorkspace({ workspaceId, sessionId: null, layout: 'keep' });
  }

  /** 打开管理中的某一页并选中对象（归档页的会话、项目页的项目）。 */
  function openManagementWithSelection(page: ManagementPageId, selection: ManagementSelection): void {
    if (selection?.kind === 'book') { setReadingRequest(r => ({ id: (r?.id ?? 0) + 1, bookId: selection.bookId, ...(selection.position ? { position: selection.position } : {}), ...(selection.version ? { version: selection.version } : {}) })); void openManagementPage('reading'); return; }
    if (selection?.kind === 'task') { void openTask(selection.taskId); return; }
    if (selection?.kind === 'project') {
      openProjectSettings(selection.projectId);
      return;
    }
    if (selection?.kind === 'session') {
      const { sessionId } = selection;
      setArchivePageRequest((current) => ({ id: (current?.id ?? 0) + 1, sessionId }));
    }
    openManagementPage(page);
  }

  /**
   * Multivac 应用户明确要求切换界面（只推给发起对话的本窗口）：与用户自己切换走同一条路径。
   * 现场（栏位、并排数、视图）已由服务端保存并随推送应用，这里只切换面板、工作区与管理页。
   * 窗口本来就在工作区面板时焦点不动（与别处改动现场一致，焦点通常在侧栏输入区）；从首页或管理切过来时，
   * 原来的焦点随面板隐藏，输入焦点交给切换后的当前会话（与“在工作区打开”一致）。窄屏时不切换。
   */
  function followNavigation(target: WindowNavigationTarget): void {
    if (target.kind === 'management') {
      openManagementWithSelection(target.page, target.selection);
      return;
    }
    void enterWorkspace({
      workspaceId: target.workspaceId,
      sessionId: workspaceVisible ? null : target.sessionId,
      layout: 'keep',
    });
  }
  useWorkbenchEvents((event) => {
    const target = navigationToFollow(event, { windowId: windowId(), narrow });
    if (target) followNavigation(target);
  });

  /**
   * 各管理页的内容；页头与挂载方式由 ManagementPageFrame 统一提供。
   * 新增页面在注册表登记后，在这里补上对应内容（类型保证不会遗漏）。
   * 归档页与项目页把选中的对象报告给外壳，作为发送时的当前视图。
   */
  const managementPageContent: Record<ManagementPageId, ReactNode> = {
    reading: <ReadingApp active={showManagement && currentPage === 'reading'} request={readingRequest} onReport={setReadingFocus} onHandover={handToMultivac} onOpenNotes={targetId => { setCollectionRequest(r => ({ id: (r?.id ?? 0) + 1, targetId })); void openManagementPage('notes'); }} />,
    notes: <ReadingCollectionPage active={showManagement && currentPage === 'notes'} request={collectionRequest} />,
    conversations: <ConversationsPage active={showManagement && currentPage === 'conversations'} openWork={s => void openSessionInWorkspace(s)} openReading={(bookId, sessionId) => { setReadingRequest(r => ({ id: (r?.id ?? 0) + 1, bookId, sessionId })); void openManagementPage('reading'); }} />,
    tasks: <TaskPanel active={showManagement && currentPage === 'tasks'} onOpenSession={(id) => void openTaskSession(id)} />,
    archive: (
      <ArchivePage
        active={showManagement && currentPage === 'archive'}
        request={archivePageRequest}
        onOpenInWorkspace={(session) => void openSessionInWorkspace(session)}
        onSelectionChange={setSelectedSession}
      />
    ),
    projects: (
      <ProjectsPage
        active={showManagement && currentPage === 'projects'}
        request={projectSettingsRequest}
        onSelectionChange={setSelectedProject}
      />
    ),
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
    <CurrentViewContext.Provider value={readCurrentView}>
      <ObjectLinkProvider
        openSession={openSessionInWorkspace}
        openProject={openProjectSettings}
        openWorkspace={openWorkspace}
        openManagementPage={openManagementPage}
        openTask={openTask}
        openBook={(bookId, reference) => { setReadingRequest(r => ({ id: (r?.id ?? 0) + 1, bookId, ...(reference ? { position: reference.start, version: reference.version } : {}) })); void openManagementPage('reading'); }}
      >
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
              <MultivacIcon aria-hidden="true" />
              <span className="logo-copy">
                <strong>Multivac</strong>
                {showManagement && <small>管理</small>}
              </span>
            </button>

            {showManagement && <div className="shell-page-name">{managementPage(currentPage).label}</div>}

            {/* 右侧各层一致：面板跳转（⌘G）与侧栏（⌘J）靠快捷键，“?”里列出并可直接点。窄屏没有快捷键，不放“?”。 */}
            <div className="shell-actions">
              {navigationError && <span role="alert" className="shell-navigation-error">{navigationError}</span>}
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
                  onOpenPanelSwitcher={() => shortcutRef.current('panel-switcher')}
                  canQuickJump={workspaceVisible || showManagement} onQuickJump={() => shortcutRef.current('quick-switcher')}
                  canToggleRail={workspaceVisible} railVisible={railVisible} onToggleRail={() => railToggleRef.current?.()}
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
                    railToggleRef={railToggleRef} onRailVisibleChange={setRailVisible}
                    onManageModels={() => openManagementPage('models')}
                    openRequest={workspaceOpenRequest}
                    onFocusChange={setWorkspaceFocus}
                    onHandToMultivac={handToMultivac}
                    onViewChange={setWorkspaceView}
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
                  context={activeReadingFocus ? { ref: { kind: 'book', reference: activeReadingFocus.reference }, label: `书籍「${activeReadingFocus.title}」` } : sidebarContext}
                  incomingQuote={handoff}
                  onIncomingQuoteHandled={() => setHandoff(null)}
                  focusRequest={sidebarFocusRequest}
                />
              )}
            </div>
          </div>

          {quickSwitcherOpen && !narrow && (workspaceVisible || showManagement) && (
            <QuickSwitcher management={showManagement} page={currentPage} view={workspaceView}
              onTask={(id) => void openTask(id)}
              onSession={(workspaceId, sessionId) => void enterWorkspace({ workspaceId, sessionId, layout: 'navigate' })}
              onPage={(page) => void openManagementPage(page)} onClose={() => setQuickSwitcherOpen(false)} />
          )}
          {panelSwitcherOpen && !narrow && (
            <PanelSwitcher
              current={currentPanel}
              onPick={(panel) => void goToPanel(panel)}
              onClose={() => setPanelSwitcherOpen(false)}
            />
          )}
        </div>
      </ObjectLinkProvider>
    </CurrentViewContext.Provider>
  );
}
