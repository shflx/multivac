import { randomUUID } from 'node:crypto';
import {
  AssistantToolResultSchema,
  INTERNAL_TOOL_RESULT_MAX_REFS,
  INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH,
  PROPOSAL_KIND_PATTERN,
  PROPOSAL_TITLE_MAX_LENGTH,
  UNKNOWN_CHANGE_ORIGIN,
  type AssistantToolResult,
  type Proposal,
  type ProposalDecision,
  type ProposalStatus,
  type WorkbenchChangeOrigin,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  ProposalExecutionError,
  publicProposal,
  renderProposalNotice,
  type ProposalKind,
  type ProposalRecord,
  type ProposalRepository,
} from '../../modules/proposals/proposal.js';
import type { CoordinatorServerNotice } from '../../runtime/executors/coordinator-adapter.js';
import type {
  InternalToolProposal,
  InternalToolProposalOrigin,
  InternalToolProposalSink,
  ProposalSubmission,
} from '../internal-tools/internal-tool-service.js';
import type { WorkbenchEventPublisher } from '../workbench-events.js';

export class ProposalServiceError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PROPOSAL_CONFLICT', message: string) {
    super(message);
    this.name = 'ProposalServiceError';
  }
}

export interface ProposalServiceOptions {
  repository: ProposalRepository;
  /** 注册的提议种类（执行器）；kind 不得重复。 */
  kinds: readonly ProposalKind[];
  /** 工作台变更事件：提议新提出与每次状态变化都推给各窗口；未提供时不发布。 */
  workbenchEvents?: WorkbenchEventPublisher;
  now?: () => Date;
  idFactory?: () => string;
}

/** 已有定论的提议不能再改为另一个决定时的说明。 */
const CONFLICT_MESSAGES: Record<Exclude<ProposalStatus, 'pending'>, string> = {
  executing: '提议正在执行，不能取消。',
  executed: '提议已确认并执行，不能再取消。',
  cancelled: '提议已取消，不能再确认；需要的话请让 Multivac 重新提出。',
  expired: '提议已过期（确认时目标已经变化），没有执行，也不能再取消。',
  failed: '提议已确认，但执行失败，不能再取消。',
};

/** 执行结果按公开结果的白名单收窄：摘要截到上限、对象限量；仍不合格时只写“已执行”。 */
function publicOutcome(outcome: AssistantToolResult): AssistantToolResult {
  const candidate = {
    summary: outcome.summary.trim().slice(0, INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH) || '已执行',
    refs: outcome.refs.slice(0, INTERNAL_TOOL_RESULT_MAX_REFS),
  };
  return Check(AssistantToolResultSchema, candidate) ? candidate : { summary: '已执行', refs: [] };
}

const INTERRUPTED_REASON = '执行过程中服务重启，结果未知；为避免重复执行，没有再次执行。请查看当前状态后再决定是否重新操作。';
const UNEXPECTED_FAILURE = '执行时发生意外错误，没有完成。可以让 Multivac 重新提出，或在界面中操作。';

/**
 * 全局 Multivac 对话内的提议（确认卡）：提议类内部工具经 propose 提交到这里，生成持久化的待确认提议；
 * 用户在卡上确认或取消（只经 HTTP 接口，不是 Agent 工具），确认时按当前状态重新校验，目标已变化则过期、不执行，
 * 通过后由注册的提议种类执行。每次变化推给各窗口；有定论的结果在全局 Multivac 下一轮开始时以服务端通知告诉模型。
 *
 * 状态机：pending ─取消→ cancelled；pending ─确认→ executing ─→ executed / expired（重新校验不通过）/ failed；
 * 执行中服务重启 → failed（启动对账，不重新执行）。转换都是 SQLite 条件更新，竞争时以先到的为准。
 * 决定按提议 id 幂等：重复同一决定返回当前记录（确认中的等待同一结果），与已有定论冲突时报 PROPOSAL_CONFLICT。
 */
