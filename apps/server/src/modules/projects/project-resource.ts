import type { ProjectResourceSource } from '@multivac/contracts';

/** 资料的持久化记录：文件状态（是否存在、大小、修改时间）读取时现查，不入库。 */
export interface ProjectResourceRecord {
  resourceId: string;
  projectId: string;
  source: ProjectResourceSource;
  /** 文件的绝对路径。 */
  path: string;
  title: string | null;
  summary: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectResourceRepository {
  /** 常驻在前，其余按更新时间倒序。 */
  list(projectId: string): ProjectResourceRecord[];
  get(projectId: string, resourceId: string): ProjectResourceRecord | undefined;
  /** 同一项目中同一路径只登记一次。 */
  findByPath(projectId: string, path: string): ProjectResourceRecord | undefined;
  count(projectId: string): number;
  insert(record: ProjectResourceRecord): void;
  update(projectId: string, resourceId: string, change: Partial<Pick<ProjectResourceRecord, 'title' | 'summary' | 'pinned'>> & { updatedAt: string }): ProjectResourceRecord | undefined;
  remove(projectId: string, resourceId: string): boolean;
}
