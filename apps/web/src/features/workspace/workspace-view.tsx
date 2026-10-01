import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Columns3,
  Columns4,
  Folder,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  assignSlotInScene,
  DEFAULT_WORKSPACE_ID,
  RECENT_WORKSPACE_ID,
  DEFAULT_RECENT_DAYS,
  recentSessions,
  DEFAULT_WORKSPACE_SCENE,
  focusSessionInScene,
  normalizeWorkspaceSessionTitle,
  replaceInSlots,
  resizeParallelInScene,
  resolvedScene,
  switchViewModeInScene,
  WORKSPACE_PARALLEL_OPTIONS,
  WORKSPACE_SESSION_TITLE_MAX_LENGTH,
  type AssistantQuote,
  type Workspace,
  type WorkspaceScene,
  type WorkspaceSceneState,
  type WorkspaceSession,
  type WorkspaceViewMode,
} from '@multivac/contracts';
import { AssistantApiError } from '../../data/assistant-api.js';
import { windowId } from '../../data/window-id.js';
import {
  createWorkspaceSession,
  getWorkspaceScene,
  putWorkspaceScene,
} from '../../data/workspace-api.js';
import { useConfirm } from '../../components/confirm-card.js';
import { confirmArchive } from './archive-confirm.js';
import { restoreNoticeText } from './temp-retention.js';
import { ConversationPanel } from './conversation-panel.js';
import { MoveToProjectCard } from './move-to-project-card.js';
import { moveResultText } from './move-to-project.js';
import { ResizablePanes } from './resizable-panes.js';
import { returnableParent, stackPath, type StackPlace } from './session-stack.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import type { WorkspaceOpenRequest } from './workspace-shell.js';
import type { WorkspaceViewReport } from '../assistant/current-view.js';
import { rebaseSceneChanges, sceneEventAction } from '../workbench/workbench-sync.js';
import { useWorkspaces, useWorkspaceSessions } from './workspace-sessions-provider.js';
import { workspaceName } from './workspaces.js';
import { usePreferences } from '../preferences/use-preferences.js';
import { WorkspaceRail } from './workspace-rail.js';

/** 现场变化后延迟保存，拖动分隔线等连续操作只写一次。 */
const SCENE_SAVE_DELAY_MS = 300;

type ViewMode = WorkspaceViewMode;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface WorkspaceViewProps {
  /** 当前工作区；切换工作区时外层以新的 key 重建本组件。 */
  workspaceId: string;
  onSwitchWorkspace: (workspaceId: string) => void;
  /** 本页各工作区的最新现场（带服务端版本）：进入时优先使用，离开后切回来原样恢复。 */
  sceneCache: Map<string, WorkspaceScene>;
  /** 工作区是否正在显示；隐藏时会话保持挂载但不抢焦点。 */
  active: boolean;
  railVisible: boolean;
  railOverlay: boolean;
  onToggleRail: () => void;
  onCloseOverlay: () => void;
  onChooseLayout: (columns: number) => void;
  onManageModels: () => void;
  /** 从别处（管理 · 会话页、对话、Multivac 的导航）打开的本工作区会话；id 递增表示一次新的打开。 */
  openRequest?: Pick<WorkspaceOpenRequest, 'id' | 'sessionId' | 'layout'> | null;
  /** 打开请求处理完成（已聚焦）。 */
  onOpenHandled?: () => void;
  /** 当前焦点会话变化时通知外层（Multivac 侧栏据此解析“这个”）。 */
  onFocusChange?: (focus: { sessionId: string; title: string } | null) => void;
  /** 把会话中选中的内容交给 Multivac 侧栏。 */
  onHandToMultivac?: (quote: AssistantQuote) => void;
  /** 到另一个工作区中打开会话（切换工作区并聚焦它），如归入项目后跟过去。 */
  onOpenSession?: (workspaceId: string, sessionId: string) => void;
  /**
   * 本工作区与界面呈现的现场（并排数、视图、各栏会话、当前会话）变化时通知外层：
   * 向 Multivac 发送消息时作为当前视图带上，用来理解“第二栏那个”。现场读完之前 scene 为 null。
   */
  onViewChange?: (report: WorkspaceViewReport) => void;
}

/** 工作区顶部的一条提示（如归入项目的结果），可带一个“到那里打开”的操作。 */
interface WorkspaceNotice {
  text: string;
  open: { workspaceId: string; workspaceName: string; sessionId: string } | null;
}

/**
 * 工作区：一个工作区中的工作会话，并排或聚焦查看与推进。
 *
 * 并排数决定同时展示几栏，栏位记录每一栏的会话；聚焦模式只展示当前会话。
 * 会话列表、现场与“已归档”区只看本工作区；项目工作区中新建的会话使用项目目录。
 */
