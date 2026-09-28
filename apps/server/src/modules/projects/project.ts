import type { Project, ProjectDirectory, Workspace } from '@multivac/contracts';

export interface NewProjectRecord {
  projectId: string;
  name: string;
  /** 至少一个；第一个是主目录。 */
  directories: readonly ProjectDirectory[];
  defaultConstraints: string;
  createdAt: string;
}

/**
 * 项目的持久化：项目、项目目录与同名工作区。
 *
 * 项目工作区与项目同 id，名称始终取项目名称（改名只改项目一处）；默认工作区不属于任何项目。
 */
export interface ProjectRepository {
  /** 按创建时间升序。 */
  list(): Project[];
  get(projectId: string): Project | undefined;
  /** 在同一事务中写入项目、目录与同名工作区。 */
  create(record: NewProjectRecord): { project: Project; workspace: Workspace };
  /** 是否已有项目使用该路径作为目录（不区分 ASCII 大小写），供托管目录查重。 */
  isDirectoryRecorded(path: string): boolean;
  /** 删除全部项目与项目工作区（含其现场），仅供 Fake E2E 在用例之间恢复初始状态。 */
  deleteAllForTest(): void;
}

/** 工作区的读取：项目工作区带出所属项目与目录。 */
export interface WorkspaceRepository {
  /** 项目工作区按创建顺序在前，默认工作区在最后。 */
  list(): Workspace[];
  get(workspaceId: string): Workspace | undefined;
}
