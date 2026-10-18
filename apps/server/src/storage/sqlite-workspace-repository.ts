import type { DatabaseSync } from 'node:sqlite';
import type { Project, Workspace } from '@multivac/contracts';
import type { WorkspaceRepository } from '../modules/projects/project.js';

interface WorkspaceRow {
  workspace_id: string;
  name: string;
  project_id: string | null;
}

/** 项目工作区的名称取项目名称，项目改名只改一处。 */
const WORKSPACE_SELECT = `
  SELECT w.workspace_id, COALESCE(p.name, w.name) AS name, w.project_id
  FROM workspace w
  LEFT JOIN project p ON p.project_id = w.project_id
`;

/**
 * 工作区的 SQLite 读取：默认工作区与项目同名工作区，项目信息由项目仓储补全。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: DatabaseSync, private readonly project: (projectId: string) => Project | undefined) {}

  /** 项目工作区按创建顺序在前，默认工作区在最后。 */
  list(): Workspace[] {
    const rows = this.database.prepare(`${WORKSPACE_SELECT}
      ORDER BY w.project_id IS NULL, w.created_at, w.workspace_id
    `).all() as unknown as WorkspaceRow[];
    return this.workspacesFromRows(rows);
  }

  get(workspaceId: string): Workspace | undefined {
    const row = this.database.prepare(`${WORKSPACE_SELECT} WHERE w.workspace_id = ?`)
      .get(workspaceId) as unknown as WorkspaceRow | undefined;
    return row ? this.workspacesFromRows([row])[0] : undefined;
  }

  private workspacesFromRows(rows: readonly WorkspaceRow[]): Workspace[] {
    const projectIds = rows.flatMap((row) => row.project_id ? [row.project_id] : []);
    const projects = new Map(projectIds.map((projectId) => [projectId, this.project(projectId)]));
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      project: row.project_id ? projects.get(row.project_id) ?? null : null,
    }));
  }
}
