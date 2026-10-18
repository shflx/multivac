import type { DatabaseSync } from 'node:sqlite';
import type { McpTransport } from '@multivac/contracts';
import {
  McpError, assertMcpTransition, mcpCanonical, mcpFactId, mcpFactService, validateMcpFact,
  type McpFactKind, type McpFactRef, type McpFacts, type McpReceipt, type McpRepository, type McpTransaction,
} from '../modules/mcp/mcp.js';
import { runInTransaction } from './sqlite-transaction.js';

export const MCP_MIGRATION = `
CREATE TABLE IF NOT EXISTS mcp_fact (
  kind TEXT NOT NULL, id TEXT NOT NULL, service_id TEXT, revision INTEGER NOT NULL CHECK (revision > 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)), PRIMARY KEY (kind,id)
) STRICT;
CREATE INDEX IF NOT EXISTS mcp_fact_service_idx ON mcp_fact(kind,service_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_rule_scope_idx ON mcp_fact(service_id,
  json_extract(record_json,'$.target.kind'), COALESCE(json_extract(record_json,'$.target.projectId'),json_extract(record_json,'$.target.agentId'),json_extract(record_json,'$.target.sessionId')))
  WHERE kind='rule';
CREATE UNIQUE INDEX IF NOT EXISTS mcp_call_identity_idx ON mcp_fact(json_extract(record_json,'$.identity.sessionId'),json_extract(record_json,'$.identity.toolCallId')) WHERE kind='call';
CREATE TABLE IF NOT EXISTS mcp_service_version (
  service_id TEXT NOT NULL, version TEXT NOT NULL, transport_json TEXT NOT NULL,
  PRIMARY KEY(service_id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS mcp_command (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS mcp_event (
  sequence INTEGER PRIMARY KEY, command_id TEXT NOT NULL REFERENCES mcp_command(id),
  kind TEXT NOT NULL, fact_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
) STRICT;
`;

/** MCP 事实及回执共用显式短事务；外部 I/O 不属于此事务。 */
export class SqliteMcpRepository implements McpRepository {
  constructor(private readonly db: DatabaseSync) {}
  get<K extends McpFactKind>(kind: K, id: string): McpFacts[K] | null {
    const row = this.db.prepare('SELECT record_json FROM mcp_fact WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.record_json)) as McpFacts[K] : null;
  }
  list<K extends McpFactKind>(kind: K, options: { serviceId?: string; offset?: number; limit?: number } = {}): McpFacts[K][] {
    const { offset = 0, limit = 100 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new McpError('invalid-config', 'MCP 分页参数无效。', 400);
    const rows = options.serviceId === undefined
      ? this.db.prepare('SELECT record_json FROM mcp_fact WHERE kind=? ORDER BY id LIMIT ? OFFSET ?').all(kind, limit, offset)
      : this.db.prepare('SELECT record_json FROM mcp_fact WHERE kind=? AND service_id=? ORDER BY id LIMIT ? OFFSET ?').all(kind, options.serviceId, limit, offset);
    return rows.map((row) => JSON.parse(String(row.record_json)) as McpFacts[K]);
  }
  serviceVersion(serviceId: string, version: string): McpTransport | null {
    const row = this.db.prepare('SELECT transport_json FROM mcp_service_version WHERE service_id=? AND version=?').get(serviceId, version);
    return row ? JSON.parse(String(row.transport_json)) as McpTransport : null;
  }
  receipt(commandId: string, fingerprint: string): McpReceipt | null {
    const row = this.db.prepare('SELECT fingerprint,receipt_json FROM mcp_command WHERE id=?').get(commandId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new McpError('conflict', '同一 MCP 命令的参数不一致。');
    return JSON.parse(String(row.receipt_json)) as McpReceipt;
  }
  commit(commandId: string, fingerprint: string, at: string, operation: (tx: McpTransaction) => void): McpReceipt {
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(commandId) || !/^[a-f0-9]{64}$/u.test(fingerprint))
      throw new McpError('invalid-config', 'MCP 命令身份无效。', 400);
    return runInTransaction(this.db, () => {
      const previous = this.receipt(commandId, fingerprint);
      if (previous) return previous;
      const changes: McpFactRef[] = [];
      let active = true;
      const tx: McpTransaction = {
        get: this.get.bind(this), list: this.list.bind(this),
        put: (kind, value, expectedRevision) => {
          if (!active) throw new McpError('conflict', 'MCP 事务已结束。');
          validateMcpFact(kind, value);
          const id = mcpFactId(kind, value), old = this.get(kind, id);
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
            || (old?.revision ?? 0) !== expectedRevision || value.revision !== expectedRevision + 1)
            throw new McpError('conflict', 'MCP 记录已变化，请重新核对。');
          if (old) assertMcpTransition(kind, old, value);
          this.checkReferences(kind, value, old);
          const serviceId = mcpFactService(value);
          this.db.prepare('INSERT INTO mcp_fact VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET service_id=excluded.service_id,revision=excluded.revision,record_json=excluded.record_json')
            .run(kind, id, serviceId, value.revision, mcpCanonical(value));
          if (kind === 'service') {
            const service = value as McpFacts['service'];
            this.db.prepare('INSERT OR IGNORE INTO mcp_service_version VALUES (?,?,?)')
              .run(id, service.configVersion, mcpCanonical(service.transport));
          }
          changes.push({ kind, id, revision: value.revision });
        },
      };
      try {
        const result: unknown = operation(tx);
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw new McpError('conflict', 'MCP 事务不接受异步操作。');
      } finally { active = false; }
      const receipt: McpReceipt = { commandId, changes, createdAt: at };
      this.db.prepare('INSERT INTO mcp_command VALUES (?,?,?)').run(commandId, fingerprint, mcpCanonical(receipt));
      for (const change of changes) this.db.prepare('INSERT INTO mcp_event(command_id,kind,fact_id,revision,created_at) VALUES (?,?,?,?,?)')
        .run(commandId, change.kind, change.id, change.revision, at);
      return receipt;
    });
  }
  private checkReferences<K extends McpFactKind>(kind: K, value: McpFacts[K], old: McpFacts[K] | null): void {
    const serviceId = mcpFactService(value);
    if (kind !== 'service' && serviceId && !this.get('service', serviceId))
      throw new McpError('not-found', 'MCP 服务不存在。', 404);
    if ('accountId' in value && kind !== 'account') {
      const account = this.get('account', value.accountId);
      if (!account || account.serviceId !== serviceId || (!old && 'accountRevision' in value && value.accountRevision !== account.revision))
        throw new McpError('identity-changed', 'MCP 账号身份或版本不适用。');
    }
    if ('identity' in value) {
      const { identity } = value;
      const service = this.get('service', identity.serviceId), account = this.get('account', identity.accountId);
      if (!service || !account || account.serviceId !== service.serviceId)
        throw new McpError('identity-changed', 'MCP 调用的服务与账号不匹配。');
    }
  }
}
