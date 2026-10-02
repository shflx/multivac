import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { ArtifactVersionSchema, type ArtifactVersion } from '@multivac/contracts';
import type { ArtifactRepository } from '../modules/tasks/artifact.js';
export const ARTIFACT_MIGRATION = `
  CREATE TABLE IF NOT EXISTS task_artifact_version (version_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(task_id), record_json TEXT NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS task_artifact_task ON task_artifact_version(task_id);
`;
function fromRow(row: unknown): ArtifactVersion {
  const value: unknown = JSON.parse((row as { record_json: string }).record_json);
  if (!Check(ArtifactVersionSchema, value)) throw new Error('成果版本记录不符合契约。');
  return value;
}
export class SqliteArtifactRepository implements ArtifactRepository {
  constructor(private readonly database: DatabaseSync) {}
  get(id: string): ArtifactVersion | null { const row = this.database.prepare('SELECT record_json FROM task_artifact_version WHERE version_id=?').get(id); return row ? fromRow(row) : null; }
  list(taskId: string): ArtifactVersion[] { return this.database.prepare('SELECT record_json FROM task_artifact_version WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(taskId).map(fromRow); }
  save(version: ArtifactVersion): void {
    if (!Check(ArtifactVersionSchema, version)) throw new Error('成果写入不符合契约。');
    this.database.prepare('INSERT INTO task_artifact_version VALUES (?,?,?) ON CONFLICT(version_id) DO UPDATE SET record_json=excluded.record_json').run(version.versionId, version.taskId, JSON.stringify(version));
  }
}
