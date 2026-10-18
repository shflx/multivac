import type { DatabaseSync } from 'node:sqlite';
import type { PreferenceRepository } from '../application/preferences-service.js';

/**
 * 应用偏好的 SQLite 实现：按键保存 JSON 值，内容损坏时读作缺失。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqlitePreferenceRepository implements PreferenceRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => string) {}

  /** 读取偏好；缺失或内容损坏时为 undefined，由应用层回退为默认值。 */
  get(key: string): unknown {
    const row = this.database.prepare('SELECT value_json FROM app_preference WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.database.prepare(`
      INSERT INTO app_preference (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), this.now());
  }

  clearForTest(): void {
    this.database.exec('DELETE FROM app_preference');
  }
}
