import {
  CircleAlert,
  CircleSlash,
  CircleStop,
  LoaderCircle,
  ShieldCheck,
  ShieldX,
  TimerOff,
} from 'lucide-react';
import type { ToolAuthorizationDecision, ToolAuthorizationRequest } from '@multivac/contracts';
import type { AuthorizationDecisionState } from './assistant-session.js';
import {
  AUTHORIZATION_OUTCOMES,
  AUTHORIZATION_TOOL_ACTIONS,
  authorizationDeadline,
} from './tool-authorizations.js';
import { WORKING_DIRECTORY_KINDS } from '../workspace/working-directory.js';

interface AuthorizationCardProps {
  request: ToolAuthorizationRequest;
  decision?: AuthorizationDecisionState | undefined;
  onDecide: (decision: ToolAuthorizationDecision) => void;
}

const OUTCOME_ICONS = {
  approved: ShieldCheck,
  denied: ShieldX,
  cancelled: CircleStop,
  expired: TimerOff,
  invalidated: CircleSlash,
} as const;

/**
 * 就地授权卡：Agent 要访问会话工作目录之外的路径时，出现在该轮运行轨迹之后。
 *
 * 写明具体操作（动作 + 解析后的目标路径）、工作目录的类型与路径；待授权时提供“拒绝 / 仅这一次”，
 * 离开待授权后只显示结果，不再可操作。卡片状态全部来自服务端的请求记录。
 */
export function AuthorizationCard({ request, decision, onDecide }: AuthorizationCardProps) {
  const action = AUTHORIZATION_TOOL_ACTIONS[request.toolName];
  const directory = WORKING_DIRECTORY_KINDS[request.workingDirectory.kind];
  const pending = request.status === 'pending';
  const submitting = decision?.submitting ?? null;
  const deadline = pending ? authorizationDeadline(request) : null;
  const outcome = pending ? null : AUTHORIZATION_OUTCOMES[request.status as Exclude<typeof request.status, 'pending'>];
  const OutcomeIcon = pending ? null : OUTCOME_ICONS[request.status as keyof typeof OUTCOME_ICONS];

  return (
    <section
      className={`authorization-card ${request.status}`}
      role="region"
      aria-label={`工具授权：${action} ${request.targetPath}`}
      data-request-id={request.requestId}
      data-tool-call-id={request.toolCallId}
    >
      <div className="authorization-card-head">
        <span className="request-type">工具授权</span>
        <strong>允许{action}工作目录外的文件？</strong>
        {deadline && <span>{deadline}</span>}
      </div>
      <p className="authorization-operation" title={request.requestedPath === request.targetPath
        ? undefined : `Agent 给出的路径：${request.requestedPath}`}>
        {action} <code>{request.targetPath}</code>
      </p>
      {pending && (
        <p className="dir-rule">
          本会话的工作目录是{directory.label} <code>{request.workingDirectory.path}</code>：
          {directory.rule}这次{action}的路径在目录之外，需要你确认。
        </p>
      )}
      {decision?.error && (
        <p className="authorization-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{decision.error}</span>
        </p>
      )}
      {pending ? (
        <div className="authorization-actions">
          <button
            type="button"
            className="secondary-button danger"
            disabled={submitting !== null}
            onClick={() => onDecide('deny')}
          >
            {submitting === 'deny' && <LoaderCircle className="spin" aria-hidden="true" />}
            拒绝
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={submitting !== null}
            onClick={() => onDecide('once')}
          >
            {submitting === 'once' && <LoaderCircle className="spin" aria-hidden="true" />}
            仅这一次
          </button>
        </div>
      ) : outcome && OutcomeIcon && (
        <p className="authorization-outcome">
          <OutcomeIcon aria-hidden="true" />
          <span>{outcome.detail}</span>
        </p>
      )}
    </section>
  );
}
