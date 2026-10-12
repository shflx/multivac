import type { DatabaseSync } from 'node:sqlite';
import { AgentSchema, COORDINATOR_AGENT_ID, DEFAULT_AGENT_ID, type Agent } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { agentNameKey, type AgentCommandRecord, type AgentRepository } from '../modules/agents/agent.js';

export const AGENT_MIGRATION = `
  CREATE TABLE IF NOT EXISTS agent (
    agent_id TEXT PRIMARY KEY,
    name_key TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_command (
    command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
  ) STRICT;
`;

function agentFromRow(row: unknown): Agent {
  const agent: unknown = JSON.parse((row as { record_json: string }).record_json);
  if (!Check(AgentSchema, agent)) throw new Error('智能体存储记录不符合契约，需要核对迁移或数据。');
  return agent;
}

export class SqliteAgentRepository implements AgentRepository {
  constructor(private readonly database: DatabaseSync) {}

  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(agentId: string): Agent | null {
    const row = this.database.prepare('SELECT record_json FROM agent WHERE agent_id = ?').get(agentId);
    return row ? agentFromRow(row) : null;
  }

  list(): Agent[] {
    return this.database.prepare(`SELECT record_json FROM agent
      ORDER BY CASE agent_id WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, created_at, agent_id`)
      .all(COORDINATOR_AGENT_ID, DEFAULT_AGENT_ID).map(agentFromRow);
  }

  byNameKey(nameKey: string): Agent | null {
    const row = this.database.prepare('SELECT record_json FROM agent WHERE name_key = ?').get(nameKey);
    return row ? agentFromRow(row) : null;
  }

  save(agent: Agent, previousRevision: number | null): void {
    const values = [agentNameKey(agent.name), agent.revision, agent.createdAt, JSON.stringify(agent)];
    if (previousRevision === null) {
      this.database.prepare('INSERT INTO agent(name_key, revision, created_at, record_json, agent_id) VALUES (?, ?, ?, ?, ?)').run(...values, agent.agentId);
      return;
    }
    const result = this.database.prepare('UPDATE agent SET name_key=?, revision=?, created_at=?, record_json=? WHERE agent_id=? AND revision=?')
      .run(...values, agent.agentId, previousRevision);
    if (result.changes !== 1) throw new Error('智能体写入版本已变化。');
  }

  delete(agentId: string, revision: number): void {
    const result = this.database.prepare('DELETE FROM agent WHERE agent_id = ? AND revision = ?').run(agentId, revision);
    if (result.changes !== 1) throw new Error('智能体删除版本已变化。');
  }

  command(commandId: string): AgentCommandRecord | null {
    const row = this.database.prepare('SELECT fingerprint, result_json FROM agent_command WHERE command_id = ?').get(commandId) as { fingerprint: string; result_json: string } | undefined;
    return row ? { commandId, fingerprint: row.fingerprint, result: JSON.parse(row.result_json) as Agent } : null;
  }

  saveCommand(command: AgentCommandRecord): void {
    this.database.prepare('INSERT INTO agent_command VALUES (?, ?, ?)').run(command.commandId, command.fingerprint, JSON.stringify(command.result));
  }

  seed(presets: readonly Agent[]): void {
    this.transaction(() => {
      for (const preset of presets) {
        if (this.get(preset.agentId)) continue;
        // 用户自建的同名记录占用名称时，预置记录让出名称，仍保证预置身份存在。
        const agent = this.byNameKey(agentNameKey(preset.name)) ? { ...preset, name: `${preset.name}（预置）` } : preset;
        this.save(agent, null);
      }
    });
  }
}
