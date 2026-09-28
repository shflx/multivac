import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_SCENE,
  normalizeWorkspaceSessionTitle,
  WORKSPACE_PARALLEL_OPTIONS,
  WORKSPACE_SESSION_TITLE_MAX_LENGTH,
  type AssistantQuote,
  type WorkspaceSceneState,
  type WorkspaceSession,
  type WorkspaceViewMode,
} from '@multivac/contracts';
import {
  createWorkspaceSession,
  getWorkspaceScene,
  putWorkspaceScene,
} from '../../data/workspace-api.js';
import { useConfirm } from '../../components/confirm-card.js';
import { archiveConfirmOptions } from './archive-confirm.js';
import { ConversationPanel } from './conversation-panel.js';
import { ResizablePanes } from './resizable-panes.js';
import { returnableParent, stackLevel, stackPath } from './session-stack.js';
import { placeInSlot, replaceInSlots, resizeSlots, resolveSlots } from './workspace-slots.js';
import { useWorkspaceSessions } from './workspace-sessions-provider.js';
import { DEFAULT_WORKSPACE_NAME } from './workspace-names.js';

/** 首版只有一个默认工作区，不提供切换与新建工作区。 */
const WORKSPACE_NAME = DEFAULT_WORKSPACE_NAME;
/** 现场变化后延迟保存，拖动分隔线等连续操作只写一次。 */
const SCENE_SAVE_DELAY_MS = 300;

type ViewMode = WorkspaceViewMode;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface WorkspaceViewProps {
  /** 工作区是否正在显示；隐藏时会话保持挂载但不抢焦点。 */
  active: boolean;
  onManageModels: () => void;
  /** 从别处（管理 · 会话页）打开的会话：聚焦查看；id 递增表示一次新的打开。 */
  openRequest?: { id: number; sessionId: string } | null;
  /** 当前焦点会话变化时通知外层（工作区侧栏据此解析“这个”）。 */
  onFocusChange?: (focus: { sessionId: string; title: string } | null) => void;
  /** 把会话中选中的内容交给 Multivac 侧栏。 */
  onHandToMultivac?: (quote: AssistantQuote) => void;
}

/**
 * 工作区：用户新建的多个工作会话，并排或聚焦查看与推进。
 *
 * 并排数决定同时展示几栏，栏位记录每一栏的会话；聚焦模式只展示当前会话。
 */
