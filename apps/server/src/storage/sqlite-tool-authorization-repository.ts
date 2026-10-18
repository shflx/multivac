import type { DatabaseSync } from 'node:sqlite';
import { appendEventRow } from './sqlite-assistant-event-rows.js';
import { runInTransaction } from './sqlite-transaction.js';
import type {
  ToolAuthorizationAccess,
  ToolAuthorizationApproval,
  ToolAuthorizationGrant,
  ToolAuthorizationRequest,
  ToolAuthorizationStatus,
  WorkingDirectory,
} from '@multivac/contracts';
import {
  grantCovers,
  type NewToolAuthorizationGrant,
  type NewToolAuthorizationRequest,
  type ResolvedToolAuthorizationStatus,
  type ToolAuthorizationGrantQuery,
  type ToolAuthorizationMutation,
  type ToolAuthorizationRepository,
  type ToolAuthorizationUserApproval,
} from '../modules/tool-authorization/tool-authorization.js';

export interface ToolAuthorizationRow {
  request_id: string;
  assistant_id: string;
  command_id: string | null;
  tool_name: ToolAuthorizationRequest['toolName'];
  tool_call_id: string;
  requested_path: string;
  target_path: string;
  working_directory_kind: WorkingDirectory['kind'];
  working_directory_path: string;
  status: ToolAuthorizationStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  approval_scope: ToolAuthorizationApproval['scope'] | null;
  approval_source: ToolAuthorizationApproval['source'] | null;
  grant_id: string | null;
  remember_directory: string | null;
  remember_project_id: string | null;
}

interface ToolAuthorizationGrantRow {
  grant_id: string;
  scope: ToolAuthorizationGrant['scope'];
  session_id: string | null;
  project_id: string | null;
  access: ToolAuthorizationAccess;
  directory: string;
  source_request_id: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
}

function toolAuthorizationFromRow(row: ToolAuthorizationRow): ToolAuthorizationRequest {
  return {
    requestId: row.request_id,
    sessionId: row.assistant_id,
    commandId: row.command_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    requestedPath: row.requested_path,
    targetPath: row.target_path,
    workingDirectory: { kind: row.working_directory_kind, path: row.working_directory_path },
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    approval: approvalFromColumns(row),
    remember: row.remember_directory
      ? { directory: row.remember_directory, projectId: row.remember_project_id }
      : null,
  };
}

/** 批准范围只随已批准的请求保存；缺列（迁移前的记录）按仅这一次的用户决定处理。 */
export function approvalFromColumns(row: Pick<ToolAuthorizationRow, 'status' | 'approval_scope' | 'approval_source' | 'grant_id'>): ToolAuthorizationApproval | null {
  if (row.status !== 'approved') return null;
  return {
    scope: row.approval_scope ?? 'once',
    source: row.approval_source ?? 'user',
    grantId: row.grant_id,
  };
}

function toolAuthorizationGrantFromRow(row: ToolAuthorizationGrantRow): ToolAuthorizationGrant {
  return {
    grantId: row.grant_id,
    scope: row.scope,
    sessionId: row.session_id,
    projectId: row.project_id,
    access: row.access,
    directory: row.directory,
    sourceRequestId: row.source_request_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    revokedAt: row.revoked_at,
  };
}

