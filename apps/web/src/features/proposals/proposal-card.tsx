import { CircleAlert, CircleCheck, CircleSlash, CircleX, LoaderCircle, TimerOff } from 'lucide-react';
import type { Proposal, ProposalDecision } from '@multivac/contracts';
import { ObjectRefLinks } from '../assistant/object-links.js';
import { proposalKindView } from './proposal-kinds.js';
import { proposalReceipt, type ProposalDecisionState } from './proposals.js';

interface ProposalCardProps {
  proposal: Proposal;
  decision?: ProposalDecisionState | undefined;
  onDecide: (decision: ProposalDecision) => void;
}

const RECEIPT_ICONS = {
  executing: LoaderCircle,
  executed: CircleCheck,
  cancelled: CircleSlash,
  expired: TimerOff,
  failed: CircleX,
} as const;

/**
 * 对话内的确认卡：全局 Multivac 的提议类工具提出扩大权限的操作后，出现在提出它的那一轮之后（首页与侧栏相同）。
 *
 * 待确认时按原型的确认卡写：图标、标题（要做的事）与一句说明，种类提供的内容（两列字段），提出时核对不通过的原因，
 * “取消 / 确认”。确认或取消后原地变为一行回执（不再追加消息）：已执行（附结果涉及的对象）、已取消、已过期（写明原因）、
 * 执行失败。卡片状态全部来自服务端的提议记录；只有用户在这里的操作能确认，Multivac 无法代为确认。
 */
export function ProposalCard({ proposal, decision, onDecide }: ProposalCardProps) {
  const view = proposalKindView(proposal.kind);
  const receipt = proposalReceipt(proposal);
  const submitting = decision?.submitting ?? null;
  const error = decision?.error && (
    <p className="proposal-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>{decision.error}</span>
    </p>
  );
  const common = {
    role: 'region',
    'data-proposal-id': proposal.proposalId,
    'data-tool-call-id': proposal.toolCallId,
    'data-status': proposal.status,
  } as const;

  if (receipt && proposal.status !== 'pending') {
    const Icon = RECEIPT_ICONS[proposal.status];
    return (
      <section {...common} className={`task-receipt proposal-card confirmed ${proposal.status}`} aria-label={receipt.headline}>
        <Icon className={proposal.status === 'executing' ? 'spin' : undefined} aria-hidden="true" />
        <div>
          <strong>{receipt.headline}</strong>
          <span>{receipt.detail}</span>
          {proposal.status === 'executed' && proposal.outcome && proposal.outcome.refs.length > 0 && (
            <ObjectRefLinks refs={proposal.outcome.refs} />
          )}
          {error}
        </div>
      </section>
    );
  }

  const Icon = view.icon;
  const body = <view.Body proposal={proposal} />;
  return (
    <section {...common} className="task-receipt proposal-card pending" aria-label={`待确认：${proposal.title}`}>
      <div className="receipt-title">
        <Icon aria-hidden="true" />
        <div>
          <strong>{proposal.title}</strong>
          <span>{view.subtitle}</span>
        </div>
      </div>
      <dl>{body}</dl>
      {proposal.problem && (
        <p className="proposal-problem" role="note">
          <CircleAlert aria-hidden="true" />
          <span>{proposal.problem}目前不能确认，可以取消。</span>
        </p>
      )}
      {error}
      <div className="receipt-actions">
        <button type="button" className="secondary-button" disabled={submitting !== null} onClick={() => onDecide('cancel')}>
          {submitting === 'cancel' && <LoaderCircle className="spin" aria-hidden="true" />}
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={submitting !== null || proposal.problem !== null}
          onClick={() => onDecide('confirm')}
        >
          {submitting === 'confirm' && <LoaderCircle className="spin" aria-hidden="true" />}
          {view.confirmLabel}
        </button>
      </div>
    </section>
  );
}
