import type { DatabaseSync } from 'node:sqlite';
import type { ProjectResourceSource } from '@multivac/contracts';
import type { ProjectResourceRecord, ProjectResourceRepository } from '../modules/projects/project-resource.js';

/** 项目资料：随项目删除级联清理；同一项目中同一路径只登记一次。 */
export const PROJECT_RESOURCE_MIGRATION = `
  CREATE TABLE IF NOT EXISTS project_resource (
    resource_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('managed', 'directory')),
    path TEXT NOT NULL,
    title TEXT,
    summary TEXT NOT NULL,
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, path),
    FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
  ) STRICT;
`;

interface ProjectResourceRow {
  resource_id: string;
  project_id: string;
  source: ProjectResourceSource;
  path: string;
  title: string | null;
  summary: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function fromRow(row: ProjectResourceRow): ProjectResourceRecord {
  return {
    resourceId: row.resource_id,
    projectId: row.project_id,
    source: row.source,
    path: row.path,
    title: row.title,
    summary: row.summary,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteProjectResourceRepository implements ProjectResourceRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(projectId: string): ProjectResourceRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM project_resource WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC, resource_id
    `).all(projectId) as unknown as ProjectResourceRow[];
    return rows.map(fromRow);
  }

  get(projectId: string, resourceId: string): ProjectResourceRecord | undefined {
    const row = this.database.prepare('SELECT * FROM project_resource WHERE project_id = ? AND resource_id = ?')
      .get(projectId, resourceId) as unknown as ProjectResourceRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  findByPath(projectId: string, path: string): ProjectResourceRecord | undefined {
    const row = this.database.prepare('SELECT * FROM project_resource WHERE project_id = ? AND path = ?')
      .get(projectId, path) as unknown as ProjectResourceRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  count(projectId: string): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM project_resource WHERE project_id = ?').get(projectId) as { count: number };
    return row.count;
  }

  insert(record: ProjectResourceRecord): void {
    this.database.prepare(`
      INSERT INTO project_resource (resource_id, project_id, source, path, title, summary, pinned, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.resourceId, record.projectId, record.source, record.path, record.title, record.summary,
      record.pinned ? 1 : 0, record.createdAt, record.updatedAt);
  }

  update(
    projectId: string,
    resourceId: string,
    change: Partial<Pick<ProjectResourceRecord, 'title' | 'summary' | 'pinned'>> & { updatedAt: string },
  ): ProjectResourceRecord | undefined {
    const current = this.get(projectId, resourceId);
    if (!current) return undefined;
    const next = { ...current, ...change };
    this.database.prepare(`
      UPDATE project_resource SET title = ?, summary = ?, pinned = ?, updated_at = ? WHERE project_id = ? AND resource_id = ?
    `).run(next.title, next.summary, next.pinned ? 1 : 0, next.updatedAt, projectId, resourceId);
    return next;
  }

  remove(projectId: string, resourceId: string): boolean {
    return this.database.prepare('DELETE FROM project_resource WHERE project_id = ? AND resource_id = ?')
      .run(projectId, resourceId).changes > 0;
  }
}