export class ProposalService implements InternalToolProposalSink {
  private readonly kinds: ReadonlyMap<string, ProposalKind>;
  private readonly executions = new Map<string, Promise<ProposalRecord>>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(private readonly options: ProposalServiceOptions) {
    const kinds = new Map<string, ProposalKind>();
    const pattern = new RegExp(PROPOSAL_KIND_PATTERN, 'u');
    for (const kind of options.kinds) {
      if (!pattern.test(kind.kind)) throw new Error(`提议种类 ${kind.kind} 的写法不合法。`);
      if (kinds.has(kind.kind)) throw new Error(`提议种类 ${kind.kind} 重复注册。`);
      kinds.set(kind.kind, kind);
    }
    this.kinds = kinds;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * 生成待确认的提议（提议类工具的 propose）：按种类的 schema 严格校验参数，由种类只读核对并给出卡片内容，
   * 写入后推给各窗口。不执行任何操作。同一次工具调用重放时返回已有的那一张。
   */
  async submit(proposal: InternalToolProposal, origin: InternalToolProposalOrigin): Promise<ProposalSubmission> {
    const kind = this.kinds.get(proposal.kind);
    // 工具与种类不匹配属于程序错误：框架统一转成“执行失败”，不生成卡片。
    if (!kind) throw new Error(`没有注册提议种类 ${proposal.kind}。`);
    if (!Check(kind.payload, proposal.payload)) throw new Error(`提议 ${proposal.kind} 的参数不符合种类的 schema。`);

    const draft = await kind.prepare(proposal.payload);
    const title = draft.title.trim().slice(0, PROPOSAL_TITLE_MAX_LENGTH) || '提议';
    const { record, inserted } = this.options.repository.create({
      proposalId: this.idFactory(),
      sessionId: origin.sessionId,
      commandId: origin.turnCommandId,
      toolCallId: origin.toolCallId,
      kind: kind.kind,
      title,
      payload: proposal.payload,
      preview: draft.preview ?? null,
      problem: draft.problem?.trim() || null,
      createdAt: this.now().toISOString(),
    });
    if (inserted) {
      this.publish('created', record, { windowId: origin.originWindowId, commandId: origin.turnCommandId });
    }
    return { proposalId: record.proposalId, title: record.title, problem: record.problem, refs: draft.refs ?? [] };
  }

  /** 会话的全部提议（含历史），按提出的先后。 */
  list(sessionId: string): Proposal[] {
    return this.options.repository.listBySession(sessionId).map(publicProposal);
  }

  /**
   * 用户在卡上的决定（只经界面或接口，不是 Agent 工具）。
   * - 取消：待确认 → 已取消；已取消的原样返回；其他状态报冲突。
   * - 确认：待确认 → 执行中 → 重新校验 → 已执行 / 已过期 / 执行失败；执行中的等待同一结果；
   *   已执行、已过期、执行失败（都是确认的结果）原样返回；已取消的报冲突。
   */
  async decide(
    sessionId: string,
    proposalId: string,
    decision: ProposalDecision,
    origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN,
  ): Promise<Proposal> {
    const current = this.options.repository.get(proposalId);
    if (!current || current.sessionId !== sessionId) throw new ProposalServiceError('NOT_FOUND', '提议不存在。');

    if (decision === 'cancel') {
      if (current.status === 'pending') {
        const cancelled = this.options.repository.transition(proposalId, ['pending'], {
          status: 'cancelled', decidedAt: this.now().toISOString(),
        });
        if (cancelled) {
          this.publish('updated', cancelled, origin);
          return publicProposal(cancelled);
        }
        return this.decide(sessionId, proposalId, decision, origin);
      }
      if (current.status === 'cancelled') return publicProposal(current);
      throw new ProposalServiceError('PROPOSAL_CONFLICT', CONFLICT_MESSAGES[current.status]);
    }

    const running = this.executions.get(proposalId);
    if (running) return publicProposal(await running);
    if (current.status === 'cancelled') throw new ProposalServiceError('PROPOSAL_CONFLICT', CONFLICT_MESSAGES.cancelled);
    if (current.status !== 'pending') return publicProposal(current);

    // 从读到待确认到登记执行之间没有 await：同一提议的并发确认只执行一次。
    const execution = this.confirm(current, origin).finally(() => this.executions.delete(proposalId));
    this.executions.set(proposalId, execution);
    return publicProposal(await execution);
  }

  /**
   * 取出待告诉模型的提议结果（全局 Multivac 开始新的一轮时调用），取出即记为已告诉：写成一条简短的服务端通知。
   * 没有时返回 undefined。
   */
  takeNotice(sessionId: string): CoordinatorServerNotice | undefined {
    const records = this.options.repository.listUnnotified(sessionId);
    if (records.length === 0) return undefined;
    const proposalIds = records.map((record) => record.proposalId);
    this.options.repository.markNotified(proposalIds, this.now().toISOString());
    return { text: renderProposalNotice(records), proposalIds };
  }

  /**
   * 启动对账：上一进程中确认后正在执行的提议没有结果可查，一律记为执行失败并说明结果未知，不重新执行。
   * 待确认的提议不受重启影响，照常可以确认或取消。
   */
  reconcileOnStartup(): Proposal[] {
    return this.options.repository.failExecuting(INTERRUPTED_REASON, this.now().toISOString())
      .map((record) => {
        this.publish('updated', record, UNKNOWN_CHANGE_ORIGIN);
        return publicProposal(record);
      });
  }

  /** 仅供 Fake E2E 在用例之间删除全部提议（全局 Multivac 的会话不随重置删除）。 */
  resetForTest(): void {
    this.options.repository.deleteAllForTest();
  }

  private async confirm(current: ProposalRecord, origin: WorkbenchChangeOrigin): Promise<ProposalRecord> {
    const kind = this.kinds.get(current.kind);
    const executing = this.options.repository.transition(current.proposalId, ['pending'], {
      status: 'executing', decidedAt: this.now().toISOString(),
    });
    // 状态已被别处改变（例如刚被取消）：以记录为准。
    if (!executing) {
      const latest = this.options.repository.get(current.proposalId)!;
      if (latest.status === 'cancelled') throw new ProposalServiceError('PROPOSAL_CONFLICT', CONFLICT_MESSAGES.cancelled);
      return latest;
    }
    this.publish('updated', executing, origin);

    let result: ProposalRecord | undefined;
    if (!kind) {
      result = this.settle(current.proposalId, { status: 'failed', reason: '这种提议在当前版本中已不再支持，没有执行。' });
    } else {
      let problem: string | null;
      try {
        problem = await kind.revalidate(current.payload, current.preview);
      } catch {
        problem = '确认时无法核对当前状态，为避免误操作没有执行。';
      }
      if (problem) {
        result = this.settle(current.proposalId, { status: 'expired', reason: problem });
      } else {
        try {
          const outcome = publicOutcome(await kind.execute(current.payload, current.preview, origin));
          result = this.settle(current.proposalId, { status: 'executed', outcome });
        } catch (error) {
          result = this.settle(current.proposalId, {
            status: 'failed',
            reason: error instanceof ProposalExecutionError ? error.reason : UNEXPECTED_FAILURE,
          });
        }
      }
    }
    this.publish('updated', result, origin);
    return result;
  }

  private settle(
    proposalId: string,
    to: { status: 'executed' | 'expired' | 'failed'; outcome?: ProposalRecord['outcome']; reason?: string },
  ): ProposalRecord {
    return this.options.repository.transition(proposalId, ['executing'], {
      status: to.status,
      ...(to.outcome ? { outcome: to.outcome } : {}),
      ...(to.reason ? { reason: to.reason } : {}),
    }) ?? this.options.repository.get(proposalId)!;
  }

  private publish(change: 'created' | 'updated', record: ProposalRecord, origin: WorkbenchChangeOrigin): void {
    this.options.workbenchEvents?.publish({ type: 'proposal.changed', origin, change, proposal: publicProposal(record) });
  }
}
