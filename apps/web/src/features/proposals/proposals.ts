import type { Proposal, ProposalDecision, ProposalStatus } from '@multivac/contracts';
import { AssistantApiError } from '../../data/assistant-api.js';

/** 用户在卡上作出的选择（只随确认提交，结构由提议种类决定）。 */
export type ProposalOptions = Record<string, unknown>;

export interface ProposalsApi {
  list: () => Promise<readonly Proposal[]>;
  decide: (proposalId: string, decision: ProposalDecision, options?: ProposalOptions) => Promise<Proposal>;
}

/** 一张卡上进行中的决定与最近一次失败的说明。 */
export interface ProposalDecisionState {
  submitting: ProposalDecision | null;
  error: string | null;
}

export interface ProposalsSnapshot {
  /** 全局 Multivac 的提议（含历史），按提出的先后；尚未读取成功时为 null。 */
  proposals: readonly Proposal[] | null;
  decisions: Readonly<Record<string, ProposalDecisionState>>;
  /**
   * 本窗口见过待确认状态的提议：它们有定论后仍原地留作回执，即使所属的那一轮不在当前历史窗口里
   * （例如服务重启后 Fake 的历史回到夹具，或历史分页之外），不会在用户点完之后凭空消失。
   */
  seenPending: ReadonlySet<string>;
}

/** 状态的先后：有定论的不被较早的待确认或执行中覆盖（事件与读取结果的到达顺序不定）。 */
function rank(status: ProposalStatus): number {
  if (status === 'pending') return 0;
  if (status === 'executing') return 1;
  return 2;
}

function newer(current: Proposal | undefined, next: Proposal): Proposal {
  return current && rank(current.status) > rank(next.status) ? current : next;
}

/** 决定失败时卡上的说明，以及是否需要按服务端状态重读。 */
export function proposalDecisionError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof AssistantApiError) {
    if (error.code === 'PROPOSAL_CONFLICT') return { message: error.message, refresh: true };
    if (error.code === 'NOT_FOUND') return { message: '提议已不存在，卡片已按服务端状态更新。', refresh: true };
    return { message: `没有提交：${error.message}`, refresh: false };
  }
  return { message: '没有提交：网络连接不可用，请重试。', refresh: false };
}

/**
 * 全局 Multivac 对话内的提议在应用内的唯一一份（与界面无关，便于单独测试）：首页与 Multivac 侧栏共用，
 * 同一张卡在两处的状态、进行中的决定与失败说明一致。
 *
 * 首次显示时读取；别处（其他窗口、Multivac 新提出）的变化经工作台事件写回（apply），事件流重连后已读取过的重读一次。
 * 合并规则是有定论的优先：较早的待确认快照不会覆盖已确认或已取消的结果。
 */
