import { CircleAlert, CircleCheck, CircleSlash, CircleX, LoaderCircle, Pause, TimerOff } from 'lucide-react';
import { useState } from 'react';
import type { Proposal, ProposalDecision } from '@multivac/contracts';
import { ObjectRefLinks } from '../assistant/object-links.js';
import { ReceiptActionNotes, useReceiptActions } from '../assistant/tool-receipt.js';
import { proposalKindView, type ProposalKindView } from './proposal-kinds.js';
import { proposalReceipt, type ProposalDecisionState, type ProposalOptions } from './proposals.js';

interface ProposalCardProps {
  proposal: Proposal;
  decision?: ProposalDecisionState | undefined;
  /** 用户的决定；确认时带上卡上的选择（没有可选择内容的种类为 undefined）。 */
  onDecide: (decision: ProposalDecision, options?: ProposalOptions) => void;
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
 * 待确认时按原型的确认卡写：图标、标题（要做的事）与一句说明，种类提供的内容（两列字段，可以有用户在卡上的选择），
 * 提出时核对不通过的原因，此刻不能确认的原因（如会话正在运行），“取消 / 确认”。确认或取消后原地变为一行回执
 * （不再追加消息）：已执行（有回执时写明结果并带可以接着做的操作，否则附结果涉及的对象）、已取消、已过期（写明原因）、
 * 执行失败。卡片状态全部来自服务端的提议记录；只有用户在这里的操作能确认，Multivac 无法代为确认。
 */
export function ProposalCard({ proposal, decision, onDecide }: ProposalCardProps) {
  const view = proposalKindView(proposal.kind);
  const error = decision?.error ?? null;
  if (proposal.status !== 'pending') return <ProposalReceipt proposal={proposal} error={error} />;
  // 按提议 id 挂载：卡上的选择与实时状态的订阅属于这一张卡。
  return <PendingProposalCard key={proposal.proposalId} proposal={proposal} view={view} decision={decision} onDecide={onDecide} />;
}

function commonAttributes(proposal: Proposal) {
  return {
    role: 'region',
    'data-proposal-id': proposal.proposalId,
    'data-tool-call-id': proposal.toolCallId,
    'data-status': proposal.status,
  } as const;
}

function DecisionError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="proposal-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>{error}</span>
    </p>
  );
}

/** 服务端给出的原因可能不以句号结尾（例如以路径结尾）：补上句号再接下一句。 */
function sentence(text: string): string {
  return /[。！？.!?]$/u.test(text) ? text : `${text}。`;
}

/** 没有实时条件的种类：此刻总可以确认（仍以服务端重新校验为准）。 */
function noBlocker(): string | null {
  return null;
}

function PendingProposalCard({ proposal, view, decision, onDecide }: ProposalCardProps & { view: ProposalKindView }) {
  // 卡上的选择从种类给出的默认值开始（模型的参数至多决定默认值），之后只由用户修改。
  const [options, setOptions] = useState<ProposalOptions | null>(() => view.initialOptions?.(proposal) ?? null);
  // 每种提议的卡片在整个生命周期内固定调用同一个（hook）：kind 不会变化。
  const useBlocker = view.useBlocker ?? noBlocker;
  const blocker = useBlocker(proposal);
  const submitting = decision?.submitting ?? null;
  const Icon = view.icon;
  const Body = view.Body;
  return (
    <section {...commonAttributes(proposal)} className="task-receipt proposal-card pending" aria-label={`待确认：${proposal.title}`}>
      <div className="receipt-title">
        <Icon aria-hidden="true" />
        <div>
          <strong>{proposal.title}</strong>
          <span>{view.subtitle}</span>
        </div>
      </div>
      <dl className={view.fieldsClassName}>
        <Body proposal={proposal} options={options} onOptionsChange={setOptions} disabled={submitting !== null} />
      </dl>
      {proposal.problem && (
        <p className="proposal-problem" role="note">
          <CircleAlert aria-hidden="true" />
          <span>{sentence(proposal.problem)}目前不能确认，可以取消。</span>
        </p>
      )}
      {!proposal.problem && blocker && (
        <p className="move-warning" role="status">
          <Pause aria-hidden="true" />
          {blocker}
        </p>
      )}
      <DecisionError error={decision?.error ?? null} />
      <div className="receipt-actions">
        <button type="button" className="secondary-button" disabled={submitting !== null} onClick={() => onDecide('cancel')}>
          {submitting === 'cancel' && <LoaderCircle className="spin" aria-hidden="true" />}
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={submitting !== null || proposal.problem !== null || blocker !== null}
          onClick={() => onDecide('confirm', options ?? undefined)}
        >
          {submitting === 'confirm' && <LoaderCircle className="spin" aria-hidden="true" />}
          {view.confirmLabel}
        </button>
      </div>
    </section>
  );
}

/** 有了定论（或正在执行）的卡片原地变成的一行回执；执行结果带回执时附上可以接着做的操作。 */
function ProposalReceipt({ proposal, error }: { proposal: Proposal; error: string | null }) {
  const receipt = proposalReceipt(proposal)!;
  const outcomeReceipt = proposal.status === 'executed' ? proposal.outcome?.receipt ?? null : null;
  const actions = useReceiptActions(outcomeReceipt?.actions ?? []);
  const Icon = RECEIPT_ICONS[proposal.status as keyof typeof RECEIPT_ICONS];
  return (
    <section
      {...commonAttributes(proposal)}
      className={`task-receipt proposal-card confirmed ${proposal.status}`}
      aria-label={receipt.headline}
    >
      <Icon className={proposal.status === 'executing' ? 'spin' : undefined} aria-hidden="true" />
      <div>
        <strong>{receipt.headline}</strong>
        {receipt.detail && <span>{receipt.detail}</span>}
        {proposal.status === 'executed' && !outcomeReceipt && proposal.outcome && proposal.outcome.refs.length > 0 && (
          <ObjectRefLinks refs={proposal.outcome.refs} />
        )}
        <ReceiptActionNotes notice={actions.notice} error={actions.error} />
        <DecisionError error={error} />
      </div>
      {actions.buttons}
    </section>
  );
}
