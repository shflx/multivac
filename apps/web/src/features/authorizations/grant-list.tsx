import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ToolAuthorizationGrant } from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import type { GrantOwner } from './authorization-grants.js';
import { useOwnedGrants, type OwnedGrants } from './authorization-grants-provider.js';
import { GRANT_SCOPE_LABELS, grantMetaText, grantSubject } from './authorization-view.js';

type FallbackFocus = () => HTMLElement | null | undefined;

/**
 * 记住的授权的行（按原型 GrantList）：盾牌图标、主题（类别与放行目录，长路径中间截断，完整路径在悬停提示中）、
 * “目录 · 范围 · 记住于 …”，右侧是普通样式的小号“撤销”。撤销先经确认卡，即时生效；
 * 撤销后这一行消失，焦点交给列表里的下一个“撤销”，列表空了时交给 fallbackFocus。
 */
function GrantRows({ grants, label, revoke, fallbackFocus }: {
  grants: readonly ToolAuthorizationGrant[];
  label: string;
  revoke: OwnedGrants['revoke'];
  fallbackFocus: FallbackFocus;
}) {
  const confirm = useConfirm();
  const listRef = useRef<HTMLUListElement>(null);

  function requestRevoke(grant: ToolAuthorizationGrant): void {
    void confirm({
      title: '撤销这项授权？',
      description: `撤销「${grantSubject(grant).full}」（${GRANT_SCOPE_LABELS[grant.scope]}）。`,
      details: ['撤销后同类操作重新需要你确认。', '已经执行过的操作不受影响。'],
      icon: ShieldCheck,
      confirmLabel: '撤销',
      action: () => revoke(grant.grantId),
      fallbackFocus: () => listRef.current?.querySelector<HTMLElement>('button') ?? fallbackFocus(),
    });
  }

  return (
    <ul ref={listRef} className="grant-list" aria-label={label}>
      {grants.map((grant) => {
        const subject = grantSubject(grant);
        return (
          <li key={grant.grantId} data-grant-id={grant.grantId}>
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong title={subject.title}>{subject.text}</strong>
              <small>{grantMetaText(grant)}</small>
            </span>
            <button type="button" className="secondary-button compact" onClick={() => requestRevoke(grant)}>
              撤销
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 读取失败的说明与重试；已有列表时照常显示列表。 */
function GrantsError({ error, retry }: Pick<OwnedGrants, 'error' | 'retry'>) {
  if (!error) return null;
  return (
    <p className="form-error grant-error" role="alert">
      记住的授权读取失败：{error}
      <button type="button" className="inline-link" onClick={retry}>重试</button>
    </p>
  );
}

/**
 * 一个会话或项目的记住的授权列表（会话页“本会话已允许”、项目详情“已记住的授权”）：
 * 页面可见时重新读取；没有时给一句说明。
 */
export function GrantList({ owner, visible, label, empty, fallbackFocus }: {
  owner: GrantOwner;
  /** 所在页面正在显示；变为可见时重新读取。 */
  visible: boolean;
  /** 列表的可访问名称。 */
  label: string;
  /** 没有记住的授权时的说明。 */
  empty: string;
  /** 撤销掉最后一条后焦点的去处（通常是所在小节）。 */
  fallbackFocus: FallbackFocus;
}) {
  const { grants, error, retry, revoke } = useOwnedGrants(owner, visible);

  return (
    <>
      {grants === null ? (
        !error && <p className="section-hint grant-empty" aria-live="polite">正在读取记住的授权…</p>
      ) : grants.length > 0 ? (
        <GrantRows grants={grants} label={label} revoke={revoke} fallbackFocus={fallbackFocus} />
      ) : (
        <p className="section-hint grant-empty">{empty}</p>
      )}
      <GrantsError error={error} retry={retry} />
    </>
  );
}

/**
 * 标题栏工作目录浮层里的“本会话已允许 N 项”（按原型）：一行计数，点开查看和撤销；
 * 没有时置灰、不能展开。浮层每次打开时挂载，随之重新读取。
 */
export function SessionGrantsDisclosure({ sessionId, fallbackFocus }: {
  sessionId: string;
  /** 撤销掉最后一条后（计数置灰、不能聚焦）焦点的去处，通常是浮层本身。 */
  fallbackFocus: FallbackFocus;
}) {
  const { grants, error, retry, revoke } = useOwnedGrants({ sessionId }, true);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const count = grants?.length ?? 0;

  return (
    <div className="session-grants">
      {grants === null ? (
        !error && <span className="session-grants-loading">正在读取本会话已允许的授权…</span>
      ) : (
        <button
          type="button"
          ref={toggleRef}
          className="inline-link"
          aria-expanded={count > 0 ? open : undefined}
          disabled={count === 0}
          onClick={() => setOpen((value) => !value)}
        >
          <ShieldCheck aria-hidden="true" />
          本会话已允许 {count} 项
          {count > 0 && <ChevronDown aria-hidden="true" />}
        </button>
      )}
      {open && grants && grants.length > 0 && (
        <GrantRows
          grants={grants}
          label="本会话已允许"
          revoke={revoke}
          fallbackFocus={() => (toggleRef.current?.disabled === false ? toggleRef.current : fallbackFocus())}
        />
      )}
      <GrantsError error={error} retry={retry} />
    </div>
  );
}
