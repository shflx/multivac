import type { DatabaseSync } from 'node:sqlite';
import { toolResultFromJson } from './sqlite-tool-result-column.js';
import { runInTransaction } from './sqlite-transaction.js';
import type { ProposalStatus } from '@multivac/contracts';
import type { NewProposal, ProposalRecord, ProposalRepository, ProposalTransition } from '../modules/proposals/proposal.js';

interface ProposalRow {
  proposal_id: string;
  session_id: string;
  command_id: string | null;
  tool_call_id: string;
  kind: string;
  title: string;
  payload_json: string;
  preview_json: string;
  problem: string | null;
  status: ProposalStatus;
  outcome_json: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
  notified_at: string | null;
}

function jsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function proposalFromRow(row: ProposalRow): ProposalRecord {
  return {
    proposalId: row.proposal_id,
    sessionId: row.session_id,
    commandId: row.command_id,
    toolCallId: row.tool_call_id,
    kind: row.kind,
    title: row.title,
    payload: jsonOrNull(row.payload_json),
    preview: jsonOrNull(row.preview_json),
    problem: row.problem,
    status: row.status,
    // 结果与工具的公开结果同一白名单，读出时再校验一次。
    outcome: toolResultFromJson(row.outcome_json),
    reason: row.reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    notifiedAt: row.notified_at,
  };
}

/**
 * 待用户确认的提议的 SQLite 实现：按会话与 toolCallId 幂等创建，状态只按条件转换。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteProposalRepository implements ProposalRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => string) {}

  get(proposalId: string): ProposalRecord | undefined {
    const row = this.database.prepare('SELECT * FROM internal_tool_proposal WHERE proposal_id = ?')
      .get(proposalId) as unknown as ProposalRow | undefined;
    return row ? proposalFromRow(row) : undefined;
  }

  listBySession(sessionId: string): ProposalRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM internal_tool_proposal WHERE session_id = ? ORDER BY created_at, rowid
    `).all(sessionId) as unknown as ProposalRow[];
    return rows.map(proposalFromRow);
  }

  /** 同一会话的同一 toolCallId 已有提议时不写入，返回已有的那一张（INSERT OR IGNORE 与读取在同一事务中）。 */
  create(proposal: NewProposal): { record: ProposalRecord; inserted: boolean } {
    return runInTransaction(this.database, () => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO internal_tool_proposal (
          proposal_id, session_id, command_id, tool_call_id, kind, title, payload_json, preview_json, problem,
          status, outcome_json, reason, created_at, decided_at, updated_at, notified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?, NULL)
      `).run(
        proposal.proposalId, proposal.sessionId, proposal.commandId, proposal.toolCallId, proposal.kind, proposal.title,
        JSON.stringify(proposal.payload ?? null), JSON.stringify(proposal.preview ?? null), proposal.problem,
        proposal.createdAt, proposal.createdAt,
      ).changes > 0;
      const row = this.database.prepare(`
        SELECT * FROM internal_tool_proposal WHERE session_id = ? AND tool_call_id = ?
      `).get(proposal.sessionId, proposal.toolCallId) as unknown as ProposalRow;
      return { record: proposalFromRow(row), inserted };
    });
  }

  /** 条件更新：只有当前状态在 from 之中时才转换；决定时间只在第一次离开待确认时写入。 */
  transition(
    proposalId: string,
    from: readonly ProposalStatus[],
    to: ProposalTransition,
  ): ProposalRecord | undefined {
    if (from.length === 0) return undefined;
    const updatedAt = this.now();
    const changed = this.database.prepare(`
      UPDATE internal_tool_proposal
      SET status = ?, outcome_json = ?, reason = ?, decided_at = COALESCE(decided_at, ?), updated_at = ?
      WHERE proposal_id = ? AND status IN (${from.map(() => '?').join(', ')})
    `).run(
      to.status, to.outcome ? JSON.stringify(to.outcome) : null, to.reason ?? null, to.decidedAt ?? updatedAt, updatedAt,
      proposalId, ...from,
    ).changes > 0;
    return changed ? this.get(proposalId) : undefined;
  }

  listUnnotified(sessionId: string): ProposalRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM internal_tool_proposal
      WHERE session_id = ? AND notified_at IS NULL AND status IN ('executed', 'cancelled', 'expired', 'failed')
      ORDER BY updated_at, rowid
    `).all(sessionId) as unknown as ProposalRow[];
    return rows.map(proposalFromRow);
  }

  markNotified(proposalIds: readonly string[], notifiedAt: string): void {
    if (proposalIds.length === 0) return;
    this.database.prepare(`
      UPDATE internal_tool_proposal SET notified_at = ?
      WHERE notified_at IS NULL AND proposal_id IN (${proposalIds.map(() => '?').join(', ')})
    `).run(notifiedAt, ...proposalIds);
  }

  failExecuting(reason: string, decidedAt: string): ProposalRecord[] {
    return runInTransaction(this.database, () => {
      const ids = (this.database.prepare(`
        SELECT proposal_id FROM internal_tool_proposal WHERE status = 'executing' ORDER BY updated_at, rowid
      `).all() as Array<{ proposal_id: string }>).map((row) => row.proposal_id);
      return ids.flatMap((id) => this.transition(id, ['executing'], { status: 'failed', reason, decidedAt }) ?? []);
    });
  }

  deleteAllForTest(): void {
    this.database.exec('DELETE FROM internal_tool_proposal');
  }
}