export function WorkspaceView({
  workspaceId, onSwitchWorkspace, sceneCache, active, onManageModels, openRequest = null, onOpenHandled,
  onFocusChange, onHandToMultivac, onOpenSession, onViewChange, railVisible, railOverlay, onToggleRail, onCloseOverlay, onChooseLayout,
}: WorkspaceViewProps) {
  // 工作区与工作会话列表在应用内只有一份，其他界面的改名、归档、恢复在这里即时可见。
  const workspaceSessions = useWorkspaceSessions();
  const { ensureLoaded, upsert } = workspaceSessions;
  const { workspaces, ensureLoaded: ensureWorkspacesLoaded } = useWorkspaces();
  const name = workspaceName(workspaces, workspaceId);
  const { preferences } = usePreferences();
  const [clock, setClock] = useState(Date.now);
  const now = Math.max(clock, Date.now());
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const recentDays = preferences?.recentDays ?? DEFAULT_RECENT_DAYS;
  useEffect(() => { if (workspaceId === RECENT_WORKSPACE_ID && preferences && !recentDays) onSwitchWorkspace(DEFAULT_WORKSPACE_ID); }, [workspaceId, preferences, recentDays, onSwitchWorkspace]);
  // 本工作区的全部会话（含已归档），按创建时间升序；栏位、现场与计数只看未归档的。
  const sessions = workspaceSessions.sessions === null ? null : workspaceId === RECENT_WORKSPACE_ID
    ? recentSessions(workspaceSessions.sessions, recentDays, now).reverse()
    : workspaceSessions.sessions.filter((session) => session.workspaceId === workspaceId);
  const [loadError, setLoadError] = useState('');
  const [parallelCount, setParallelCount] = useState(DEFAULT_WORKSPACE_SCENE.parallelCount);
  // 已放置的栏位；空出的栏按会话列表顺序补位。
  const [storedSlots, setSlots] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('parallel');
  // 按并排数分别记住的各栏相对宽度。
  const [widths, setWidths] = useState<WorkspaceSceneState['widths']>({});
  const [barVisible, setBarVisible] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creationWorkspaceId, setCreationWorkspaceId] = useState(workspaceId);
  const [actionError, setActionError] = useState('');
  // 正在归入项目的会话（确认卡打开期间）；记下会话本身，归入后它离开本工作区也不影响卡片收尾。
  const [moving, setMoving] = useState<WorkspaceSession | null>(null);
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const pickerRef = useRef<HTMLDivElement>(null);
  // 现场读取完成前不保存，避免用默认值覆盖服务端记住的现场。
  const [sceneLoaded, setSceneLoaded] = useState(false);
  // 本窗口所知的服务端现场版本：保存时经 If-Match 声明，别处推送来的现场只应用比它新的。
  const revisionRef = useRef(0);
  // 读取完成前推送来的别处改动：读取结果可能更早，读取落地后按版本取较新的一个。
  const earlyRemoteRef = useRef<WorkspaceScene | null>(null);
  // 本窗口上次与服务端一致的现场（读取、保存成功、应用别处的现场时）：应用别处的现场时据此判断本窗口改过什么。
  const baseSceneRef = useRef<WorkspaceSceneState>(DEFAULT_WORKSPACE_SCENE);
  // 当前会话由别处改变时（其他窗口、Multivac），新的当前会话不接住焦点；本窗口再切换当前会话后恢复。
  const [remoteCurrentId, setRemoteCurrentId] = useState<string | null>(null);

  /** 把现场各项写入本地状态（读取、或应用别处的改动时）。 */
  const setSceneState = useCallback((saved: WorkspaceSceneState) => {
    setParallelCount(saved.parallelCount);
    setSlots(saved.slots);
    setFocusedId(saved.focusedSessionId);
    setViewMode(saved.viewMode);
    setWidths(saved.widths);
    setBarVisible(saved.barVisible);
  }, []);

  // 只采用最近一次读取的结果：开发模式下 effect 会执行两次，较早的读取不得覆盖之后的现场与聚焦。
  const loadIdRef = useRef(0);
  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    setLoadError('');
    try {
      // 本页打开过的工作区直接用记下的最新现场；否则读取服务端保存的现场。
      const cached = sceneCache.get(workspaceId);
      const scenePromise = cached ? Promise.resolve(cached) : getWorkspaceScene(workspaceId);
      const [, listed] = await Promise.all([ensureLoaded(), ensureWorkspacesLoaded()]);
      if (loadId !== loadIdRef.current) {
        scenePromise.catch(() => undefined);
        return;
      }
      // 记住的工作区已不存在时回到默认工作区。
      if (workspaceId !== DEFAULT_WORKSPACE_ID && workspaceId !== RECENT_WORKSPACE_ID && !listed.some((item) => item.workspaceId === workspaceId)) {
        scenePromise.catch(() => undefined);
        onSwitchWorkspace(DEFAULT_WORKSPACE_ID);
        return;
      }
      const loaded = await scenePromise;
      if (loadId !== loadIdRef.current) return;
      const early = earlyRemoteRef.current;
      earlyRemoteRef.current = null;
      const saved = early && early.revision > loaded.revision ? early : loaded;
      revisionRef.current = saved.revision;
      baseSceneRef.current = saved.scene;
      setSceneState(saved.scene);
      setSceneLoaded(true);
    } catch (error) {
      if (loadId === loadIdRef.current) setLoadError(errorText(error, '工作区读取失败。'));
    }
  }, [ensureLoaded, ensureWorkspacesLoaded, onSwitchWorkspace, sceneCache, setSceneState, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 会话列表按创建时间倒序：新会话在前，空出的栏也按这个顺序补位。已归档的收在列表底部，可以恢复。
  const allSessions = sessions ?? [];
  const sceneIds = allSessions.filter((session) => session.archivedAt === null).map((session) => session.sessionId).reverse();
  const archivedIds = allSessions.filter((session) => session.archivedAt !== null).map((session) => session.sessionId).reverse();
  // 界面实际呈现（也是保存）的现场：空出的栏按列表顺序补位，当前会话不在工作区中时取第一栏。
  const scene = resolvedScene({
    parallelCount, slots: storedSlots, focusedSessionId: focusedId, viewMode, widths, barVisible,
  }, sceneIds);
  const parallelIds = scene.slots;
  const currentId = scene.focusedSessionId;
  // 补位的结果一经呈现就固定下来（与保存到服务端的一致），之后别处新建或恢复的会话只补进空栏，不挤动正在显示的会话。
  // 否则本窗口按未补位的栏位重新补位，顺序与读取了已保存现场的窗口不同，各自保存时互相冲突。
  const filledKey = parallelIds.filter((id) => !storedSlots.includes(id)).join('\n');
  const visibleIds = viewMode === 'parallel' ? parallelIds : currentId ? [currentId] : [];
  const titleOf = (id: string) => sessions?.find((session) => session.sessionId === id)?.title ?? '';
  const sessionOf = (id: string) => sessions?.find((session) => session.sessionId === id);
  // 栈式路径沿全部工作区的父会话链取名称：父会话归入了别的项目时注明它所在的工作区。
  const everySession = workspaceSessions.sessions ?? [];
  const parentOf = (id: string) => returnableParent(everySession, id, sessionOf(id)?.workspaceId ?? workspaceId);
  const place: StackPlace = { workspaceId, nameOf: (id) => workspaceName(workspaces, id) };

  useEffect(() => {
    if (!sceneLoaded || !filledKey) return;
    const filled = filledKey.split('\n');
    setSlots((current) => [...current, ...filled.filter((id) => !current.includes(id))]);
  }, [filledKey, sceneLoaded]);

  // 会话被归档（无论在哪里归档）后移出栏位与当前会话，空出的栏按列表顺序补位；
  // 之后恢复时只补进空栏，不会回到原来的栏位、替换正在展示的会话。
  const archivedKey = archivedIds.join('\n');
  useEffect(() => {
    const archived = new Set(archivedKey.split('\n'));
    setSlots((current) => current.some((id) => archived.has(id)) ? current.filter((id) => !archived.has(id)) : current);
    setFocusedId((current) => current && archived.has(current) ? null : current);
  }, [archivedKey]);

  // 现场变化后延迟保存；页面离开或卸载时立即以 keepalive 写出最后一次现场。
  // 保存基于本窗口所知的版本：别处已改过（版本冲突）时读回并应用最新现场，本窗口尚未保存的改动保存在新版本之上。
  const sceneJson = JSON.stringify(scene);
  const pendingSceneRef = useRef<string | null>(null);
  // 已与服务端一致的呈现结果（刚保存成功的、刚应用的别处现场）：与它相同时不必保存，也不会把别处的现场写回去。
  const syncedSceneJsonRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  // 应用别处的现场后仍有本窗口的改动要保存时递增，让保存重新排期（呈现可能没有变化）。
  const [rebaseCount, setRebaseCount] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * 应用别处的现场：以服务端为准，本窗口尚未保存的改动按部分保留（见 rebaseSceneChanges），随后保存在新版本之上；
   * 当前会话由别处改变时不抢焦点。
   */
  const applyRemoteScene = (saved: WorkspaceScene): void => {
    revisionRef.current = saved.revision;
    sceneCache.set(workspaceId, saved);
    const next = rebaseSceneChanges(baseSceneRef.current, scene, saved.scene, sceneIds);
    baseSceneRef.current = saved.scene;
    const remoteJson = JSON.stringify(resolvedScene(saved.scene, sceneIds));
    const nextScene = resolvedScene(next, sceneIds);
    const nextJson = JSON.stringify(nextScene);
    syncedSceneJsonRef.current = remoteJson;
    pendingSceneRef.current = nextJson === remoteJson ? null : nextJson;
    if (nextJson !== remoteJson) setRebaseCount((count) => count + 1);
    if (nextScene.focusedSessionId !== currentId) setRemoteCurrentId(nextScene.focusedSessionId);
    setSceneState(next);
  };
  const applyRemoteSceneRef = useRef(applyRemoteScene);
  applyRemoteSceneRef.current = applyRemoteScene;

  /** 记下服务端已有的新版本（本窗口保存成功，或收到本窗口保存的推送）；内容本窗口已有。 */
  const noteRevision = useCallback((revision: number) => {
    if (revision <= revisionRef.current) return false;
    revisionRef.current = revision;
    const cached = sceneCache.get(workspaceId);
    if (cached && cached.revision < revision) sceneCache.set(workspaceId, { ...cached, revision });
    return true;
  }, [sceneCache, workspaceId]);

  /** 读回服务端现场，比本窗口所知的新时应用（版本冲突后、事件流重连后）。 */
  const resyncScene = useCallback(async () => {
    try {
      const saved = await getWorkspaceScene(workspaceId);
      if (mountedRef.current && saved.revision > revisionRef.current) applyRemoteSceneRef.current(saved);
    } catch {
      // 读取失败时保留当前界面，下次重连或保存时再对齐。
    }
  }, [workspaceId]);

  const flushScene = useCallback((keepalive: boolean) => {
    const flush = (keepalive: boolean): void => {
      const pending = pendingSceneRef.current;
      if (pending === null) return;
      // 同一时间只有一个保存在途，下一次保存基于上一次保存后的版本；页面离开时不再等待。
      if (savingRef.current && !keepalive) return;
      pendingSceneRef.current = null;
      savingRef.current = true;
      // 保存在途时服务端的现场尚未确定，不再以“与服务端一致”为由跳过之后的变化。
      syncedSceneJsonRef.current = null;
      void putWorkspaceScene(workspaceId, JSON.parse(pending) as WorkspaceSceneState, {
        baseRevision: revisionRef.current, keepalive,
      }).then((saved) => {
        if (noteRevision(saved.revision)) syncedSceneJsonRef.current = pending;
        // 这次保存的就是服务端的最新内容（之后没有更新的版本）：以它为本窗口与服务端一致的现场。
        if (saved.revision === revisionRef.current) baseSceneRef.current = JSON.parse(pending) as WorkspaceSceneState;
      }).catch(async (error: unknown) => {
        // 版本冲突：别处已改过现场，读回并应用（本窗口尚未保存的改动随后保存在新版本之上）。
        // 其他失败时保留当前界面，下一次变化会再次保存。
        if (error instanceof AssistantApiError && error.code === 'WORKSPACE_SCENE_CONFLICT') await resyncScene();
      }).finally(() => {
        savingRef.current = false;
        if (mountedRef.current) flush(false);
      });
    };
    flush(keepalive);
  }, [noteRevision, resyncScene, workspaceId]);
  useEffect(() => {
    if (!sceneLoaded) return;
    sceneCache.set(workspaceId, { workspaceId, scene: JSON.parse(sceneJson) as WorkspaceSceneState, revision: revisionRef.current });
    // 与服务端一致（刚保存成功，或刚应用了别处的现场）时不保存：也就不会把收到的现场写回去。
    if (sceneJson === syncedSceneJsonRef.current) {
      pendingSceneRef.current = null;
      return;
    }
    pendingSceneRef.current = sceneJson;
    const timer = window.setTimeout(() => flushScene(false), SCENE_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [flushScene, rebaseCount, sceneCache, sceneJson, sceneLoaded, workspaceId]);
  useEffect(() => {
    const onPageHide = () => flushScene(true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flushScene(true);
    };
  }, [flushScene]);

  // 别处的改动推送到本窗口：本窗口直接发起的只记下新版本，其他（其他窗口、Multivac）按版本应用；
  // 事件流连上或重连后读回一次，补齐断线期间的改动。
  useWorkbenchEvents((event) => {
    if (event.type === 'workbench.connected') {
      if (sceneLoaded) void resyncScene();
      return;
    }
    if (event.type !== 'scene.changed') return;
    if (!sceneLoaded) {
      if (event.scene.workspaceId === workspaceId && event.scene.revision > (earlyRemoteRef.current?.revision ?? -1)) {
        earlyRemoteRef.current = event.scene;
      }
      return;
    }
    const action = sceneEventAction(event.scene, event.origin, {
      workspaceId, knownRevision: revisionRef.current, windowId: windowId(),
    });
    if (action === 'acknowledge') noteRevision(event.scene.revision);
    else if (action === 'apply') applyRemoteScene(event.scene);
  });

  // 本窗口切换了当前会话后，恢复“成为当前会话即接住焦点”。
  useEffect(() => {
    if (remoteCurrentId !== null && currentId !== remoteCurrentId) setRemoteCurrentId(null);
  }, [currentId, remoteCurrentId]);

  // Cmd/Ctrl+\ 显示或隐藏工作区条，只在工作区可见时生效。
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== '\\') return;
      event.preventDefault();
      setBarVisible((current) => !current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active]);

  const currentTitle = currentId ? titleOf(currentId) : '';
  useEffect(() => {
    onFocusChange?.(currentId ? { sessionId: currentId, title: currentTitle } : null);
  }, [currentId, currentTitle, onFocusChange]);

  // 界面呈现的现场按内容比较，内容不变时不重复通知。
  const viewReportJson = sceneLoaded
    ? JSON.stringify({ parallelCount, viewMode, slots: parallelIds, focusedSessionId: currentId })
    : null;
  useEffect(() => {
    onViewChange?.({ workspaceId, scene: viewReportJson ? JSON.parse(viewReportJson) as WorkspaceViewReport['scene'] : null });
  }, [workspaceId, viewReportJson, onViewChange]);

  /**
   * 按现场操作（与 Multivac 的工作区工具同一套规则，见契约 workspace-scene）改本地现场：
   * 操作的输入是界面呈现的现场；栏位只在操作改变了它时写回（没改时空栏仍按会话列表补位），随后按常规保存。
   */
  function applyScene(next: WorkspaceSceneState): void {
    if (next.slots !== scene.slots) setSlots(next.slots);
    if (next.focusedSessionId !== focusedId) setFocusedId(next.focusedSessionId);
    if (next.parallelCount !== scene.parallelCount) setParallelCount(next.parallelCount);
    setViewMode(next.viewMode);
  }

  /** 从列表打开会话：聚焦查看，栏位不变。 */
  function focusSession(id: string): void {
    applyScene(focusSessionInScene(scene, id));
  }

  // 现场读取完成后再处理打开请求，否则读取到的现场会覆盖这次聚焦。
  // 打开的会话同时把焦点交给它的输入区：它本来就是当前会话时，成为当前会话不会再次接住焦点。
  // 焦点请求只随这一次渲染交给面板（面板在提交时处理），随后撤下，之后面板重新挂载也不会再抢焦点。
  const handledOpenRef = useRef(0);
  const openFocusCountRef = useRef(0);
  const [openedFocus, setOpenedFocus] = useState<{ sessionId: string; request: number } | null>(null);
  useEffect(() => {
    if (!openRequest || !sceneLoaded || openRequest.id === handledOpenRef.current) return;
    handledOpenRef.current = openRequest.id;
    const { sessionId } = openRequest;
    if (sessionId) {
      // focus：界面上的“在工作区打开”，聚焦查看它；keep：现场已由 Multivac 在服务端排好（随推送应用），只交出输入焦点。
      if (openRequest.layout === 'focus') focusSession(sessionId);
      else if (openRequest.layout === 'navigate') {
        if (viewMode === 'parallel' && parallelIds.includes(sessionId)) setFocusedId(sessionId);
        else focusSession(sessionId);
      }
      openFocusCountRef.current += 1;
      setOpenedFocus({ sessionId, request: openFocusCountRef.current });
    }
    onOpenHandled?.();
  }, [openRequest, sceneLoaded]);
  useEffect(() => {
    if (openedFocus) setOpenedFocus(null);
  }, [openedFocus]);

  /**
   * 由用户指定把会话放进第几栏：原来在这一栏的会话换下来；已在另一栏则两栏互换。
   * 聚焦模式下选栏会切回并排，放好后该会话成为当前会话。
   */
  function assignSlot(id: string, slot: number): void {
    onCloseOverlay();
    applyScene(assignSlotInScene(scene, id, slot));
  }

  /** 调整并排数：多出的会话退出显示但不关闭，当前会话始终保留在显示中。 */
  function changeParallelCount(count: number): void {
    onChooseLayout(count);
    applyScene(resizeParallelInScene(scene, count));
  }

  /** 回到并排时，当前会话若不在并排位则改为聚焦并排的第一栏。 */
  function switchViewMode(mode: ViewMode): void {
    onChooseLayout(mode === 'parallel' ? parallelCount : 1);
    applyScene(switchViewModeInScene(scene, mode));
  }

  function handleCreated(session: WorkspaceSession): void {
    upsert(session);
    if (session.workspaceId !== workspaceId) {
      setCreating(false);
      onOpenSession?.(session.workspaceId, session.sessionId);
      return;
    }
    // 新会话放进第一栏，原来的会话依次后移。
    setSlots([session.sessionId, ...parallelIds].slice(0, parallelCount));
    setFocusedId(session.sessionId);
    setViewMode('focus');
    setCreating(false);
  }

  /**
   * 深入一层：基于选中内容新建子会话，出现在父会话原来的位置（同一栏或聚焦位），
   * 视图模式、其他栏和列宽都不变；父会话保持原样，可逐层返回。
   */
  async function drillDown(parentId: string, quote: AssistantQuote): Promise<void> {
    setActionError('');
    try {
      // 子会话由服务端放在父会话所在的工作区（即本工作区）。
      const child = await createWorkspaceSession(crypto.randomUUID(), stackChildTitle(quote.text), {
        parent: { sessionId: parentId, quote },
      });
      upsert(child);
      setSlots(replaceInSlots(parallelIds, parentId, child.sessionId));
      setFocusedId(child.sessionId);
    } catch (error) {
      setActionError(errorText(error, '深入一层失败，请重试。'));
    }
  }

  /**
   * 返回父会话：父会话回到子会话所在的位置（同一栏或聚焦位）并成为当前会话，
   * 随后直接归档这个子会话（可在“已归档”中恢复）。归档失败（例如子会话仍在运行）时
   * 仍停在父会话，子会话保持未归档并给出提示。
   */
  async function backToParent(childId: string): Promise<void> {
    const parentId = parentOf(childId);
    if (!parentId) return;
    setActionError('');
    const parent = everySession.find((session) => session.sessionId === parentId);
    if (workspaceId === RECENT_WORKSPACE_ID && !sceneIds.includes(parentId) && parent) {
      onOpenSession?.(parent.workspaceId, parentId);
    } else {
      setSlots(replaceInSlots(parallelIds, childId, parentId));
      setFocusedId(parentId);
    }

    try {
      await workspaceSessions.archive(childId);
    } catch (error) {
      setActionError(`已返回父会话，但「${titleOf(childId)}」未能归档：${errorText(error, '请稍后在会话列表中归档。')}`);
    }
  }

  function openCreation(): void {
    setCreationWorkspaceId(workspaceId);
    setCreating(true);
  }

  /** 打开归入项目的确认卡；从会话列表打开时先收起列表。 */
  function startMove(id: string): void {
    const session = sessionOf(id);
    if (!session) return;
    setNotice(null);
    setMoving(session);
  }

  /**
   * 归入完成：会话已离开本工作区（栏位随之空出，按列表顺序补位），这里留一条结果提示，
   * 可以一键到项目工作区中打开它继续。
   */
  function handleMoved(session: WorkspaceSession, text: string, target: { workspaceId: string; name: string }): void {
    setMoving(null);
    setNotice({ text, open: { workspaceId: target.workspaceId, workspaceName: target.name, sessionId: session.sessionId } });
  }

  /**
   * 在“已归档”区恢复会话：它按列表顺序补进空栏。临时目录在归档期间已到期移到废纸篓时，
   * 服务端重建了空目录，这里在顶部写明何时移走、移到了哪里。
   */
  async function restoreSession(id: string): Promise<void> {
    const result = await workspaceSessions.restore(id);
    const text = restoreNoticeText(result.session.title, result);
    if (text) setNotice({ text, open: null });
  }

  /** 标题栏菜单的归档：与会话列表同一张确认卡。 */
  async function archiveFromPanel(id: string): Promise<void> {
    await confirmArchive(confirm, {
      sessionId: id,
      title: titleOf(id),
      action: () => workspaceSessions.archive(id),
      // 会话随之离开栏位，焦点交给会话列表入口。
      fallbackFocus: () => pickerRef.current?.querySelector<HTMLElement>('.rail-folder-toggle'),
    });
  }

  return (
    <div className="workspace-page">
      <div className={`workspace-rail-wrap${railOverlay ? ' overlay' : ''}`} ref={pickerRef} hidden={!railVisible}>
      <WorkspaceRail
        workspaces={workspaces ?? []} recentDays={recentDays} clock={now} workspaceId={workspaceId} slots={parallelIds}
        currentId={currentId} parallelCount={parallelCount}
        onSwitch={onSwitchWorkspace}
        onOpen={(target, id) => {
          onCloseOverlay();
          if (target !== workspaceId) onOpenSession?.(target, id);
          else if (viewMode === 'parallel' && parallelIds.includes(id)) setFocusedId(id);
          else focusSession(id);
        }}
        onCreate={(id) => { setCreationWorkspaceId(id); setCreating(true); }}
        onAssign={assignSlot} onMove={setMoving} onRestore={restoreSession}
      >
        <div className="rail-view" role="group" aria-label="布局">
          <span className="rail-layout-label">{viewMode === 'focus' ? '聚焦' : `并排 ${parallelCount} 栏`}</span>
          <div className="rail-layout" role="radiogroup" aria-label="工作区布局">
            <button type="button" role="radio" title="聚焦：只看当前会话" aria-label="聚焦：只看当前会话" aria-checked={viewMode === 'focus'} disabled={!currentId} onClick={() => switchViewMode('focus')}><Maximize2 /></button>
            {WORKSPACE_PARALLEL_OPTIONS.map((count) => {
              const Icon = count === 2 ? Columns2 : count === 3 ? Columns3 : Columns4;
              return <button type="button" role="radio" key={count} title={`并排 ${count} 栏`} aria-label={`并排 ${count} 栏`} aria-checked={viewMode === 'parallel' && count === parallelCount} onClick={() => count === parallelCount ? switchViewMode('parallel') : changeParallelCount(count)}><Icon /></button>;
            })}
          </div>
        </div>
      </WorkspaceRail>
      <button type="button" className="rail-handle rail-collapse-handle" aria-label="收起工作区侧栏" title="收起工作区侧栏" onClick={onToggleRail}><span className="rail-handle-grip" /><span className="rail-handle-button"><ChevronLeft /></span></button>
      </div>
      {!railVisible && <button type="button" className="rail-handle" aria-label="展开工作区侧栏" title="展开工作区侧栏" onClick={onToggleRail}><span className="rail-handle-grip" /><span className="rail-handle-button"><ChevronRight /></span></button>}
      <div className="workspace-main">

      {actionError && <p className="workspace-error" role="alert">{actionError}</p>}
      {notice && (
        <div className="workspace-notice" role="status" ref={noticeRef}>
          <p>{notice.text}</p>
          {notice.open && onOpenSession && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                const target = notice.open!;
                setNotice(null);
                onOpenSession(target.workspaceId, target.sessionId);
              }}
            >
              在「{notice.open.workspaceName}」中打开
            </button>
          )}
          <button type="button" className="icon-button" aria-label="关闭提示" title="关闭提示" onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      {sessions === null || !sceneLoaded ? (
        <div className="workspace-empty" aria-live="polite">
          {loadError ? (
            <>
              <h2>工作区读取失败</h2>
              <p>{loadError}</p>
              <button type="button" className="secondary-button" onClick={() => void load()}>
                <RefreshCw aria-hidden="true" />
                重试
              </button>
            </>
          ) : (
            <>
              <LoaderCircle className="spin" aria-hidden="true" />
              <p>正在读取工作区会话</p>
            </>
          )}
        </div>
      ) : visibleIds.length === 0 ? (
        <div className="workspace-empty">
          <MessageSquare aria-hidden="true" />
          <h2>{name}还没有会话</h2>
          <p>{workspaceId === RECENT_WORKSPACE_ID ? '当前时间范围内没有活动会话。' : '新建一个会话，在这里并排或聚焦推进工作。'}</p>
          {workspaceId !== RECENT_WORKSPACE_ID && <button type="button" className="secondary-button" onClick={openCreation}>
            <Plus aria-hidden="true" />
            新会话
          </button>}
        </div>
      ) : (
        <WorkspacePanels
          ids={visibleIds}
          widths={widths[visibleIds.length]}
          onWidthsChange={(next) => setWidths((current) => {
            const { [visibleIds.length]: _previous, ...rest } = current;
            return next ? { ...rest, [visibleIds.length]: next } : rest;
          })}
          renderPanel={(id) => (
            <ConversationPanel
              key={id}
              sessionId={id}
              workspaceId={workspaceId}
              title={titleOf(id)}
              workingDirectory={sessionOf(id)?.workingDirectory ?? null}
              visible={active}
              current={id === currentId}
              claimFocus={id !== remoteCurrentId}
              {...(openedFocus?.sessionId === id ? { focusRequest: openedFocus.request } : {})}
              focused={viewMode === 'focus'}
              slotLabel={viewMode === 'parallel' && parallelIds.includes(id) ? `第 ${parallelIds.indexOf(id) + 1} 栏` : ''}
              collapseComposer={viewMode === 'parallel' && id !== currentId}
              onActivate={() => setFocusedId(id)}
              onFocusMode={() => {
                setFocusedId(id);
                setViewMode('focus');
              }}
              onReturnToParallel={() => switchViewMode('parallel')}
              onManageModels={onManageModels}
              {...(onHandToMultivac ? { onHandToMultivac } : {})}
              onDrillDown={(quote) => void drillDown(id, quote)}
              stackPath={stackPath(everySession, id, place)}
              originText={sessionOf(id)?.originText ?? null}
              {...(parentOf(id) ? { onBackToParent: () => void backToParent(id) } : {})}
              onMoveToProject={() => startMove(id)}
              onArchive={() => void archiveFromPanel(id)}
            />
          )}
          titleOf={titleOf}
        />
      )}

      </div>
      {creating && (
        <CreationDialog
          workspaceId={creationWorkspaceId}
          workspaceName={workspaceName(workspaces, creationWorkspaceId)}
          project={workspaces?.find((item) => item.workspaceId === creationWorkspaceId)?.project ?? null}
          onCancel={() => setCreating(false)}
          onCreated={handleCreated}
        />
      )}

      {moving && (
        <MoveToProjectCard
          session={moving}
          onMoved={(result, { project, from }) => handleMoved(result.session, moveResultText({
            title: moving.title, projectName: project.name, from, result,
          }), { workspaceId: project.workspaceId, name: project.name })}
          onCancel={() => setMoving(null)}
          // 会话离开本工作区后打开卡片的按钮随之消失：焦点交给结果提示，或会话列表入口。
          fallbackFocus={() => noticeRef.current?.querySelector<HTMLElement>('button')
            ?? pickerRef.current?.querySelector<HTMLElement>('.rail-folder-toggle')}
        />
      )}
    </div>
  );
}

