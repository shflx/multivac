import { AlertCircle, Archive, ChevronRight, LoaderCircle, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceSession } from '@multivac/contracts';
import { SessionAuthorizationsDialog } from '../authorizations/session-authorizations-dialog.js';
import { recordTime } from '../authorizations/authorization-view.js';
import { stackPath } from '../workspace/session-stack.js';
import { restoreNoticeText } from '../workspace/temp-retention.js';
import { WORKING_DIRECTORY_KINDS } from '../workspace/working-directory.js';
import { useWorkspaces, useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import { workspaceName } from '../workspace/workspaces.js';
import { archiveWorkspaceFilter, DEFAULT_ARCHIVE_FILTER, filterArchives, projectFilterOptions } from './archive-filter.js';

export interface ArchivePageRequest {
  id: number;
  sessionId?: string;
  workspaceId?: string;
}

/** 归档只是共享会话列表的视图，恢复结果留在页面上，不随列表项消失。 */
export function ArchivePage({ active, request, onOpenInWorkspace, onSelectionChange }: {
  active: boolean;
  request: ArchivePageRequest | null;
  onOpenInWorkspace: (session: WorkspaceSession) => void;
  onSelectionChange: (session: WorkspaceSession | null) => void;
}) {
  const { sessions, ensureLoaded, restore } = useWorkspaceSessions();
  const { workspaces, ensureLoaded: loadWorkspaces } = useWorkspaces();
  const [filter, setFilter] = useState(DEFAULT_ARCHIVE_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<{ text: string; session: WorkspaceSession } | null>(null);
  const [authorization, setAuthorization] = useState<WorkspaceSession | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const handled = useRef(0);
  // 恢复期间切换面板或变为窄屏，不让完成回调抢走新面板的焦点或导航。
  const visible = useRef(active);
  visible.current = active;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      await Promise.all([ensureLoaded(), loadWorkspaces()]);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : '归档读取失败。');
    }
  }, [ensureLoaded, loadWorkspaces]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!active) setAuthorization(null); }, [active]);
  useEffect(() => {
    if (!request || handled.current === request.id || !sessions || !workspaces) return;
    handled.current = request.id;
    const target = sessions.find((session) => session.sessionId === request.sessionId && session.archivedAt !== null);
    const workspaceId = target?.workspaceId ?? (request.workspaceId
      ? archiveWorkspaceFilter(workspaces, request.workspaceId)
      : DEFAULT_ARCHIVE_FILTER.workspaceId);
    setFilter({ query: '', workspaceId });
    setSelectedId(target?.sessionId ?? null);
    setError('');
  }, [request, sessions, workspaces]);

  const shown = filterArchives(sessions ?? [], filter);
  const selected = shown.find((session) => session.sessionId === selectedId) ?? shown[0] ?? null;
  const nameOf = (id: string) => workspaceName(workspaces, id);
  const options = projectFilterOptions(workspaces ?? []);
  const fallbackFocus = () => list.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? search.current;

  useEffect(() => { onSelectionChange(selected); }, [selected, onSelectionChange]);
  useLayoutEffect(() => {
    if (active && document.activeElement === document.body) fallbackFocus()?.focus({ preventScroll: true });
  }, [active, selected?.sessionId]);

  async function restoreSelected(open: boolean): Promise<void> {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await restore(selected.sessionId);
      const text = restoreNoticeText(selected.title, result);
      if (text) {
        setNotice({ text, session: result.session });
        requestAnimationFrame(() => {
          if (visible.current) continueButton.current?.focus({ preventScroll: true });
        });
      } else if (open && visible.current) {
        onOpenInWorkspace(result.session);
      } else {
        // 完成时页面不可见仍保留继续入口，回来后能继续用户原先的打开意图。
        if (open) setNotice({ text: `已恢复「${selected.title}」，可以在原工作区继续。`, session: result.session });
        requestAnimationFrame(() => {
          if (visible.current) fallbackFocus()?.focus({ preventScroll: true });
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复失败，请重试。');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (!sessions || !workspaces) {
    return (
      <div className="management-page-state" data-management-page="archive" aria-live="polite">
        {loadError ? (
          <>
            <AlertCircle aria-hidden="true" />
            <h2>归档读取失败</h2>
            <p role="alert">{loadError}</p>
            <button className="secondary-button" onClick={() => void load()}><RefreshCw aria-hidden="true" />重试</button>
          </>
        ) : (
          <><LoaderCircle className="spin" aria-hidden="true" /><p>正在读取归档</p></>
        )}
      </div>
    );
  }

  const path = selected ? stackPath(sessions, selected.sessionId, { workspaceId: selected.workspaceId, nameOf }) : [];
  const hasArchives = sessions.some((session) => session.kind === 'work' && session.archivedAt !== null);

  return (
    <div className="archive-page" data-management-page="archive">
      <div className="archive-toolbar" role="search" aria-label="查找归档">
        <label className="search-field">
          <Search aria-hidden="true" />
          <input ref={search} type="search" aria-label="按标题搜索" placeholder="按标题搜索" value={filter.query}
            onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
        </label>
        {options && (
          <div className="archive-filters">
            <select aria-label="按项目筛选" value={filter.workspaceId}
              onChange={(event) => setFilter({ ...filter, workspaceId: event.target.value })}>
              {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        )}
      </div>

      {notice && (
        <div className="workspace-notice archive-notice" role="status">
          <p>{notice.text}</p>
          <button ref={continueButton} className="secondary-button" onClick={() => onOpenInWorkspace(notice.session)}>
            继续在工作区打开
          </button>
          <button className="icon-button" aria-label="关闭提示" onClick={() => { setNotice(null); fallbackFocus()?.focus(); }}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}
      {error && <p className="session-detail-error" role="alert">{error}</p>}

      {!selected ? (
        <div className="empty-state archive-empty">
          <Archive aria-hidden="true" />
          <h2>{hasArchives ? '没有符合条件的归档' : '还没有归档会话'}</h2>
          <p>{hasArchives ? '换个关键词，或放宽工作区筛选。' : '工作区中归档的会话会出现在这里，可以恢复到原工作区。'}</p>
        </div>
      ) : (
        <div className="archive-layout">
          <div ref={list} className="archive-list" role="list" aria-label="归档会话列表">
            {shown.map((session) => {
              const current = session.sessionId === selected.sessionId;
              return (
                <div role="listitem" key={session.sessionId}>
                  <button className={current ? 'selected' : ''} aria-current={current ? 'true' : undefined}
                    data-session-id={session.sessionId} onClick={() => { setSelectedId(session.sessionId); setError(''); }}>
                    <Archive aria-hidden="true" />
                    <span className="archive-list-copy">
                      <strong>{session.title}</strong>
                      <small>{nameOf(session.workspaceId)}</small>
                      <small>归档于 {recordTime(session.archivedAt!)}</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
          <section className="session-detail" aria-label={`归档会话：${selected.title}`}>
            <h2>{selected.title}</h2>
            <p className="section-hint">{nameOf(selected.workspaceId)} · 归档于 {recordTime(selected.archivedAt!)}</p>
            {path.length > 1 && (
              <details><summary>栈式上下文</summary><p className="section-hint">{path.join(' / ')}</p></details>
            )}
            <details>
              <summary>工作目录</summary>
              <p className="section-hint directory-rule">{WORKING_DIRECTORY_KINDS[selected.workingDirectory.kind].label}<code>{selected.workingDirectory.path}</code></p>
            </details>
            <div className="session-actions">
              <button className="secondary-button" disabled={busy} onClick={() => void restoreSelected(false)}>
                <RefreshCw aria-hidden="true" />恢复
              </button>
              <button className="primary-button" disabled={busy} onClick={() => void restoreSelected(true)}>恢复并打开</button>
              <button className="secondary-button" disabled={busy} onClick={() => setAuthorization(selected)}>
                <ShieldCheck aria-hidden="true" />授权
              </button>
            </div>
          </section>
        </div>
      )}
      {authorization && active && (
        <SessionAuthorizationsDialog key={authorization.sessionId} sessionId={authorization.sessionId}
          title={authorization.title} onClose={() => setAuthorization(null)} />
      )}
    </div>
  );
}
