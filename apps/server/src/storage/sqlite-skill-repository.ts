import type { DatabaseSync } from 'node:sqlite';
import type { SkillRecord, SkillManifest } from '@multivac/contracts';
import { SkillError } from '../modules/skills/skill-package.js';

export const SKILL_MIGRATION = `
CREATE TABLE IF NOT EXISTS skill (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS skill_version (skill_id TEXT NOT NULL REFERENCES skill(id), version TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(skill_id, version)) STRICT;
CREATE TABLE IF NOT EXISTS skill_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;
export class SqliteSkillRepository {
  constructor(private readonly db: DatabaseSync) {}
  list(): SkillRecord[] { return this.db.prepare('SELECT record_json FROM skill ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.record_json))); }
  get(id: string): SkillRecord {
    const row = this.db.prepare('SELECT record_json FROM skill WHERE id=?').get(id);
    if (!row) throw new SkillError('Skill 不存在。', 404);
    return JSON.parse(String(row.record_json));
  }
  version(id: string, version: string): SkillManifest {
    const row = this.db.prepare('SELECT manifest_json FROM skill_version WHERE skill_id=? AND version=?').get(id, version);
    if (!row) throw new SkillError('Skill 版本不存在。', 404);
    return JSON.parse(String(row.manifest_json));
  }
  receipt(id: string, fingerprint: string): SkillRecord | null {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM skill_command WHERE id=?').get(id);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new SkillError('同命令 ID 参数不一致。', 409);
    return JSON.parse(String(row.result_json));
  }
  commit(commandId: string, fingerprint: string, decide: () => SkillRecord, manifest?: SkillManifest): { record: SkillRecord; changed: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.receipt(commandId, fingerprint);
      if (old) { this.db.exec('COMMIT'); return { record: old, changed: false }; }
      const record = decide();
      const previous = this.list().find(item => item.skillId === record.skillId);
      const changed = !previous || JSON.stringify(previous) !== JSON.stringify(record);
      this.db.prepare('INSERT INTO skill VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.skillId, JSON.stringify(record));
      if (manifest) this.db.prepare('INSERT OR IGNORE INTO skill_version VALUES (?,?,?)').run(record.skillId, manifest.version, JSON.stringify(manifest));
      this.db.prepare('INSERT INTO skill_command VALUES (?,?,?)').run(commandId, fingerprint, JSON.stringify(record));
      this.db.exec('COMMIT'); return { record, changed };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