/** 子会话标题取选中内容的开头；过长时截断。 */
function stackChildTitle(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized;
}

/** 多栏并排时带可拖动分隔线；单栏（聚焦或只有一个会话）直接铺满。 */
function WorkspacePanels({ ids, widths, onWidthsChange, renderPanel, titleOf }: {
  ids: readonly string[];
  widths: readonly number[] | undefined;
  onWidthsChange: (widths: number[] | undefined) => void;
  renderPanel: (id: string) => ReactNode;
  titleOf: (id: string) => string;
}) {
  if (ids.length > 1) {
    return (
      <ResizablePanes widths={widths} onWidthsChange={onWidthsChange} labels={ids.map(titleOf)}>
        {ids.map(renderPanel)}
      </ResizablePanes>
    );
  }
  return (
    <div className="workspace-panels single">
      {ids.map((id) => <div key={id} className="workspace-slot">{renderPanel(id)}</div>)}
    </div>
  );
}

/**
 * 新建会话对话框：输入名称后在当前工作区创建独立的工作会话，并说明它将使用的工作目录。
 */
function CreationDialog({ workspaceId, workspaceName, project, onCancel, onCreated }: {
  workspaceId: string;
  workspaceName: string;
  project: Workspace['project'];
  onCancel: () => void;
  onCreated: (session: WorkspaceSession) => void;
}) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // 同一次填写的重试沿用同一个 id，服务端据此幂等，不会重复新建。
  const sessionIdRef = useRef(crypto.randomUUID());
  const triggerRef = useRef<Element | null>(document.activeElement);
  // 取消时把焦点还给打开对话框的按钮；创建成功后焦点交给新会话的输入区。
  const restoreFocusRef = useRef(true);
  const dialogRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // 对话框仍在页面上时（父组件重渲染换了 onCancel、StrictMode 模拟卸载）不是真的关闭，
      // 不交还焦点，否则名称输入框刚获得焦点就被抢回打开对话框的按钮。
      if (dialog?.isConnected) return;
      if (restoreFocusRef.current && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [onCancel]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const title = normalizeWorkspaceSessionTitle(name);
    if (!title || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const session = await createWorkspaceSession(sessionIdRef.current, title, { workspaceId });
      restoreFocusRef.current = false;
      onCreated(session);
    } catch (cause) {
      setError(errorText(cause, '新建会话失败，请重试。'));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="creation-scrim"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <form
        ref={dialogRef}
        className="creation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-creation-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="creation-header">
          <div>
            <span>{workspaceName}</span>
            <h2 id="workspace-creation-title">创建新会话</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭" title="关闭" onClick={onCancel}>
            <X aria-hidden="true" />
          </button>
        </div>
        <label>
          <span>会话名称</span>
          <input
            autoFocus
            value={name}
            maxLength={WORKSPACE_SESSION_TITLE_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：梳理导航结构"
          />
        </label>
        <p className="creation-note">
          {project
            ? <>新会话属于项目“{project.name}”，在项目目录中工作：<code>{project.directories[0]?.path}</code></>
            : '新会话不属于任何项目，在自己的临时目录里工作。'}
        </p>
        {error && <p className="creation-error" role="alert">{error}</p>}
        <div className="creation-actions">
          <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
          <button
            type="submit"
            className="primary-button"
            disabled={submitting || !normalizeWorkspaceSessionTitle(name)}
          >
            {submitting && <LoaderCircle className="spin" aria-hidden="true" />}
            创建
          </button>
        </div>
      </form>
    </div>
  );
}
