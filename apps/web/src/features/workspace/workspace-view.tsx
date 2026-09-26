import {
  Archive,
  Check,
  ChevronDown,
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
  archiveWorkspaceSession,
  createWorkspaceSession,
  getWorkspaceScene,
  listWorkspaceSessions,
  putWorkspaceScene,
  renameWorkspaceSession,
} from '../../data/workspace-api.js';
import { ConversationPanel } from './conversation-panel.js';
import { ResizablePanes } from './resizable-panes.js';
import { replaceInSlots, resizeSlots, resolveSlots } from './workspace-slots.js';

/** 首版只有一个默认工作区，不提供切换与新建工作区。 */
const WORKSPACE_NAME = '默认工作区';
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
export function WorkspaceView({ active, onManageModels, onFocusChange, onHandToMultivac }: WorkspaceViewProps) {
  const [sessions, setSessions] = useState<WorkspaceSession[] | null>(null);
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
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  // 现场读取完成前不保存，避免用默认值覆盖服务端记住的现场。
  const [sceneLoaded, setSceneLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [list, saved] = await Promise.all([listWorkspaceSessions(), getWorkspaceScene(DEFAULT_WORKSPACE_ID)]);
      setSessions(list.sessions);
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 会话列表按创建时间倒序：新会话在前，空出的栏也按这个顺序补位。
  const sceneIds = (sessions ?? []).map((session) => session.sessionId).reverse();
  const parallelIds = resolveSlots(storedSlots, sceneIds, parallelCount);
  const currentId = focusedId && sceneIds.includes(focusedId) ? focusedId : parallelIds[0] ?? null;
  const visibleIds = viewMode === 'parallel' ? parallelIds : currentId ? [currentId] : [];
  const titleOf = (id: string) => sessions?.find((session) => session.sessionId === id)?.title ?? '';
  const sessionOf = (id: string) => sessions?.find((session) => session.sessionId === id);
  /** 栈式路径：沿父会话向上直到顶层（父会话已归档时路径到此为止）。 */
  const stackPathOf = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let session = sessionOf(id); session && !seen.has(session.sessionId);
      session = session.parentSessionId ? sessionOf(session.parentSessionId) : undefined) {
      seen.add(session.sessionId);
      path.unshift(session.title);
    }
    return path;
  };

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

  /**
   * 从列表选中会话：聚焦模式直接切换；并排模式把它换进并排位，
   * 保留当前会话，替换第一栏非当前会话。
   */
  function showSession(id: string): void {
    setMenuOpen(false);
    if (viewMode === 'parallel' && !parallelIds.includes(id)) {
      const index = parallelIds.findIndex((item) => item !== currentId);
      setSlots(index < 0 ? [...parallelIds, id]
        : parallelIds.map((item, position) => position === index ? id : item));
    }
    setFocusedId(id);
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
    setSessions((current) => [...(current ?? []).filter((item) => item.sessionId !== session.sessionId), session]);
    // 新会话放进第一栏，原来的会话依次后移。
    setSlots([session.sessionId, ...parallelIds].slice(0, parallelCount));
    setFocusedId(session.sessionId);
    setViewMode('focus');
    setCreating(false);
  }

  function handleRenamed(session: WorkspaceSession): void {
    setSessions((current) => (current ?? []).map((item) => item.sessionId === session.sessionId ? session : item));
  }

  /**
   * 深入一层：基于选中内容新建子会话，在父会话原来的位置以聚焦方式打开；
   * 父会话保持原样，可逐层返回。
   */
  async function drillDown(parentId: string, quote: AssistantQuote): Promise<void> {
    setActionError('');
    try {
      const child = await createWorkspaceSession(crypto.randomUUID(), stackChildTitle(quote.text), {
        sessionId: parentId, quote,
      });
      setSessions((current) => [...(current ?? []).filter((item) => item.sessionId !== child.sessionId), child]);
      setSlots(replaceInSlots(parallelIds, parentId, child.sessionId));
      setFocusedId(child.sessionId);
      setViewMode('focus');
    } catch (error) {
      setActionError(errorText(error, '深入一层失败，请重试。'));
    }
  }

  /** 返回父会话：父会话回到子会话所在的位置并成为当前会话。 */
  function backToParent(childId: string): void {
    const parentId = sessionOf(childId)?.parentSessionId;
    if (!parentId || !sessionOf(parentId)) return;
    setSlots(replaceInSlots(parallelIds, childId, parentId));
    setFocusedId(parentId);
  }

  function handleArchived(sessionId: string): void {
    setSessions((current) => (current ?? []).filter((item) => item.sessionId !== sessionId));
    setSlots(parallelIds.filter((id) => id !== sessionId));
    if (focusedId === sessionId) setFocusedId(null);
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
                parallelCount={parallelCount}
                titleOf={titleOf}
                levelOf={(id) => {
                  const depth = stackPathOf(id).length - 1;
                  const parentId = sessionOf(id)?.parentSessionId;
                  if (!parentId) return null;
                  return `第 ${depth + 1} 层 · 来自「${titleOf(parentId) || '已归档会话'}」`;
                }}
                visibleIds={visibleIds}
                currentId={currentId}
                onShow={showSession}
                onCreate={openCreation}
                onRenamed={handleRenamed}
                onArchived={handleArchived}
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
              stackPath={stackPathOf(id)}
              originText={sessionOf(id)?.originText ?? null}
              {...(sessionOf(id)?.parentSessionId && sessionOf(sessionOf(id)!.parentSessionId!)
                ? { onBackToParent: () => backToParent(id) }
                : {})}
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
  parallelCount: number;
  titleOf: (id: string) => string;
  /** 栈式层级说明（子会话），顶层会话为空。 */
  levelOf: (id: string) => string | null;
  visibleIds: readonly string[];
  currentId: string | null;
  onShow: (id: string) => void;
  onCreate: () => void;
  onRenamed: (session: WorkspaceSession) => void;
  onArchived: (sessionId: string) => void;
}

