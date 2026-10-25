import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { ProjectTerminalSchema, terminalIsActive, type ProjectTerminal } from '@multivac/contracts';
import { assertTerminalTransition, type TerminalRepository } from '../modules/terminals/terminal-record.js';
import { runInTransaction } from './sqlite-transaction.js';

/** 独立业务表，无会话、Task/Run 或进程托管外键；仅保存白名单元数据。 */
export const TERMINAL_MIGRATION = `
  CREATE TABLE IF NOT EXISTS project_terminal (
    terminal_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS project_terminal_activity_idx ON project_terminal
    (project_id, json_extract(record_json, '$.lastActivityAt') DESC, terminal_id);
`;

function checked(record: unknown): ProjectTerminal {
  if (!Check(ProjectTerminalSchema, record)) throw new Error('终端元数据无效；禁止保存正文、PID 或连接水位。');
  if (terminalIsActive(record.status) && record.closedAt !== null) throw new Error('未证实停止的终端不能标记已关闭。');
  if (record.status === 'exited' || record.status === 'failed') {
    if (!record.lastExit || record.lastExit.instanceId !== record.instanceId) throw new Error('终端结束信息必须属于当前实例。');
  }
  return record;
}
function fromRow(row: unknown): ProjectTerminal | undefined {
  return row ? checked(JSON.parse((row as { record_json: string }).record_json)) : undefined;
}

export class SqliteTerminalRepository implements TerminalRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(terminalId: string): ProjectTerminal | undefined {
    return fromRow(this.database.prepare('SELECT record_json FROM project_terminal WHERE terminal_id = ?').get(terminalId));
  }

  list(projectId: string, includeClosed = false): ProjectTerminal[] {
    return this.database.prepare(`SELECT record_json FROM project_terminal
      WHERE project_id = ? AND (? = 1 OR json_extract(record_json, '$.closedAt') IS NULL)
      ORDER BY json_extract(record_json, '$.lastActivityAt') DESC, terminal_id
    `).all(projectId, includeClosed ? 1 : 0).map(row => fromRow(row)!);
  }

  insert(record: ProjectTerminal): void {
    checked(record);
    if (record.status !== 'starting' || record.closedAt !== null) throw new Error('新终端必须处于启动中。');
    this.database.prepare('INSERT INTO project_terminal (terminal_id, project_id, record_json) VALUES (?, ?, ?)')
      .run(record.terminalId, record.projectId, JSON.stringify(record));
  }

  replace(record: ProjectTerminal, expectedInstanceId: string): boolean {
    checked(record);
    return runInTransaction(this.database, () => {
      const previous = this.get(record.terminalId);
      if (!previous || previous.instanceId !== expectedInstanceId) return false;
      if (record.projectId !== previous.projectId || record.createdAt !== previous.createdAt ||
          record.directory !== previous.directory || JSON.stringify(record.preset) !== JSON.stringify(previous.preset)) {
        throw new Error('终端归属、原目录与原命令不能修改。');
      }
      if (record.instanceId !== previous.instanceId) {
        if (terminalIsActive(previous.status) || record.status !== 'starting' || record.closedAt !== null) throw new Error('重开必须在旧实例已结束后创建新实例。');
      } else {
        assertTerminalTransition(previous.status, record.status);
      }
      this.database.prepare('UPDATE project_terminal SET record_json = ? WHERE terminal_id = ?').run(JSON.stringify(record), record.terminalId);
      return true;
    });
  }

  endInterrupted(at: string): number {
    return runInTransaction(this.database, () => {
      const records = this.database.prepare('SELECT record_json FROM project_terminal').all().map(row => fromRow(row)!);
      let ended = 0;
      for (const record of records) {
        if (!terminalIsActive(record.status)) continue;
        const next: ProjectTerminal = { ...record, status: 'exited', lastActivityAt: at, unread: false, notificationCount: 0,
          lastExit: { instanceId: record.instanceId, code: null, signal: null, reason: 'multivac-restarted', occurredAt: at } };
        this.database.prepare('UPDATE project_terminal SET record_json = ? WHERE terminal_id = ?').run(JSON.stringify(next), record.terminalId);
        ended++;
      }
      return ended;
    });
  }
}
