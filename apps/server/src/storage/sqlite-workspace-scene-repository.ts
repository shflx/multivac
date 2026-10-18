import type { DatabaseSync } from 'node:sqlite';
import type { StoredWorkspaceScene, WorkspaceSceneRepository } from '../modules/sessions/session-registry.js';
import type { WorkspaceSceneState } from '@multivac/contracts';

/**
 * 工作区现场的 SQLite 实现：现场内容与递增版本。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteWorkspaceSceneRepository implements WorkspaceSceneRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => string) {}

  /** 存储的现场与版本；内容无法解析时现场为 undefined（由应用层回退为默认现场），版本照常返回。 */
  get(workspaceId: string): StoredWorkspaceScene | undefined {
    const row = this.database.prepare('SELECT scene_json, revision FROM workspace_scene WHERE workspace_id = ?')
      .get(workspaceId) as { scene_json: string; revision: number } | undefined;
    if (!row) return undefined;
    let scene: unknown;
    try {
      scene = JSON.parse(row.scene_json) as unknown;
    } catch {
      scene = undefined;
    }
    return { scene, revision: row.revision };
  }

  /** 保存现场并把版本加一，返回新版本；第一次保存的版本为 1。 */
  save(workspaceId: string, scene: WorkspaceSceneState): number {
    const row = this.database.prepare(`
      INSERT INTO workspace_scene (workspace_id, scene_json, updated_at, revision) VALUES (?, ?, ?, 1)
      ON CONFLICT (workspace_id) DO UPDATE SET
        scene_json = excluded.scene_json, updated_at = excluded.updated_at, revision = workspace_scene.revision + 1
      RETURNING revision
    `).get(workspaceId, JSON.stringify(scene), this.now()) as { revision: number };
    return row.revision;
  }
}