/**
 * 工具授权请求与记住的授权的 SQLite 实现：请求状态与对应的公开事件在同一事务中提交。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteToolAuthorizationRepository implements ToolAuthorizationRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(requestId: string): ToolAuthorizationRequest | undefined {
    const row = this.database.prepare('SELECT * FROM tool_authorization_request WHERE request_id = ?')
      .get(requestId) as unknown as ToolAuthorizationRow | undefined;
    return row ? toolAuthorizationFromRow(row) : undefined;
  }

  all(): ToolAuthorizationRequest[] {
    return (this.database.prepare('SELECT * FROM tool_authorization_request ORDER BY created_at,request_id').all() as unknown as ToolAuthorizationRow[]).map(toolAuthorizationFromRow);
  }

  listBySession(sessionId: string): ToolAuthorizationRequest[] {
    const rows = this.database.prepare(`
      SELECT * FROM tool_authorization_request WHERE assistant_id = ? ORDER BY created_at, rowid
    `).all(sessionId) as unknown as ToolAuthorizationRow[];
    return rows.map(toolAuthorizationFromRow);
  }

  /** 最近的请求，最近的在前；给出会话时只取这个会话的（按会话与创建时间的索引读取）。 */
  listRecent(limit: number, sessionId?: string): ToolAuthorizationRequest[] {
    const rows = (sessionId === undefined
      ? this.database.prepare(`
          SELECT * FROM tool_authorization_request ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(limit)
      : this.database.prepare(`
          SELECT * FROM tool_authorization_request WHERE assistant_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(sessionId, limit)) as unknown as ToolAuthorizationRow[];
    return rows.map(toolAuthorizationFromRow);
  }

  create(request: NewToolAuthorizationRequest): ToolAuthorizationMutation {
    return runInTransaction(this.database, () => {
      this.insertRow(request);
      const created = this.requireRequest(request.requestId);
      const event = appendEventRow(this.database, {
        sourceKey: `authorization:${request.requestId}:requested`,
        assistantSessionId: created.sessionId,
        commandId: created.commandId,
        type: 'assistant.authorization.requested',
        data: { request: created },
        occurredAt: created.createdAt,
      });
      return { request: created, event };
    });
  }

  /**
   * 按已记住的授权放行：请求直接以已批准（来源为记住的授权）写入，决定时间即创建时间；
   * 同一事务里更新授权的使用记录，只追加 resolved 事件（没有待授权阶段，不会出现授权卡）。
   */
  createRemembered(request: NewToolAuthorizationRequest, grantId: string): ToolAuthorizationMutation {
    return runInTransaction(this.database, () => {
      const grant = this.getGrant(grantId);
      if (!grant || grant.revokedAt !== null) throw new Error(`记住的授权不存在或已撤销：${grantId}`);
      this.insertRow(request, {
        decidedAt: request.createdAt,
        approval: { scope: grant.scope, source: 'grant', grantId },
      });
      this.database.prepare(`
        UPDATE tool_authorization_grant SET last_used_at = ?, use_count = use_count + 1 WHERE grant_id = ?
      `).run(request.createdAt, grantId);
      const created = this.requireRequest(request.requestId);
      const event = appendEventRow(this.database, {
        sourceKey: `authorization:${request.requestId}:resolved`,
        assistantSessionId: created.sessionId,
        commandId: created.commandId,
        type: 'assistant.authorization.resolved',
        data: { request: created },
        occurredAt: created.createdAt,
      });
      return { request: created, event };
    });
  }

  resolve(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    decidedAt: string,
    approval?: ToolAuthorizationUserApproval,
  ): ToolAuthorizationMutation {
    return runInTransaction(this.database, () => this.resolveRow(requestId, status, decidedAt, approval));
  }

  /** 匹配的第一条仍有效的授权：会话范围优先，同范围内先记住的优先。路径包含关系按路径段判断。 */
  findGrant(query: ToolAuthorizationGrantQuery): ToolAuthorizationGrant | undefined {
    const rows = this.database.prepare(`
      SELECT * FROM tool_authorization_grant
      WHERE revoked_at IS NULL AND access = ?
        AND ((scope = 'session' AND session_id = ?) OR (scope = 'project' AND project_id = ?))
      ORDER BY scope = 'project', created_at, rowid
    `).all(query.access, query.sessionId, query.projectId) as unknown as ToolAuthorizationGrantRow[];
    return rows.map(toolAuthorizationGrantFromRow).find((grant) => grantCovers(grant, query));
  }

  listGrants(): ToolAuthorizationGrant[] {
    const rows = this.database.prepare(`
      SELECT * FROM tool_authorization_grant WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC
    `).all() as unknown as ToolAuthorizationGrantRow[];
    return rows.map(toolAuthorizationGrantFromRow);
  }

  getGrant(grantId: string): ToolAuthorizationGrant | undefined {
    const row = this.database.prepare('SELECT * FROM tool_authorization_grant WHERE grant_id = ?')
      .get(grantId) as unknown as ToolAuthorizationGrantRow | undefined;
    return row ? toolAuthorizationGrantFromRow(row) : undefined;
  }

  revokeGrant(grantId: string, revokedAt: string): ToolAuthorizationGrant | undefined {
    this.database.prepare(`
      UPDATE tool_authorization_grant SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL
    `).run(revokedAt, grantId);
    return this.getGrant(grantId);
  }

  deleteAllGrantsForTest(): void {
    this.database.exec('DELETE FROM tool_authorization_grant');
  }

  invalidatePending(decidedAt: string): ToolAuthorizationMutation[] {
    return runInTransaction(this.database, () => {
      const rows = this.database.prepare(`
        SELECT request_id FROM tool_authorization_request WHERE status = 'pending' ORDER BY created_at, rowid
      `).all() as unknown as Array<{ request_id: string }>;
      return rows.map((row) => this.resolveRow(row.request_id, 'invalidated', decidedAt));
    });
  }

  private insertRow(
    request: NewToolAuthorizationRequest,
    approved?: { decidedAt: string; approval: ToolAuthorizationApproval },
  ): void {
    this.database.prepare(`
      INSERT INTO tool_authorization_request (
        request_id, assistant_id, command_id, tool_name, tool_call_id, requested_path, target_path,
        working_directory_kind, working_directory_path, status, created_at, expires_at, decided_at,
        approval_scope, approval_source, grant_id, remember_directory, remember_project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.requestId, request.sessionId, request.commandId, request.toolName, request.toolCallId,
      request.requestedPath, request.targetPath, request.workingDirectory.kind, request.workingDirectory.path,
      approved ? 'approved' : 'pending', request.createdAt, request.expiresAt, approved?.decidedAt ?? null,
      approved?.approval.scope ?? null, approved?.approval.source ?? null, approved?.approval.grantId ?? null,
      request.remember?.directory ?? null, request.remember?.projectId ?? null,
    );
  }

  /**
   * 只有待授权的请求会转为终态；状态与事件在调用方的事务内一起提交。
   * 批准时写入范围；本会话内 / 本项目内同时记住授权，已有同一范围、类别与目录的有效授权时沿用那一条。
   */
  private resolveRow(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    decidedAt: string,
    approval?: ToolAuthorizationUserApproval,
  ): ToolAuthorizationMutation {
    const current = this.requireRequest(requestId);
    if (current.status !== 'pending') return { request: current, event: null };
    if ((status === 'approved') !== (approval !== undefined)) {
      throw new Error('只有批准需要、也必须给出批准范围。');
    }
    const grantId = approval && approval.scope !== 'once' ? this.rememberGrant(approval.grant) : null;
    this.database.prepare(`
      UPDATE tool_authorization_request
      SET status = ?, decided_at = ?, approval_scope = ?, approval_source = ?, grant_id = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(status, decidedAt, approval?.scope ?? null, approval ? 'user' : null, grantId, requestId);
    const resolved = this.requireRequest(requestId);
    const event = appendEventRow(this.database, {
      sourceKey: `authorization:${requestId}:resolved`,
      assistantSessionId: resolved.sessionId,
      commandId: resolved.commandId,
      type: 'assistant.authorization.resolved',
      data: { request: resolved },
      occurredAt: decidedAt,
    });
    return { request: resolved, event };
  }

  /** 写入记住的授权；同一范围、类别与目录已有仍有效的授权时不重复记住，返回那一条的 id。 */
  private rememberGrant(grant: NewToolAuthorizationGrant): string {
    const existing = this.database.prepare(`
      SELECT grant_id FROM tool_authorization_grant
      WHERE revoked_at IS NULL AND scope = ? AND session_id IS ? AND project_id IS ? AND access = ? AND directory = ?
    `).get(grant.scope, grant.sessionId, grant.projectId, grant.access, grant.directory) as { grant_id: string } | undefined;
    if (existing) return existing.grant_id;
    this.database.prepare(`
      INSERT INTO tool_authorization_grant (
        grant_id, scope, session_id, project_id, access, directory, source_request_id, created_at,
        last_used_at, use_count, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
    `).run(
      grant.grantId, grant.scope, grant.sessionId, grant.projectId, grant.access, grant.directory,
      grant.sourceRequestId, grant.createdAt,
    );
    return grant.grantId;
  }

  private requireRequest(requestId: string): ToolAuthorizationRequest {
    const request = this.get(requestId);
    if (!request) throw new Error(`授权请求不存在：${requestId}`);
    return request;
  }
}
