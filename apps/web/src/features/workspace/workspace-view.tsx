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
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  normalizeWorkspaceSessionTitle,
  WORKSPACE_SESSION_TITLE_MAX_LENGTH,
  type WorkspaceSession,
} from '@multivac/contracts';
import {
  archiveWorkspaceSession,
  createWorkspaceSession,
  listWorkspaceSessions,
  renameWorkspaceSession,
} from '../../data/workspace-api.js';
import { AssistantView } from '../assistant/assistant-view.js';

/** 首版只有一个默认工作区，不提供切换与新建工作区。 */
const WORKSPACE_NAME = '默认工作区';
/** 并排最多展示的会话数。 */
const MAX_PARALLEL = 2;

type ViewMode = 'parallel' | 'focus';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface WorkspaceViewProps {
  /** 工作区是否正在显示；隐藏时会话保持挂载但不抢焦点。 */
  active: boolean;
  /** 工作区条是否显示（`Cmd/Ctrl+\` 切换）。 */
  barVisible: boolean;
  onManageModels: () => void;
}

/**
 * 工作区：用户新建的多个工作会话，并排或聚焦查看与推进。
 *
 * 展示顺序决定并排位：前两个会话并排展示；聚焦模式只展示当前会话。
 */
export function WorkspaceView({ active, barVisible, onManageModels }: WorkspaceViewProps) {
  const [sessions, setSessions] = useState<WorkspaceSession[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [order, setOrder] = useState<string[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('parallel');
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const list = await listWorkspaceSessions();
      setSessions(list.sessions);
    } catch (error) {
      setLoadError(errorText(error, '工作区会话读取失败。'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 展示顺序只保留仍存在的会话；尚未排过序的会话按创建顺序跟在后面。
  const sessionIds = (sessions ?? []).map((session) => session.sessionId);
  const ordered = order.filter((id) => sessionIds.includes(id));
  const sceneIds = [...ordered, ...sessionIds.filter((id) => !ordered.includes(id))];
  const parallelIds = sceneIds.slice(0, MAX_PARALLEL);
  const currentId = focusedId && sceneIds.includes(focusedId) ? focusedId : sceneIds[0] ?? null;
  const visibleIds = viewMode === 'parallel' ? parallelIds : currentId ? [currentId] : [];
  const titleOf = (id: string) => sessions?.find((session) => session.sessionId === id)?.title ?? '';

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
   * 保留当前会话作为另一栏，替换掉较早的一栏。
   */
  function showSession(id: string): void {
    setMenuOpen(false);
    if (viewMode === 'parallel' && !parallelIds.includes(id)) {
      const keep = currentId && parallelIds.includes(currentId) ? currentId : parallelIds[0];
      setOrder([keep, id, ...sceneIds.filter((item) => item !== keep && item !== id)]
        .filter((item): item is string => Boolean(item)));
    }
    setFocusedId(id);
  }

  function switchViewMode(mode: ViewMode): void {
    // 回到并排时，当前会话若不在并排位则改为聚焦并排的第一栏。
    if (mode === 'parallel' && currentId && !parallelIds.includes(currentId)) setFocusedId(parallelIds[0] ?? null);
    setViewMode(mode);
  }

  function handleCreated(session: WorkspaceSession): void {
    setSessions((current) => [...(current ?? []).filter((item) => item.sessionId !== session.sessionId), session]);
    setOrder([session.sessionId, ...sceneIds]);
    setFocusedId(session.sessionId);
    setViewMode('focus');
    setCreating(false);
  }

  function handleRenamed(session: WorkspaceSession): void {
    setSessions((current) => (current ?? []).map((item) => item.sessionId === session.sessionId ? session : item));
  }

  function handleArchived(sessionId: string): void {
    setSessions((current) => (current ?? []).filter((item) => item.sessionId !== sessionId));
    setOrder((current) => current.filter((id) => id !== sessionId));
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
                titleOf={titleOf}
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
        <div className={`workspace-panels ${viewMode}`}>
          {visibleIds.map((id) => (
            <section
              key={id}
              className={`workspace-panel${id === currentId ? ' active' : ''}`}
              aria-label={titleOf(id)}
              data-session-id={id}
              onPointerDownCapture={() => setFocusedId(id)}
              onFocusCapture={() => setFocusedId(id)}
            >
              <header className="workspace-panel-header">
                <h2 title={titleOf(id)}>{titleOf(id)}</h2>
              </header>
              <AssistantView
                sessionId={id}
                variant="panel"
                active={active}
                focusOnActivate={active && id === currentId}
                onManageModels={onManageModels}
              />
            </section>
          ))}
        </div>
      )}

      {creating && (
        <CreationDialog onCancel={() => setCreating(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}

interface SessionMenuProps {
  sessionIds: readonly string[];
  titleOf: (id: string) => string;
  visibleIds: readonly string[];
  currentId: string | null;
  onShow: (id: string) => void;
  onCreate: () => void;
  onRenamed: (session: WorkspaceSession) => void;
  onArchived: (sessionId: string) => void;
}

/** 会话列表：标注展示中 / 未展示，可换入并排位或聚焦，也可改名与归档。 */
function SessionMenu({
  sessionIds, titleOf, visibleIds, currentId, onShow, onCreate, onRenamed, onArchived,
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
          <span>前 {MAX_PARALLEL} 个并排展示</span>
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
                    <small>{visibleIds.includes(id) ? '展示中' : '未展示'}</small>
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
