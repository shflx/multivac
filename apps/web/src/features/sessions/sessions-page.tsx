import {
  AlertCircle,
  Archive,
  Check,
  ChevronRight,
  Columns2,
  FolderInput,
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
import { SessionAuthorizations } from '../authorizations/session-authorizations.js';
import { WORKING_DIRECTORY_KINDS, workingDirectoryRule } from '../workspace/working-directory.js';
import { confirmArchive } from '../workspace/archive-confirm.js';
import { restoreNoticeText } from '../workspace/temp-retention.js';
import { MoveToProjectCard } from '../workspace/move-to-project-card.js';
import { moveResultText } from '../workspace/move-to-project.js';
import { stackLevel, stackPath, type StackPlace } from '../workspace/session-stack.js';
import { workspaceName } from '../workspace/workspaces.js';
import {
  useWorkspaces,
  useWorkspaceSessions,
  type WorkspaceSessionsHandle,
} from '../workspace/workspace-sessions-provider.js';
import {
  DEFAULT_SESSION_FILTER,
  filterIncluding,
  filterSessions,
  isStackedSession,
  projectFilterOptions,
  SESSION_KIND_OPTIONS,
  SESSION_STATUS_OPTIONS,
  sessionKindLabel,
  type SessionFilter,
} from './session-filter.js';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 从别处（Multivac 应用户要求打开会话页）选中一个会话；id 递增表示一次新的打开。 */
export interface SessionsPageRequest {
  id: number;
  sessionId: string;
}

interface SessionsPageProps {
  /** 页面是否正在显示；隐藏时不接管焦点。 */
  active: boolean;
  request?: SessionsPageRequest | null;
  /** 在工作区打开：离开管理，切到会话所在的工作区并聚焦它。调用时会话已是进行中。 */
  onOpenInWorkspace: (session: WorkspaceSession) => void;
  /** 选中的会话变化时报告给外壳：管理中的 Multivac 侧栏把它作为“正在看”的对象。 */
  onSelectionChange?: (session: WorkspaceSession | null) => void;
}

/**
 * 管理 · 会话：所有工作区的会话（含已归档），按项目、状态、类型筛选，按标题搜索；
 * 可以在工作区打开、改名、归入项目、归档或恢复。只作查找与整理，不显示计数与角标。
 *
 * 会话列表与工作区共用同一份（`useWorkspaceSessions`），这里的操作在工作区里即时可见，反之亦然。
 * 全局 Multivac 不是工作会话，不在这里列出。
 */
export function SessionsPage({ active, request = null, onOpenInWorkspace, onSelectionChange }: SessionsPageProps) {
  const workspaceSessions = useWorkspaceSessions();
  const { sessions, ensureLoaded } = workspaceSessions;
  const { workspaces, ensureLoaded: ensureWorkspacesLoaded } = useWorkspaces();
  const [loadError, setLoadError] = useState('');
  const [filter, setFilter] = useState<SessionFilter>(DEFAULT_SESSION_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 恢复时临时目录已到期移到废纸篓的说明；放在页面上，会话随恢复离开当前筛选时也看得到。
  const [notice, setNotice] = useState<string | null>(null);
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

  // 从别处选中一个会话：列表读到后再处理；它不符合当前筛选时放宽筛选，保证它出现在列表里并被选中。
  const handledRequestRef = useRef(0);
  useEffect(() => {
    if (!request || request.id === handledRequestRef.current || sessions === null) return;
    handledRequestRef.current = request.id;
    const session = sessions.find((candidate) => candidate.sessionId === request.sessionId);
    if (session) setFilter((current) => filterIncluding(current, session));
    setSelectedId(request.sessionId);
  }, [request, sessions]);

  const all = sessions ?? [];
  const shown = filterSessions(all, filter);
  const selected = shown.find((session) => session.sessionId === selectedId) ?? shown[0] ?? null;
  // 还没有项目（只有默认工作区）时不显示项目筛选。
  const projectOptions = projectFilterOptions(workspaces ?? []);
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

  // 列表未读完时没有选中；改名、归档、恢复后以最新的会话报告（提示随之更新）。
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

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
          {projectOptions && (
            <select
              aria-label="按项目筛选"
              value={filter.workspaceId}
              onChange={(event) => update({ workspaceId: event.target.value })}
            >
              {projectOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
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

      {notice && (
        <div className="workspace-notice sessions-notice" role="status">
          <p>{notice}</p>
          <button type="button" className="icon-button" aria-label="关闭提示" title="关闭提示" onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

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
              <p>{projectOptions ? '换个关键词，或放宽项目、状态与类型的筛选。' : '换个关键词，或放宽状态与类型的筛选。'}</p>
            </>
          )}
        </div>
      ) : (
        <div className="sessions-layout">
          <div ref={listRef} className="session-list" role="list" aria-label="会话列表">
            {shown.map((session) => {
              const Icon = isStackedSession(session) ? Layers3 : MessageSquare;
              const level = stackLevel(all, session.sessionId, { workspaceId: session.workspaceId, nameOf });
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
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>

          {/* 按会话挂载详情：切换会话时改名、忙碌与错误状态随之重置。 */}
          <SessionDetail
            key={selected.sessionId}
            active={active}
            session={selected}
            sessions={all}
            workspaceName={nameOf(selected.workspaceId)}
            nameOf={nameOf}
            actions={workspaceSessions}
            fallbackFocus={selectedRow}
            onOpenInWorkspace={onOpenInWorkspace}
            onNotice={setNotice}
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

/** 选中会话的详情与操作：改名、归入项目、归档或恢复、在工作区打开；本会话已允许的授权与最近的授权请求。 */
function SessionDetail({ active, session, sessions, workspaceName: place, nameOf, actions, fallbackFocus, onOpenInWorkspace, onNotice }: {
  /** 页面正在显示：变为可见时重新读取授权。 */
  active: boolean;
  session: WorkspaceSession;
  /** 全部会话（含已归档），用于栈式路径。 */
  sessions: readonly WorkspaceSession[];
  /** 会话所在工作区的名称。 */
  workspaceName: string;
  /** 工作区名称：栈式路径中注明不在同一工作区的父会话所在。 */
  nameOf: (workspaceId: string) => string;
  actions: Pick<WorkspaceSessionsHandle, 'rename' | 'archive' | 'restore'>;
  /** 操作后触发按钮随会话离开筛选而消失时，焦点的去处。 */
  fallbackFocus: () => HTMLElement | null | undefined;
  onOpenInWorkspace: (session: WorkspaceSession) => void;
  /** 页面级的说明（如恢复时临时目录已移到废纸篓）；null 清除。 */
  onNotice: (text: string | null) => void;
}) {
  const confirm = useConfirm();
  const titleId = useId();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  // 归入项目的确认卡与完成后的结果说明。
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState('');
  const archived = session.archivedAt !== null;
  const stackPlace: StackPlace = { workspaceId: session.workspaceId, nameOf };
  const path = stackPath(sessions, session.sessionId, stackPlace);
  const directory = WORKING_DIRECTORY_KINDS[session.workingDirectory.kind];

  /** 执行一次请求：进行中禁用操作，失败时把原因留在详情里并返回 undefined。 */
  async function run<T>(action: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setError('');
    setBusy(true);
    try {
      return await action();
    } catch (cause) {
      setError(errorText(cause, fallback));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  /**
   * 恢复已归档的会话。临时目录在归档期间已到期移到废纸篓时，服务端重建了空目录，
   * 这里写明何时移走、移到了哪里，并返回 false（先让人看到说明，不直接离开）。
   */
  async function restore(): Promise<boolean> {
    onNotice(null);
    const result = await run(() => actions.restore(session.sessionId), '恢复失败，请重试。');
    if (!result) return false;
    const text = restoreNoticeText(session.title, result);
    onNotice(text);
    return text === null;
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
    await confirmArchive(confirm, {
      sessionId: session.sessionId,
      title: session.title,
      action: () => actions.archive(session.sessionId),
      fallbackFocus,
    });
  }

  /**
   * 已归档的会话先恢复（回到原工作区）再打开，与在工作区列表里恢复的结果一致；
   * 临时目录已移到废纸篓时先留在这里说明，再点一次“在工作区打开”即可过去。
   */
  async function open(): Promise<void> {
    if (archived && !await restore()) return;
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
            {/* 类型、完整路径与本地写规则：规则与会话标题栏的工作目录说明同一份文案。 */}
            <span className="directory-rule">
              <span>
                <strong>{directory.label}</strong>
                <code>{session.workingDirectory.path}</code>
              </span>
              <small>{workingDirectoryRule(session.workingDirectory.kind)}</small>
            </span>
          </dd>
        </div>
      </dl>

      {/* 按原型顺序：事实表之后是“本会话已允许”，再是“最近的授权请求”（占原型“最近内容”的位置），最后是操作。 */}
      <SessionAuthorizations sessionId={session.sessionId} visible={active} />

      {error && <p className="session-detail-error" role="alert">{error}</p>}
      {note && <p className="session-detail-note" role="status">{note}</p>}

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
        {/* 已归档的会话不能归入项目：先恢复。 */}
        {!archived && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setError('');
              setNote('');
              setMoving(true);
            }}
          >
            <FolderInput aria-hidden="true" />
            归入项目…
          </button>
        )}
        {archived ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void restore()}
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

      {moving && (
        <MoveToProjectCard
          session={session}
          onMoved={(result, { project, from }) => {
            setMoving(false);
            setNote(moveResultText({ title: session.title, projectName: project.name, from, result }));
          }}
          onCancel={() => setMoving(false)}
          // 会话因此离开当前筛选时，焦点交给新的选中行。
          fallbackFocus={fallbackFocus}
        />
      )}
    </section>
  );
}
