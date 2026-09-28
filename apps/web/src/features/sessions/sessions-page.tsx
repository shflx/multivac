import {
  AlertCircle,
  Archive,
  Check,
  Columns2,
  Layers3,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Pencil,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  normalizeWorkspaceSessionTitle,
  WORKSPACE_SESSION_TITLE_MAX_LENGTH,
  type WorkspaceSession,
} from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import { WORKING_DIRECTORY_KINDS } from '../workspace/working-directory.js';
import { archiveConfirmOptions } from '../workspace/archive-confirm.js';
import { stackLevel, stackPath } from '../workspace/session-stack.js';
import { workspaceName } from '../workspace/workspaces.js';
import {
  useWorkspaces,
  useWorkspaceSessions,
  type WorkspaceSessionsHandle,
} from '../workspace/workspace-sessions-provider.js';
import {
  ALL_WORKSPACES,
  DEFAULT_SESSION_FILTER,
  filterSessions,
  isStackedSession,
  SESSION_KIND_OPTIONS,
  SESSION_STATUS_OPTIONS,
  sessionKindLabel,
  type SessionFilter,
} from './session-filter.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface SessionsPageProps {
  /** 页面是否正在显示；隐藏时不接管焦点。 */
  active: boolean;
  /** 在工作区打开：离开管理，切到会话所在的工作区并聚焦它。调用时会话已是进行中。 */
  onOpenInWorkspace: (session: WorkspaceSession) => void;
}

/**
 * 管理 · 会话：所有工作区的会话（含已归档），按工作区、状态、类型筛选，按标题搜索；
 * 可以在工作区打开、改名、归档或恢复。只作查找与整理，不显示计数与角标。
 *
 * 会话列表与工作区共用同一份（`useWorkspaceSessions`），这里的操作在工作区里即时可见，反之亦然。
 * 全局 Multivac 不是工作会话，不在这里列出。
 */