export function WorkspaceView({ active, onManageModels, openRequest = null, onFocusChange, onHandToMultivac }: WorkspaceViewProps) {
  // 工作会话列表在应用内只有一份，其他界面的改名、归档、恢复在这里即时可见。
  const workspaceSessions = useWorkspaceSessions();
  const { ensureLoaded, upsert } = workspaceSessions;
  // 本工作区的全部会话（含已归档），按创建时间升序；栏位、现场与计数只看未归档的。
  const sessions = workspaceSessions.sessions?.filter((session) => session.workspaceId === DEFAULT_WORKSPACE_ID) ?? null;
  const [loadError, setLoadError] = useState('');
  const [parallelCount, setParallelCount] = useState(DEFAULT_WORKSPACE_SCENE.parallelCount);
  // 已放置的栏位；空出的栏按会话列表顺序补位。
  const [storedSlots, setSlots] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('parallel');
  // 按并排数分别记住的各栏相对宽度。
  const [widths, setWidths] = useState<WorkspaceSceneState['widths']>({});
  const [barVisible, setBarVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  // 会话列表底部的“已归档”是否展开；关闭列表后保留。
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  // 现场读取完成前不保存，避免用默认值覆盖服务端记住的现场。
  const [sceneLoaded, setSceneLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [, saved] = await Promise.all([
        ensureLoaded(),
        getWorkspaceScene(DEFAULT_WORKSPACE_ID),
      ]);
      setParallelCount(saved.scene.parallelCount);
      setSlots(saved.scene.slots);
      setFocusedId(saved.scene.focusedSessionId);
      setViewMode(saved.scene.viewMode);
      setWidths(saved.scene.widths);
      setBarVisible(saved.scene.barVisible);
      setSceneLoaded(true);
    } catch (error) {
      setLoadError(errorText(error, '工作区会话读取失败。'));
    }
  }, [ensureLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  // 会话列表按创建时间倒序：新会话在前，空出的栏也按这个顺序补位。已归档的收在列表底部，可以恢复。
  const allSessions = sessions ?? [];
  const sceneIds = allSessions.filter((session) => session.archivedAt === null).map((session) => session.sessionId).reverse();
  const archivedIds = allSessions.filter((session) => session.archivedAt !== null).map((session) => session.sessionId).reverse();
  const parallelIds = resolveSlots(storedSlots, sceneIds, parallelCount);
  const currentId = focusedId && sceneIds.includes(focusedId) ? focusedId : parallelIds[0] ?? null;
  const visibleIds = viewMode === 'parallel' ? parallelIds : currentId ? [currentId] : [];
  const titleOf = (id: string) => sessions?.find((session) => session.sessionId === id)?.title ?? '';
  const sessionOf = (id: string) => sessions?.find((session) => session.sessionId === id);

  // 会话被归档（无论在哪里归档）后移出栏位与当前会话，空出的栏按列表顺序补位；
  // 之后恢复时只补进空栏，不会回到原来的栏位、替换正在展示的会话。
  const archivedKey = archivedIds.join('\n');
  useEffect(() => {
    const archived = new Set(archivedKey.split('\n'));
    setSlots((current) => current.some((id) => archived.has(id)) ? current.filter((id) => !archived.has(id)) : current);
    setFocusedId((current) => current && archived.has(current) ? null : current);
  }, [archivedKey]);

  // 现场变化后延迟保存；页面离开或卸载时立即以 keepalive 写出最后一次现场。
  const scene: WorkspaceSceneState = {
    parallelCount, slots: parallelIds, focusedSessionId: currentId, viewMode, widths, barVisible,
  };
  const sceneJson = JSON.stringify(scene);
  const pendingSceneRef = useRef<string | null>(null);
  const flushScene = useCallback((keepalive: boolean) => {
    const pending = pendingSceneRef.current;
    if (pending === null) return;
    pendingSceneRef.current = null;
    void putWorkspaceScene(DEFAULT_WORKSPACE_ID, JSON.parse(pending) as WorkspaceSceneState, keepalive)
      .catch(() => {
        // 现场只是布局偏好：保存失败时保留当前界面，下一次变化会再次保存。
      });
  }, []);
  useEffect(() => {
    if (!sceneLoaded) return;
    pendingSceneRef.current = sceneJson;
    const timer = window.setTimeout(() => flushScene(false), SCENE_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [flushScene, sceneJson, sceneLoaded]);
  useEffect(() => {
    const onPageHide = () => flushScene(true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flushScene(true);
    };
  }, [flushScene]);

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

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);

  /** 从列表打开会话：聚焦查看，栏位不变。 */
  function focusSession(id: string): void {
    setMenuOpen(false);
    setFocusedId(id);
    setViewMode('focus');
  }

  // 现场读取完成后再处理打开请求，否则读取到的现场会覆盖这次聚焦。
  const handledOpenRef = useRef(0);
  useEffect(() => {
    if (!openRequest || !sceneLoaded || openRequest.id === handledOpenRef.current) return;
    handledOpenRef.current = openRequest.id;
    focusSession(openRequest.sessionId);
  }, [openRequest, sceneLoaded]);

  /**
   * 由用户指定把会话放进第几栏：原来在这一栏的会话换下来；已在另一栏则两栏互换。
   * 聚焦模式下选栏会切回并排，放好后该会话成为当前会话。
   */
  function assignSlot(id: string, slot: number): void {
    setMenuOpen(false);
    setSlots(placeInSlot(parallelIds, id, slot));
    setFocusedId(id);
    setViewMode('parallel');
  }

  /** 调整并排数：多出的会话退出显示但不关闭，当前会话始终保留在显示中。 */
  function changeParallelCount(count: number): void {
    setSlots(resizeSlots(parallelIds, count, currentId));
    setParallelCount(count);
    setViewMode('parallel');
  }

  function switchViewMode(mode: ViewMode): void {
    // 回到并排时，当前会话若不在并排位则改为聚焦并排的第一栏。
    if (mode === 'parallel' && currentId && !parallelIds.includes(currentId)) setFocusedId(parallelIds[0] ?? null);
    setViewMode(mode);
  }

  function handleCreated(session: WorkspaceSession): void {
    upsert(session);
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
      const child = await createWorkspaceSession(crypto.randomUUID(), stackChildTitle(quote.text), {
        sessionId: parentId, quote,
      });
      upsert(child);
      setSlots(replaceInSlots(parallelIds, parentId, child.sessionId));
      setFocusedId(child.sessionId);
    } catch (error) {
      setActionError(errorText(error, '深入一层失败，请重试。'));
    }
  }

  /** 返回父会话：父会话回到子会话所在的位置（同一栏或聚焦位）并成为当前会话。 */
  function backToParent(childId: string): void {
    const parentId = returnableParent(allSessions, childId);
    if (!parentId) return;
    setSlots(replaceInSlots(parallelIds, childId, parentId));
    setFocusedId(parentId);
  }

  function openCreation(): void {
    setMenuOpen(false);
    setCreating(true);
  }

  return (
    <div className="workspace-page">
      {barVisible && (
        <div className="workspace-strip" role="toolbar" aria-label="工作区">
          <div className="workspace-identity">
            <span>工作区</span>
            <strong>{WORKSPACE_NAME}</strong>
          </div>
          <div className="conversation-picker" ref={pickerRef}>
            <button
              type="button"
              className="conversation-picker-trigger"
              aria-expanded={menuOpen}
              aria-haspopup="true"
              onClick={() => setMenuOpen((current) => !current)}
            >
              <MessageSquare aria-hidden="true" />
              <span>会话</span>
              <strong>{visibleIds.length}/{sceneIds.length}</strong>
              <ChevronDown aria-hidden="true" />
            </button>
            {menuOpen && (
              <SessionMenu
                sessionIds={sceneIds}
                archivedIds={archivedIds}
                showArchived={showArchived}
                onToggleArchived={() => setShowArchived((current) => !current)}
                parallelCount={parallelCount}
                titleOf={titleOf}
                levelOf={(id) => stackLevel(allSessions, id)}
                slotIds={parallelIds}
                viewMode={viewMode}
                currentId={currentId}
                onFocus={focusSession}
                onAssignSlot={assignSlot}
                onCreate={openCreation}
                onRename={workspaceSessions.rename}
                onArchive={workspaceSessions.archive}
                onRestore={workspaceSessions.restore}
              />
            )}
          </div>
          <button type="button" className="new-conversation-button" onClick={openCreation}>
            <Plus aria-hidden="true" />
            新会话
          </button>
          <label className="parallel-count" title="同时并排显示的会话数">
            <span>并排数</span>
            <select
              aria-label="并排数"
              value={parallelCount}
              onChange={(event) => changeParallelCount(Number(event.target.value))}
            >
              {WORKSPACE_PARALLEL_OPTIONS.map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          <div className={`view-mode-switch ${viewMode}`} role="group" aria-label="工作区视图">
            <button
              type="button"
              aria-pressed={viewMode === 'parallel'}
              className={viewMode === 'parallel' ? 'active' : ''}
              onClick={() => switchViewMode('parallel')}
            >
              <Columns2 aria-hidden="true" />
              并排
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'focus'}
              className={viewMode === 'focus' ? 'active' : ''}
              disabled={!currentId}
              onClick={() => switchViewMode('focus')}
            >
              <Maximize2 aria-hidden="true" />
              聚焦
            </button>
          </div>
        </div>
      )}

      {actionError && <p className="workspace-error" role="alert">{actionError}</p>}

      {sessions === null ? (
        <div className="workspace-empty" aria-live="polite">
          {loadError ? (
            <>
              <h2>工作区会话读取失败</h2>
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
          <h2>{WORKSPACE_NAME}还没有会话</h2>
          <p>新建一个会话，在这里并排或聚焦推进工作。</p>
          <button type="button" className="secondary-button" onClick={openCreation}>
            <Plus aria-hidden="true" />
            新会话
          </button>
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
              title={titleOf(id)}
              visible={active}
              current={id === currentId}
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
              stackPath={stackPath(allSessions, id)}
              originText={sessionOf(id)?.originText ?? null}
              {...(returnableParent(allSessions, id) ? { onBackToParent: () => backToParent(id) } : {})}
            />
          )}
          titleOf={titleOf}
        />
      )}

      {creating && (
        <CreationDialog onCancel={() => setCreating(false)} onCreated={handleCreated} />
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

interface SessionMenuProps {
  sessionIds: readonly string[];
  /** 已归档的会话，收在列表底部，可以就地恢复。 */
  archivedIds: readonly string[];
  showArchived: boolean;
  onToggleArchived: () => void;
  parallelCount: number;
  titleOf: (id: string) => string;
  /** 栈式层级说明（子会话），顶层会话为空。 */
  levelOf: (id: string) => string | null;
  /** 并排栏位：slotIds[k] 是第 k + 1 栏的会话。 */
  slotIds: readonly string[];
  viewMode: ViewMode;
  currentId: string | null;
  onFocus: (id: string) => void;
  onAssignSlot: (id: string, slot: number) => void;
  onCreate: () => void;
  /** 改名、归档与恢复：结果写回共享的会话列表，归档的会话移到底部，恢复的按创建顺序回到列表。 */
  onRename: (id: string, title: string) => Promise<unknown>;
  onArchive: (id: string) => Promise<unknown>;
  onRestore: (id: string) => Promise<unknown>;
}

/**
 * 会话列表：标注所在栏位，可聚焦查看或指定放进第几栏，也可改名与归档；
 * 已归档的会话收在底部的“已归档 N”，展开后可以就地恢复。
 */
function SessionMenu({
  sessionIds, archivedIds, showArchived, onToggleArchived, parallelCount, titleOf, levelOf, slotIds, viewMode,
  currentId, onFocus, onAssignSlot, onCreate, onRename, onArchive, onRestore,
}: SessionMenuProps) {
  // 会话少于并排数时，只能放进已有会话数以内的栏。
  const slotCount = Math.min(parallelCount, sessionIds.length);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();

  function startRename(id: string): void {
    setError('');
    setRenamingId(id);
    setRenameValue(titleOf(id));
  }

  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    const id = renamingId;
    const title = normalizeWorkspaceSessionTitle(renameValue);
    if (!id || !title) return;
    setBusyId(id);
    try {
      await onRename(id, title);
      setRenamingId(null);
    } catch (cause) {
      setError(errorText(cause, '改名失败，请重试。'));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 归档先经确认卡确认；请求在卡上进行，失败时原因留在卡上，可以重试或取消。
   * 归档可以恢复，按普通操作确认（焦点在“归档”上，Enter 直接确认）。
   */
  async function archive(id: string): Promise<void> {
    setError('');
    await confirm({
      ...archiveConfirmOptions(titleOf(id)),
      action: () => onArchive(id),
      // 归档后这一行移到“已归档”，焦点交给“已归档 N”。
      fallbackFocus: () => menuRef.current?.querySelector<HTMLElement>('.scene-archived-toggle'),
    });
  }

  async function restore(id: string): Promise<void> {
    setError('');
    setBusyId(id);
    try {
      await onRestore(id);
    } catch (cause) {
      setError(errorText(cause, '恢复失败，请重试。'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div ref={menuRef} className="conversation-menu" role="dialog" aria-label="工作区会话">
      <div className="conversation-menu-header">
        <div>
          <strong>{WORKSPACE_NAME}</strong>
          <span>并排 {parallelCount} 栏，选择放进哪一栏</span>
        </div>
        <button type="button" onClick={onCreate}>
          <Plus aria-hidden="true" />
          新会话
        </button>
      </div>
      {error && <p className="conversation-menu-error" role="alert">{error}</p>}
      <div className="conversation-menu-list">
        {sessionIds.length === 0 && <p className="conversation-menu-empty">还没有会话。</p>}
        {sessionIds.map((id) => {
          const slotIndex = slotIds.indexOf(id);
          const placement = slotIndex >= 0 ? `第 ${slotIndex + 1} 栏`
            : viewMode === 'focus' && id === currentId ? '聚焦中' : '未展示';
          return (
          <div key={id} className={`scene-row${id === currentId ? ' selected' : ''}`} data-session-id={id}>
            {renamingId === id ? (
              <form className="scene-rename" onSubmit={(event) => void submitRename(event)}>
                <input
                  aria-label="会话名称"
                  value={renameValue}
                  maxLength={WORKSPACE_SESSION_TITLE_MAX_LENGTH}
                  autoFocus
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.stopPropagation();
                    setRenamingId(null);
                  }}
                />
                <button
                  type="submit"
                  className="icon-button"
                  aria-label="保存名称"
                  title="保存名称"
                  disabled={busyId === id || !normalizeWorkspaceSessionTitle(renameValue)}
                >
                  <Check aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="取消改名"
                  title="取消改名"
                  onClick={() => setRenamingId(null)}
                >
                  <X aria-hidden="true" />
                </button>
              </form>
            ) : (
              <>
                <button type="button" className="scene-open" title="聚焦查看" onClick={() => onFocus(id)}>
                  <span className="conversation-menu-name">
                    <strong>{titleOf(id)}</strong>
                    <small>
                      {levelOf(id) && <span className="scene-level">{levelOf(id)} · </span>}
                      <span className={slotIndex >= 0 ? 'placed' : undefined}>{placement}</span>
                    </small>
                  </span>
                </button>
                <div className="slot-picker" role="group" aria-label={`把「${titleOf(id)}」放进`}>
                  {Array.from({ length: slotCount }, (_, slot) => (
                    <button
                      key={slot}
                      type="button"
                      aria-pressed={slotIndex === slot}
                      aria-label={`把「${titleOf(id)}」放进第 ${slot + 1} 栏`}
                      onClick={() => onAssignSlot(id, slot)}
                    >
                      第 {slot + 1} 栏
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`改名「${titleOf(id)}」`}
                  title="改名"
                  disabled={busyId === id}
                  onClick={() => startRename(id)}
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`归档「${titleOf(id)}」`}
                  title="归档"
                  disabled={busyId === id}
                  onClick={() => void archive(id)}
                >
                  <Archive aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          );
        })}
      </div>
      {archivedIds.length > 0 && (
        <div className="scene-archived">
          <button
            type="button"
            className="scene-archived-toggle"
            aria-expanded={showArchived}
            onClick={onToggleArchived}
          >
            {showArchived ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            已归档 {archivedIds.length}
          </button>
          {showArchived && (
            <div className="scene-archived-list">
              {archivedIds.map((id) => (
                <div key={id} className="scene-row archived" data-session-id={id}>
                  <span className="conversation-menu-name">
                    <strong>{titleOf(id)}</strong>
                  </span>
                  <button
                    type="button"
                    className="scene-restore"
                    aria-label={`恢复「${titleOf(id)}」`}
                    disabled={busyId === id}
                    onClick={() => void restore(id)}
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 新建会话对话框：输入名称后创建独立的工作会话。 */
function CreationDialog({ onCancel, onCreated }: {
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

  useEffect(() => {
    const trigger = triggerRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
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
      const session = await createWorkspaceSession(sessionIdRef.current, title);
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
        className="creation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-creation-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="creation-header">
          <div>
            <span>{WORKSPACE_NAME}</span>
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
