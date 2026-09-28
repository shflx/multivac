import {
  AlertCircle,
  CircleSlash,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  TimerOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TOOL_AUTHORIZATION_HISTORY_LIMIT,
  type ToolAuthorizationGrant,
  type ToolAuthorizationRequest,
} from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import {
  listAuthorizationGrants,
  listRecentAuthorizations,
  revokeAuthorizationGrant,
} from '../../data/assistant-api.js';
import { grantScopeText } from '../assistant/tool-authorizations.js';
import { useWorkspaces, useWorkspaceSessions } from '../workspace/workspace-sessions-provider.js';
import {
  grantOwnerText,
  grantUsageText,
  recordTime,
  requestOperationText,
  requestOutcomeText,
  sessionLabel,
} from './authorization-records.js';

const REQUEST_ICONS = {
  pending: ShieldAlert,
  approved: ShieldCheck,
  denied: ShieldX,
  cancelled: CircleStop,
  expired: TimerOff,
  invalidated: CircleSlash,
} as const;

interface AuthorizationRecordsPageProps {
  /** 页面可见；每次变为可见时重新读取，看到刚在授权卡上记住的决定。 */
  active: boolean;
}

interface Records {
  grants: ToolAuthorizationGrant[];
  requests: ToolAuthorizationRequest[];
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 管理 · 设置 · 授权记录：记住的授权决定（可撤销）与最近的授权请求（只读）。
 *
 * 记住的决定只能在授权卡上产生，这里只提供收窄权限的撤销：撤销经确认卡完成，即时生效，
 * 之后的同类操作重新出现授权卡。会话与项目的名称取自应用内共享的会话与工作区列表。
 */
export function AuthorizationRecordsPage({ active }: AuthorizationRecordsPageProps) {
  const confirm = useConfirm();
  const { sessions, ensureLoaded: ensureSessionsLoaded } = useWorkspaceSessions();
  const { workspaces, ensureLoaded: ensureWorkspacesLoaded } = useWorkspaces();
  const [records, setRecords] = useState<Records | null>(null);
  const [loadError, setLoadError] = useState('');
  const grantsRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [grants, history] = await Promise.all([
        listAuthorizationGrants(),
        listRecentAuthorizations(),
        // 名称读取失败不影响记录本身，只是退回“会话 / 项目”的写法。
        ensureSessionsLoaded().catch(() => undefined),
        ensureWorkspacesLoaded().catch(() => undefined),
      ]);
      setRecords({ grants: grants.grants, requests: history.requests });
    } catch (error) {
      setLoadError(errorText(error, '授权记录读取失败。'));
    }
  }, [ensureSessionsLoaded, ensureWorkspacesLoaded]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  function revoke(grant: ToolAuthorizationGrant) {
    const owner = grantOwnerText(grant, sessions, workspaces);
    void confirm({
      title: '撤销这条记住的授权？',
      description: `${owner}：${grantScopeText(grant.access, grant.directory)}。`,
      details: [
        '立即生效：之后的同类操作会重新出现授权卡，由你再次确认。',
        '已经按它放行的操作不受影响，仍记录在“最近的授权请求”中。',
      ],
      icon: ShieldOff,
      confirmLabel: '撤销',
      action: async () => {
        await revokeAuthorizationGrant(grant.grantId);
        setRecords((current) => current && {
          ...current,
          grants: current.grants.filter((item) => item.grantId !== grant.grantId),
        });
      },
      // 撤销后这一行随之消失，焦点交给记住的授权分组。
      fallbackFocus: () => grantsRef.current,
    });
  }

  if (records === null) {
    return (
      <div className="sessions-page-state" data-management-page="authorizations" aria-live="polite">
        {loadError ? (
          <>
            <AlertCircle aria-hidden="true" />
            <h2>授权记录读取失败</h2>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
              重试
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" aria-hidden="true" />
            <p>正在读取授权记录</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="authorization-records" data-management-page="authorizations">
      <section
        className="record-group"
        aria-labelledby="authorization-grants-title"
        ref={grantsRef}
        tabIndex={-1}
      >
        <div className="record-group-head">
          <h3 id="authorization-grants-title">记住的授权</h3>
          <span>由程序校验，不靠模型记忆</span>
        </div>
        {records.grants.length > 0 ? (
          <ul className="record-list" aria-label="记住的授权">
            {records.grants.map((grant) => (
              <li key={grant.grantId} className="record-row" data-grant-id={grant.grantId}>
                <ShieldCheck className="record-icon" aria-hidden="true" />
                <div className="record-copy">
                  <strong title={grantScopeText(grant.access, grant.directory)}>
                    {grantScopeText(grant.access, grant.directory)}
                  </strong>
                  <small>{grantOwnerText(grant, sessions, workspaces)}</small>
                  <small>记住于 {recordTime(grant.createdAt)} · {grantUsageText(grant)}</small>
                </div>
                <button type="button" className="secondary-button danger" onClick={() => revoke(grant)}>
                  撤销
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="record-empty">
            还没有记住的授权。在就地授权卡上选择“本会话内允许 / 本项目内始终允许”后会出现在这里。
          </p>
        )}
      </section>

      <section className="record-group" aria-labelledby="authorization-history-title">
        <div className="record-group-head">
          <h3 id="authorization-history-title">最近的授权请求</h3>
          <span>最近 {TOOL_AUTHORIZATION_HISTORY_LIMIT} 条，只读</span>
        </div>
        {records.requests.length > 0 ? (
          <ul className="record-list" aria-label="最近的授权请求">
            {records.requests.map((request) => {
              const Icon = REQUEST_ICONS[request.status];
              return (
                <li key={request.requestId} className={`record-row ${request.status}`} data-request-id={request.requestId}>
                  <Icon className="record-icon" aria-hidden="true" />
                  <div className="record-copy">
                    <strong title={requestOperationText(request)}>{requestOperationText(request)}</strong>
                    <small>
                      {requestOutcomeText(request)} · {sessionLabel(request.sessionId, sessions)} · {recordTime(request.createdAt)}
                    </small>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="record-empty">还没有授权请求。Agent 访问会话工作目录之外的文件时，请求会出现在这里。</p>
        )}
      </section>
    </div>
  );
}