export class Proposals {
  private state: ProposalsSnapshot = { proposals: null, decisions: {}, seenPending: new Set() };
  // 每次读取的序号：只采用最近一次发起的读取结果。
  private latestRead = 0;
  // 各个进行中的读取期间写回的提议：读取结果可能早于它们，落地时按先后合并。
  private readonly appliedDuringReads = new Set<Map<string, Proposal>>();
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: ProposalsApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): ProposalsSnapshot => this.state;

  /** 还没有读取过时读取一次（多处同时显示只读一次）；失败时保持未读取，下次显示再试。 */
  ensureLoaded = (): void => {
    if (this.state.proposals || this.loading) return;
    this.loading = this.refresh().catch(() => undefined).finally(() => { this.loading = null; });
  };

  /** 重新读取全部提议；失败时保留已有列表并抛出错误。 */
  refresh = async (): Promise<void> => {
    const read = ++this.latestRead;
    const applied = new Map<string, Proposal>();
    this.appliedDuringReads.add(applied);
    try {
      const listed = await this.api.list();
      if (read !== this.latestRead) return;
      const current = new Map((this.state.proposals ?? []).map((proposal) => [proposal.proposalId, proposal]));
      const merged = listed.map((proposal) => newer(applied.get(proposal.proposalId) ?? current.get(proposal.proposalId), proposal));
      const missing = [...applied.values()].filter((proposal) => !listed.some((item) => item.proposalId === proposal.proposalId));
      this.replace([...merged, ...missing]);
    } finally {
      this.appliedDuringReads.delete(applied);
    }
  };

  /** 已读取过时重读一次（工作台事件流重连后补齐断线期间的变化）；失败时保留列表。 */
  refreshIfLoaded = (): void => {
    if (this.state.proposals) this.refresh().catch(() => undefined);
  };

  /** 写回一张提议的快照（别处的变化或本窗口决定的结果），有定论的优先。尚未读取时等首次读取。 */
  apply = (proposal: Proposal): void => {
    for (const applied of this.appliedDuringReads) applied.set(proposal.proposalId, newer(applied.get(proposal.proposalId), proposal));
    if (!this.state.proposals) return;
    const index = this.state.proposals.findIndex((item) => item.proposalId === proposal.proposalId);
    const next = [...this.state.proposals];
    if (index < 0) next.push(proposal);
    else if (newer(next[index], proposal) === next[index]) return;
    else next[index] = proposal;
    this.replace(next);
  };

  /**
   * 用户在卡上确认或取消（确认时带上卡上的选择）。进行中时同一张卡不再提交；成功后以服务端返回的提议写回
   * （卡片原地变为回执）。失败时卡上写明原因：冲突或已不存在时按服务端状态重读，其他失败保留按钮，可以重试。
   */
  decide = async (proposalId: string, decision: ProposalDecision, options?: ProposalOptions): Promise<void> => {
    if (this.state.decisions[proposalId]?.submitting) return;
    this.setDecision(proposalId, { submitting: decision, error: null });
    try {
      const proposal = await this.api.decide(proposalId, decision, decision === 'confirm' ? options : undefined);
      this.setDecision(proposalId, null);
      this.apply(proposal);
    } catch (error) {
      const failure = proposalDecisionError(error);
      this.setDecision(proposalId, { submitting: null, error: failure.message });
      if (failure.refresh) this.refresh().catch(() => undefined);
    }
  };

  private replace(proposals: Proposal[]): void {
    const seenPending = new Set(this.state.seenPending);
    for (const proposal of proposals) if (proposal.status === 'pending') seenPending.add(proposal.proposalId);
    this.state = { ...this.state, proposals, seenPending };
    this.publish();
  }

  private setDecision(proposalId: string, decision: ProposalDecisionState | null): void {
    const decisions = { ...this.state.decisions };
    if (decision) decisions[proposalId] = decision;
    else delete decisions[proposalId];
    this.state = { ...this.state, decisions };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * 有了定论（或正在执行）的卡片原地变成的回执：一行结果与一句说明（按原型 ConfirmedReceipt）。
 * 执行结果带回执（服务端按执行结果写成，如“已创建项目「x」”）时原样采用。
 */
export function proposalReceipt(proposal: Proposal): { headline: string; detail: string } | null {
  switch (proposal.status) {
    case 'pending':
      return null;
    case 'executing':
      return { headline: `正在执行：${proposal.title}`, detail: '你已确认，正在执行…' };
    case 'executed':
      if (proposal.outcome?.receipt) return { headline: proposal.outcome.receipt.headline, detail: proposal.outcome.receipt.detail };
      return { headline: `已执行：${proposal.title}`, detail: proposal.outcome?.summary ?? '已按你的确认执行。' };
    case 'cancelled':
      return { headline: `已取消：${proposal.title}`, detail: '没有做任何改动。' };
    case 'expired':
      return { headline: `已过期：${proposal.title}`, detail: `${proposal.reason ?? '确认时目标已经变化。'}没有执行。` };
    case 'failed':
      return { headline: `执行失败：${proposal.title}`, detail: proposal.reason ?? '没有完成。' };
  }
}
