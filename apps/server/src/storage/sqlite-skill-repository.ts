import type { DatabaseSync } from 'node:sqlite';
import type { SkillRecord, SkillManifest, SkillPreview, SkillUse } from '@multivac/contracts';
import { SkillError } from '../modules/skills/skill-package.js';
import type { SkillRepository } from '../modules/skills/skill-repository.js';
import { runInTransaction } from './sqlite-transaction.js';

export const SKILL_MIGRATION = `
CREATE TABLE IF NOT EXISTS skill (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS skill_version (skill_id TEXT NOT NULL REFERENCES skill(id), version TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(skill_id, version)) STRICT;
CREATE TABLE IF NOT EXISTS skill_effect (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT) STRICT;
CREATE TABLE IF NOT EXISTS skill_use (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS skill_preference (scope TEXT NOT NULL, skill_id TEXT NOT NULL, revision INTEGER NOT NULL, hidden INTEGER NOT NULL, PRIMARY KEY(scope,skill_id)) STRICT;
CREATE TABLE IF NOT EXISTS skill_preference_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS skill_preview (id TEXT PRIMARY KEY, preview_json TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS skill_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;
export class SqliteSkillRepository implements SkillRepository {
  constructor(private readonly db: DatabaseSync) {}
  beginEffect(id: string, fingerprint: string): string | null {
    const row = this.db.prepare('SELECT fingerprint,result_json FROM skill_effect WHERE id=?').get(id);
    if (row) {
      if (row.fingerprint !== fingerprint) throw new SkillError('Skill 副作用调用参数冲突。', 409);
      if (row.result_json === null)
        throw new SkillError('此前执行结果未知；请核对工作目录，不能自动重放。', 409);
      return String(row.result_json);
    }
    this.db.prepare('INSERT INTO skill_effect VALUES (?,?,NULL)').run(id, fingerprint);
    return null;
  }
  endEffect(id: string, result: string): void {
    this.db.prepare('UPDATE skill_effect SET result_json=? WHERE id=?').run(result, id);
  }
  recordUse(use: SkillUse): boolean {
    const old = this.db.prepare('SELECT record_json FROM skill_use WHERE id=?').get(use.useId);
    if (old) {
      const previous: SkillUse = JSON.parse(String(old.record_json));
      if (previous.skillId !== use.skillId || previous.version !== use.version || previous.path !== use.path)
        throw new SkillError('Skill 调用身份冲突。', 409);
      return false;
    }
    this.db.prepare('INSERT INTO skill_use VALUES (?,?)').run(use.useId, JSON.stringify(use));
    return true;
  }
  uses(skillId: string): SkillUse[] {
    return this.db
      .prepare(
        "SELECT record_json FROM skill_use WHERE json_extract(record_json,'$.skillId')=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(skillId)
      .map((r) => JSON.parse(String(r.record_json)));
  }
  preference(scope: string, id: string): { revision: number; hidden: boolean } {
    const row = this.db
      .prepare('SELECT revision,hidden FROM skill_preference WHERE scope=? AND skill_id=?')
      .get(scope, id);
    return row ? { revision: Number(row.revision), hidden: !!row.hidden } : { revision: 0, hidden: false };
  }
  setPreference(scope: string, id: string, revision: number, hidden: boolean, commandId: string) {
    const fingerprint = JSON.stringify([scope, id, revision, hidden]);
    return runInTransaction(this.db, () => {
      const receipt = this.db
        .prepare('SELECT fingerprint,result_json FROM skill_preference_command WHERE id=?')
        .get(commandId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new SkillError('偏好命令冲突。', 409);
        return { ...JSON.parse(String(receipt.result_json)), changed: false };
      }
      if (this.preference(scope, id).revision !== revision) throw new SkillError('偏好已变化，请刷新。', 409);
      this.get(id);
      const result = { revision: revision + 1, hidden };
      this.db
        .prepare(
          'INSERT INTO skill_preference VALUES (?,?,?,?) ON CONFLICT(scope,skill_id) DO UPDATE SET revision=excluded.revision,hidden=excluded.hidden',
        )
        .run(scope, id, result.revision, Number(hidden));
      this.db
        .prepare('INSERT INTO skill_preference_command VALUES (?,?,?)')
        .run(commandId, fingerprint, JSON.stringify(result));
      return { ...result, changed: true };
    });
  }
  savePreview(preview: SkillPreview): void {
    this.db.prepare('INSERT INTO skill_preview VALUES (?,?)').run(preview.previewId, JSON.stringify(preview));
  }
  preview(id: string): SkillPreview {
    const row = this.db.prepare('SELECT preview_json FROM skill_preview WHERE id=?').get(id);
    if (!row) throw new SkillError('导入预览不存在。', 404);
    return JSON.parse(String(row.preview_json));
  }
  list(): SkillRecord[] {
    return this.db
      .prepare('SELECT record_json FROM skill ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(String(row.record_json)));
  }
  get(id: string): SkillRecord {
    const row = this.db.prepare('SELECT record_json FROM skill WHERE id=?').get(id);
    if (!row) throw new SkillError('Skill 不存在。', 404);
    return JSON.parse(String(row.record_json));
  }
  version(id: string, version: string): SkillManifest {
    const row = this.db
      .prepare('SELECT manifest_json FROM skill_version WHERE skill_id=? AND version=?')
      .get(id, version);
    if (!row) throw new SkillError('Skill 版本不存在。', 404);
    return JSON.parse(String(row.manifest_json));
  }
  receipt(id: string, fingerprint: string): SkillRecord | null {
    const row = this.db.prepare('SELECT fingerprint, result_json FROM skill_command WHERE id=?').get(id);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new SkillError('同命令 ID 参数不一致。', 409);
    return JSON.parse(String(row.result_json));
  }
  commit(
    commandId: string,
    fingerprint: string,
    decide: () => SkillRecord,
    manifest?: SkillManifest,
  ): { record: SkillRecord; changed: boolean } {
    return runInTransaction(this.db, () => {
      const old = this.receipt(commandId, fingerprint);
      if (old) {
        return { record: old, changed: false };
      }
      const record = decide();
      const previous = this.list().find((item) => item.skillId === record.skillId);
      const changed = !previous || JSON.stringify(previous) !== JSON.stringify(record);
      this.db
        .prepare(
          'INSERT INTO skill VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json',
        )
        .run(record.skillId, JSON.stringify(record));
      if (manifest)
        this.db
          .prepare('INSERT OR IGNORE INTO skill_version VALUES (?,?,?)')
          .run(record.skillId, manifest.version, JSON.stringify(manifest));
      this.db
        .prepare('INSERT INTO skill_command VALUES (?,?,?)')
        .run(commandId, fingerprint, JSON.stringify(record));
      return { record, changed };
    });
  }
}