export function SessionsPage({ active, onOpenInWorkspace }: SessionsPageProps) {
  const workspaceSessions = useWorkspaceSessions();
  const { sessions, ensureLoaded } = workspaceSessions;
  const { workspaces, ensureLoaded: ensureWorkspacesLoaded } = useWorkspaces();
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<SessionFilter>(DEFAULT_SESSION_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      await Promise.all([ensureLoaded(), ensureWorkspacesLoaded()]);
    } catch (error) {
      setLoadError(errorText(error, '会话读取失败。'));
    }
  }, [ensureLoaded, ensureWorkspacesLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const all = sessions ?? [];
  const shown = filterSessions(all, filter);
  const selected = shown.find((session) => session.sessionId === selectedId) ?? shown[0] ?? null;
  // 只有一个工作区时筛选没有意义，不显示；所在工作区仍写在每一行和详情里。
  const allWorkspaces = workspaces ?? [];
  const nameOf = (workspaceId: string) => workspaceName(workspaces, workspaceId);

  /** 当前选中的列表行；列表为空时交给搜索框。 */
  const selectedRow = useCallback(
    () => listRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? searchRef.current,
    [],
  );

  // 操作让选中的会话离开当前筛选（如在“已归档”下恢复）时，详情里的按钮随之消失；
  // 焦点落空时交给新的选中行，键盘用户不会被甩回页面开头。确认卡打开期间焦点在卡上，不受影响。
  const selectedKey = selected?.sessionId ?? '';
  useLayoutEffect(() => {
    if (active && document.activeElement === document.body) selectedRow()?.focus({ preventScroll: true });
  }, [active, selectedKey, selectedRow]);

  const update = (patch: Partial<SessionFilter>) => setFilter((current) => ({ ...current, ...patch }));

  if (sessions === null || workspaces === null) {
    return (
      <div className="sessions-page-state" data-management-page="sessions" aria-live="polite">
        {loadError ? (
          <>
            <AlertCircle aria-hidden="true" />
            <h2>会话读取失败</h2>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>正在读取会话</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="sessions-page" data-management-page="sessions">
      <div className="sessions-toolbar" role="search" aria-label="查找会话">
        <label className="search-field">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            aria-label="按标题搜索"
            placeholder="按标题搜索"
            value={filter.query}
            onChange={(event) => update({ query: event.target.value })}
          />
        </label>
        <div className="sessions-filters">
          {allWorkspaces.length > 1 && (
            <select
              aria-label="按工作区筛选"
              value={filter.workspaceId}
              onChange={(event) => update({ workspaceId: event.target.value })}
            >
              <option value={ALL_WORKSPACES}>全部工作区</option>
              {allWorkspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}</option>
              ))}
            </select>
          )}
          <Segmented
            label="按状态筛选"
            options={SESSION_STATUS_OPTIONS}
            value={filter.status}
            onChange={(status) => update({ status })}
          />
          <Segmented
            label="按类型筛选"
            options={SESSION_KIND_OPTIONS}
            value={filter.kind}
            onChange={(kind) => update({ kind })}
          />
        </div>
      </div>

      {!selected ? (
        <div className="empty-state sessions-empty">
          <MessagesSquare aria-hidden="true" />
          {all.length === 0 ? (
            <>
              <h2>还没有会话</h2>
              <p>在工作区新建的会话会出现在这里。</p>
            </>
          ) : (
            <>
              <h2>没有符合条件的会话</h2>
              <p>换个关键词，或放宽状态与类型的筛选。</p>
            </>
          )}
        </div>
      ) : (
        <div className="sessions-layout">
          <div ref={listRef} className="session-list" role="list" aria-label="会话列表">
            {shown.map((session) => {
              const Icon = isStackedSession(session) ? Layers3 : MessageSquare;
              const level = stackLevel(all, session.sessionId);
              const current = session.sessionId === selected.sessionId;
              return (
                <div key={session.sessionId} role="listitem">
                  <button
                    type="button"
                    className={current ? 'selected' : ''}
                    aria-current={current ? 'true' : undefined}
                    data-session-id={session.sessionId}
                    onClick={() => setSelectedId(session.sessionId)}
                  >
                    <Icon aria-hidden="true" />
                    <span className="session-list-copy">
                      <strong>{session.title}</strong>
                      <small>
                        {nameOf(session.workspaceId)} · {sessionKindLabel(session)}
                        {session.archivedAt !== null && ' · 已归档'}
                      </small>
                      {level && <small className="session-list-level">{level}</small>}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          {/* 按会话挂载详情：切换会话时改名、忙碌与错误状态随之重置。 */}
          <SessionDetail
            key={selected.sessionId}
            session={selected}
            sessions={all}
            workspaceName={nameOf(selected.workspaceId)}
            actions={workspaceSessions}
            fallbackFocus={selectedRow}
            onOpenInWorkspace={onOpenInWorkspace}
          />
        </div>
      )}
    </div>
  );
}

/** 分段筛选：单选，当前项用 aria-pressed 表示；不显示计数。 */
function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 选中会话的详情与操作：改名、归档或恢复、在工作区打开。 */
function SessionDetail({ session, sessions, workspaceName: place, actions, fallbackFocus, onOpenInWorkspace }: {
  session: WorkspaceSession;
  /** 全部会话（含已归档），用于栈式路径。 */
  sessions: readonly WorkspaceSession[];
  /** 会话所在工作区的名称。 */
  workspaceName: string;
  actions: Pick<WorkspaceSessionsHandle, 'rename' | 'archive' | 'restore'>;
  /** 操作后触发按钮随会话离开筛选而消失时，焦点的去处。 */
  fallbackFocus: () => HTMLElement | null | undefined;
  onOpenInWorkspace: (session: WorkspaceSession) => void;
}) {
  const confirm = useConfirm();
  const titleId = useId();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const archived = session.archivedAt !== null;
  const path = stackPath(sessions, session.sessionId);
  const directory = WORKING_DIRECTORY_KINDS[session.workingDirectory.kind];

  /** 执行一次请求：进行中禁用操作，失败时把原因留在详情里。 */
  async function run(action: () => Promise<unknown>, fallback: string): Promise<boolean> {
    setError('');
    setBusy(true);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startRename(): void {
    setError('');
    setRenameValue(session.title);
    setRenaming(true);
  }

  function cancelRename(): void {
    setRenaming(false);
    // 改名框卸载后把焦点还给“改名”。
    requestAnimationFrame(() => renameButtonRef.current?.focus({ preventScroll: true }));
  }

  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    const title = normalizeWorkspaceSessionTitle(renameValue);
    if (!title || busy) return;
    if (title === session.title) {
      cancelRename();
      return;
    }
    if (await run(() => actions.rename(session.sessionId, title), '改名失败，请重试。')) cancelRename();
  }

  /** 归档经确认卡确认，文案与工作区一致；请求在卡上进行，失败时原因留在卡上。 */
  async function archive(): Promise<void> {
    setError('');
    await confirm({
      ...archiveConfirmOptions(session.title),
      action: () => actions.archive(session.sessionId),
      fallbackFocus,
    });
  }

  /** 已归档的会话先恢复（回到原工作区）再打开，与在工作区列表里恢复的结果一致。 */
  async function open(): Promise<void> {
    if (archived && !await run(() => actions.restore(session.sessionId), '恢复失败，请重试。')) return;
    onOpenInWorkspace(session);
  }

  return (
    <section className="session-detail" aria-labelledby={titleId}>
      {renaming ? (
        <form className="session-rename" onSubmit={(event) => void submitRename(event)}>
          <input
            id={titleId}
            aria-label="会话名称"
            value={renameValue}
            maxLength={WORKSPACE_SESSION_TITLE_MAX_LENGTH}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              cancelRename();
            }}
          />
          <button
            type="submit"
            className="icon-button"
            aria-label="保存名称"
            title="保存名称"
            disabled={busy || !normalizeWorkspaceSessionTitle(renameValue)}
          >
            <Check aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" aria-label="取消改名" title="取消改名" onClick={cancelRename}>
            <X aria-hidden="true" />
          </button>
        </form>
      ) : <h2 id={titleId}>{session.title}</h2>}

      <dl className="session-facts">
        <div>
          <dt>所在</dt>
          <dd>{place}</dd>
        </div>
        <div>
          <dt>类型</dt>
          <dd>
            {sessionKindLabel(session)}
            {path.length > 1 && <span className="session-fact-note">栈式路径 · {path.join(' / ')}</span>}
          </dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{archived ? '已归档（不在工作区列表里，可以恢复）' : '进行中'}</dd>
        </div>
        <div>
          <dt>工作目录</dt>
          <dd>
            {directory.label}
            <code className="session-fact-note" title={session.workingDirectory.path}>{session.workingDirectory.path}</code>
          </dd>
        </div>
      </dl>

      {error && <p className="session-detail-error" role="alert">{error}</p>}

      <div className="session-actions">
        <button
          type="button"
          ref={renameButtonRef}
          className="secondary-button"
          disabled={busy || renaming}
          onClick={startRename}
        >
          <Pencil aria-hidden="true" />
          改名
        </button>
        {archived ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void run(() => actions.restore(session.sessionId), '恢复失败，请重试。')}
          >
            <RefreshCw aria-hidden="true" />
            恢复
          </button>
        ) : (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void archive()}>
            <Archive aria-hidden="true" />
            归档
          </button>
        )}
        <button type="button" className="primary-button" disabled={busy} onClick={() => void open()}>
          <Columns2 aria-hidden="true" />
          {archived ? '恢复并在工作区打开' : '在工作区打开'}
        </button>
      </div>
    </section>
  );
}
