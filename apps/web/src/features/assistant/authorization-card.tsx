import { ObjectLink } from './object-links.js';
import { useTaskRequests } from '../tasks/task-requests-provider.js';
import {
  CircleAlert,
  CircleSlash,
  CircleStop,
  LoaderCircle,
  ShieldCheck,
  ShieldX,
  TimerOff,
} from 'lucide-react';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type ToolAuthorizationDecision,
  type ToolAuthorizationRequest,
} from '@multivac/contracts';
import type { AuthorizationDecisionState } from './assistant-session.js';
import {
  AUTHORIZATION_OUTCOMES,
  AUTHORIZATION_TOOL_ACTIONS,
  GRANT_REVOKE_PLACES,
  approvedDetail,
  authorizationDeadline,
  rememberedScopeText,
} from './tool-authorizations.js';
import { WORKING_DIRECTORY_KINDS } from '../workspace/working-directory.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';

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

interface DecisionOption {
  decision: ToolAuthorizationDecision;
  label: string;
  className: string;
}

/**
 * 待授权卡上的选项，按原型从窄到宽排列，最宽的可用范围作为主按钮：
 * 有可记住的范围且会话属于项目时是“本项目内始终允许”，只能记在会话上时是“本会话内允许”，
 * 不能记住（目录范围过大，或是全局 Multivac 的对话）时只有“仅这一次”。不属于项目的会话不出现“本项目内”。
 */
function decisionOptions(request: ToolAuthorizationRequest): DecisionOption[] {
  const remember = request.remember;
  const widest = 'once';
  const option = (decision: ToolAuthorizationDecision, label: string): DecisionOption => ({
    decision, label, className: decision === widest ? 'primary-button' : 'secondary-button',
  });
  return [
    { decision: 'deny', label: '拒绝', className: 'secondary-button danger' },
    option('once', '仅这一次'),
    ...(remember ? [option('session', '本会话内允许')] : []),
    ...(remember?.projectId ? [option('project', '本项目内始终允许')] : []),
  ];
}

/**
 * 就地授权卡：Agent 要访问会话工作目录之外的路径时，出现在该轮运行轨迹之后。
 *
 * 写明具体操作（动作 + 解析后的目标路径）、工作目录的类型与路径，以及选择记住时的具体范围
 * （服务端随请求给出的放行目录，含子目录；读取与修改分开）。待授权时提供“拒绝 / 仅这一次 /
 * 本会话内允许 / 本项目内始终允许”，离开待授权后只显示结果，不再可操作。卡片状态全部来自服务端的请求记录。
 */
export function AuthorizationCard({ request: original, decision: originalDecision, onDecide: originalDecide }: AuthorizationCardProps) {
  const shared = useTaskRequests();
  const id = `authorization:${original.requestId}`;
  const item = shared.items.find((value) => value.id === id);
  const request = item?.authorization ?? original;
  const decision = item ? { submitting: shared.pending.has(id) ? 'once' as const : null, error: shared.errors[id] ?? '' } : originalDecision;
  const onDecide = (value: ToolAuthorizationDecision) => {
    if (item && shared.store) void shared.store.decideItem(item, value);
    else originalDecide(value);
  };
  const { workspaces } = useWorkspaces();
  const action = AUTHORIZATION_TOOL_ACTIONS[request.toolName];
  const directory = WORKING_DIRECTORY_KINDS[request.workingDirectory.kind];
  const pending = request.status === 'pending';
  const submitting = decision?.submitting ?? null;
  const deadline = pending ? authorizationDeadline(request) : null;
  const outcome = request.status === 'pending' ? null
    : request.status === 'approved' ? approvedDetail(request) : AUTHORIZATION_OUTCOMES[request.status].detail;
  const OutcomeIcon = pending ? null : OUTCOME_ICONS[request.status as keyof typeof OUTCOME_ICONS];
  const remember = request.remember;
  const projectName = remember?.projectId
    ? workspaces?.find((workspace) => workspace.project?.projectId === remember.projectId)?.project?.name
    : undefined;

  return (
    <section
      className={`authorization-card ${request.status}`}
      role="region"
      aria-label={`工具授权：${action} ${request.targetPath}`}
      data-request-id={request.requestId}
      data-tool-call-id={request.toolCallId}
    >
      <ObjectLink target={{ kind: 'inbox', id }}>在 Inbox 中查看原请求</ObjectLink>
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
      {pending && (remember ? (
        <p className="authorization-remember">
          选择记住时，之后{rememberedScopeText(request.toolName, remember.directory)}（含子目录）不再确认：
          “本会话内允许”只作用于这个会话
          {remember.projectId && <>，“本项目内始终允许”作用于项目{projectName ? `「${projectName}」` : ''}中的全部会话</>}
          。
          {remember.projectId
            ? `本会话内的可在${GRANT_REVOKE_PLACES.session}中撤销，本项目内的在${GRANT_REVOKE_PLACES.project}中撤销。`
            : `可在${GRANT_REVOKE_PLACES.session}中撤销。`}
        </p>
      ) : (
        <p className="authorization-remember">
          {request.sessionId === GLOBAL_ASSISTANT_SESSION_ID
            ? 'Multivac 的对话不记住授权决定，只能单次批准。'
            : '目标所在的目录范围过大（或涉及 Multivac 自身的目录），不能记住，只能单次批准。'}
        </p>
      ))}
      {(request.status === 'expired' || request.status === 'invalidated') && <p>原调用未执行。请返回来源会话核对当前上下文，再明确要求重新发起；旧请求不能再次批准。</p>}
      {decision?.error && (
        <p className="authorization-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{decision.error}</span>
        </p>
      )}
      {pending ? (
        <div className="authorization-actions">
          {decisionOptions(request).map((option) => (
            <button
              key={option.decision}
              type="button"
              className={option.className}
              disabled={submitting !== null}
              onClick={() => onDecide(option.decision)}
            >
              {submitting === option.decision && <LoaderCircle className="spin" aria-hidden="true" />}
              {option.label}
            </button>
          ))}
        </div>
      ) : outcome && OutcomeIcon && (
        <p className="authorization-outcome">
          <OutcomeIcon aria-hidden="true" />
          <span>{outcome}</span>
        </p>
      )}
    </section>
  );
}
