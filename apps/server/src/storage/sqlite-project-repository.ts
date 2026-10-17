import type { DatabaseSync } from 'node:sqlite';
import type { Project, ProjectDirectory, Workspace } from '@multivac/contracts';
import type { NewProjectRecord, ProjectRepository, ProjectUpdateRecord } from '../modules/projects/project.js';
import { runInTransaction } from './sqlite-transaction.js';

interface ProjectRow {
  project_id: string;
  name: string;
  default_constraints: string;
  created_at: string;
  updated_at: string;
}

interface ProjectDirectoryRow {
  project_id: string;
  kind: ProjectDirectory['kind'];
  path: string;
}

/**
 * 项目、项目目录与同名工作区的 SQLite 实现；表结构与迁移由 SqliteAssistantStore 维护。
 * 写入后的工作区由调用方提供的读取函数取回，名称始终随项目名称。
 */
export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: DatabaseSync, private readonly readWorkspace: (workspaceId: string) => Workspace | undefined) {}

  list(): Project[] {
    const rows = this.database.prepare('SELECT * FROM project ORDER BY created_at, project_id')
      .all() as unknown as ProjectRow[];
    return this.fromRows(rows);
  }

  get(projectId: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM project WHERE project_id = ?')
      .get(projectId) as unknown as ProjectRow | undefined;
    return row ? this.fromRows([row])[0] : undefined;
  }

  /** 项目、目录与同名工作区在同一事务中写入。 */
  create(record: NewProjectRecord): { project: Project; workspace: Workspace } {
    if (record.directories.length === 0) throw new Error('项目至少需要一个目录。');
    runInTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO project (project_id, name, default_constraints, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `).run(record.projectId, record.name, record.defaultConstraints, record.createdAt, record.createdAt);
      this.insertDirectories(record.projectId, record.directories);
      this.database.prepare(`
        INSERT INTO workspace (workspace_id, name, project_id, created_at) VALUES (?, NULL, ?, ?)
      `).run(record.projectId, record.projectId, record.createdAt);
    });
    return this.withWorkspace(record.projectId, '项目写入后未能读取。');
  }

  /** 项目行与目录在同一事务中更新；目录给出时整体替换，顺序即 position（0 为主目录）。 */
  update(projectId: string, record: ProjectUpdateRecord): { project: Project; workspace: Workspace } | undefined {
    if (record.directories?.length === 0) throw new Error('项目至少需要一个目录。');
    const updated = runInTransaction(this.database, () => {
      const result = this.database.prepare(`
        UPDATE project SET name = COALESCE(?, name), default_constraints = COALESCE(?, default_constraints), updated_at = ?
        WHERE project_id = ?
      `).run(record.name ?? null, record.defaultConstraints ?? null, record.updatedAt, projectId);
      if (result.changes === 0) return false;
      if (record.directories) {
        this.database.prepare('DELETE FROM project_directory WHERE project_id = ?').run(projectId);
        this.insertDirectories(projectId, record.directories);
      }
      return true;
    });
    return updated ? this.withWorkspace(projectId, '项目更新后未能读取。') : undefined;
  }

  isDirectoryRecorded(path: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM project_directory WHERE path = ? COLLATE NOCASE LIMIT 1
    `).get(path) !== undefined;
  }

  /** 删除全部项目与项目工作区及其现场（仅供 E2E 重置）；默认工作区保留。 */
  deleteAllForTest(): void {
    runInTransaction(this.database, () => {
      this.database.exec(`
        DELETE FROM workspace_scene WHERE workspace_id IN (SELECT workspace_id FROM workspace WHERE project_id IS NOT NULL);
        DELETE FROM workspace WHERE project_id IS NOT NULL;
        DELETE FROM project;
      `);
    });
  }

  private insertDirectories(projectId: string, directories: readonly ProjectDirectory[]): void {
    const insert = this.database.prepare(`
      INSERT INTO project_directory (project_id, position, kind, path) VALUES (?, ?, ?, ?)
    `);
    directories.forEach((directory, position) => { insert.run(projectId, position, directory.kind, directory.path); });
  }

  private withWorkspace(projectId: string, missing: string): { project: Project; workspace: Workspace } {
    const workspace = this.readWorkspace(projectId);
    if (!workspace?.project) throw new Error(missing);
    return { project: workspace.project, workspace };
  }

  private fromRows(rows: readonly ProjectRow[]): Project[] {
    if (rows.length === 0) return [];
    const directories = this.database.prepare(`
      SELECT project_id, kind, path FROM project_directory
      WHERE project_id IN (${rows.map(() => '?').join(', ')})
      ORDER BY project_id, position
    `).all(...rows.map((row) => row.project_id)) as unknown as ProjectDirectoryRow[];
    return rows.map((row) => ({
      projectId: row.project_id,
      name: row.name,
      directories: directories
        .filter((directory) => directory.project_id === row.project_id)
        .map(({ kind, path }) => ({ kind, path })),
      defaultConstraints: row.default_constraints,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
