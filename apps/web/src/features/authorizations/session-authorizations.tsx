import {
  CircleSlash,
  CircleStop,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  TimerOff,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { TOOL_AUTHORIZATION_HISTORY_LIMIT, type ToolAuthorizationRequest } from '@multivac/contracts';
import { listRecentAuthorizations } from '../../data/assistant-api.js';
import { recordTime, requestOutcomeText, requestSubject } from './authorization-view.js';
import { GrantList } from './grant-list.js';

const REQUEST_ICONS = {
  pending: ShieldAlert,
  approved: ShieldCheck,
  denied: ShieldX,
  cancelled: CircleStop,
  expired: TimerOff,
  invalidated: CircleSlash,
} as const;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * 会话授权窗口里的两节授权（按原型接在事实表之后）：
 * - “本会话已允许”：本会话范围的记住的授权，可以撤销；
 * - “最近的授权请求”：本会话最近的授权请求，只读，写明结果与批准依据（原型没有，项目约束要求保留）。
 * 已归档的会话同样显示。页面变为可见时重新读取。
 */
export function SessionAuthorizations({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const grantsTitleId = useId();
  const historyTitleId = useId();
  const grantsRef = useRef<HTMLElement>(null);

  return (
    <>
      <section className="detail-section" aria-labelledby={grantsTitleId} ref={grantsRef} tabIndex={-1}>
        <div className="section-title">
          <h3 id={grantsTitleId}>本会话已允许</h3>
        </div>
        <GrantList
          owner={{ sessionId }}
          visible={visible}
          label="本会话已允许"
          empty="这个会话还没有记住的授权。在授权卡上选“本会话内允许”后会出现在这里，可以随时撤销。"
          fallbackFocus={() => grantsRef.current}
        />
      </section>

      <section className="detail-section" aria-labelledby={historyTitleId}>
        <div className="section-title">
          <h3 id={historyTitleId}>最近的授权请求</h3>
          <span className="section-title-note">最近 {TOOL_AUTHORIZATION_HISTORY_LIMIT} 条，只读</span>
        </div>
        <SessionHistory sessionId={sessionId} visible={visible} />
      </section>
    </>
  );
}

/** 本会话最近的授权请求：最近的在前；每行是操作与目标路径，以及结果（批准依据或未获批准的原因）与时间。 */
function SessionHistory({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const [requests, setRequests] = useState<ToolAuthorizationRequest[] | null>(null);
  const [error, setError] = useState('');
  // 只采用最近一次读取的结果：切换会话或多次变为可见时，旧的返回不覆盖新的。
  const latestRead = useRef(0);

  const load = useCallback(async () => {
    const read = ++latestRead.current;
    setError('');
    try {
      const history = await listRecentAuthorizations(sessionId);
      if (read === latestRead.current) setRequests(history.requests);
    } catch (cause) {
      if (read === latestRead.current) setError(errorText(cause, '最近的授权请求读取失败。'));
    }
  }, [sessionId]);

  useEffect(() => {
    if (visible) void load();
    return () => { latestRead.current += 1; };
  }, [visible, load]);

  if (error) return <p className="form-error grant-error" role="alert">最近的授权请求读取失败：{error}<button className="inline-link" onClick={() => void load()}>重试</button></p>;
  if (requests === null) return <p className="section-hint grant-empty" aria-live="polite">正在读取最近的授权请求…</p>;
  if (requests.length === 0) {
    return (
      <p className="section-hint grant-empty">
        这个会话还没有授权请求。Agent 访问工作目录之外的文件时，请求会出现在这里，写明结果与批准依据。
      </p>
    );
  }
  return (
    <ul className="grant-list authorization-history" aria-label="最近的授权请求">
      {requests.map((request) => {
        const Icon = REQUEST_ICONS[request.status];
        const subject = requestSubject(request);
        return (
          <li key={request.requestId} className={request.status} data-request-id={request.requestId}>
            <Icon aria-hidden="true" />
            <span>
              <strong title={subject.title}>{subject.text}</strong>
              <small>{requestOutcomeText(request)} · {recordTime(request.createdAt)}</small>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