/** 会话列表：标注展示中 / 未展示，可换入并排位或聚焦，也可改名与归档。 */
function SessionMenu({
  sessionIds, parallelCount, titleOf, levelOf, visibleIds, currentId, onShow, onCreate, onRenamed, onArchived,
}: SessionMenuProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

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
      onRenamed(await renameWorkspaceSession(id, title));
      setRenamingId(null);
    } catch (cause) {
      setError(errorText(cause, '改名失败，请重试。'));
    } finally {
      setBusyId(null);
    }
  }

  async function archive(id: string): Promise<void> {
    if (!window.confirm(`归档「${titleOf(id)}」？归档后不再出现在工作区中。`)) return;
    setError('');
    setBusyId(id);
    try {
      await archiveWorkspaceSession(id);
      onArchived(id);
    } catch (cause) {
      setError(errorText(cause, '归档失败，请重试。'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="conversation-menu" role="dialog" aria-label="工作区会话">
      <div className="conversation-menu-header">
        <div>
          <strong>{WORKSPACE_NAME}</strong>
          <span>并排 {parallelCount} 栏</span>
        </div>
        <button type="button" onClick={onCreate}>
          <Plus aria-hidden="true" />
          新会话
        </button>
      </div>
      {error && <p className="conversation-menu-error" role="alert">{error}</p>}
      <div className="conversation-menu-list">
        {sessionIds.length === 0 && <p className="conversation-menu-empty">还没有会话。</p>}
        {sessionIds.map((id) => (
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
                <button type="button" className="scene-open" onClick={() => onShow(id)}>
                  <span className="conversation-menu-name">
                    <strong>{titleOf(id)}</strong>
                    <small>
                      {levelOf(id) && <span className="scene-level">{levelOf(id)} · </span>}
                      {visibleIds.includes(id) ? '展示中' : '未展示'}
                    </small>
                  </span>
                </button>
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
        ))}
      </div>
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
