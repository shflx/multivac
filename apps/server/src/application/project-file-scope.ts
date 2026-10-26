import { GLOBAL_ASSISTANT_SESSION_ID, type WorkingDirectory } from '@multivac/contracts';
import type { ProjectRepository, WorkspaceRepository } from '../modules/projects/project.js';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';

/** 只从服务端当前记录读取普通工作会话的项目范围，不缓存归属或目录。 */
export function projectFileScope(dependencies: {
  sessions: SessionRegistryRepository;
  workspaces: WorkspaceRepository;
  projects: ProjectRepository;
  isTaskSession: (sessionId: string) => boolean;
}): (sessionId: string, runtimeDirectory: WorkingDirectory) => readonly string[] {
  return (sessionId, runtimeDirectory) => {
    if (sessionId === GLOBAL_ASSISTANT_SESSION_ID ||
      ['task-isolated', 'worktree'].includes(runtimeDirectory.kind) ||
      dependencies.isTaskSession(sessionId)) return [];

    const session = dependencies.sessions.get(sessionId);
    if (!session || session.kind !== 'work' || session.host || session.archivedAt ||
      !session.workingDirectory || ['task-isolated', 'worktree'].includes(session.workingDirectory.kind)) return [];
    const projectId = dependencies.workspaces.get(session.workspaceId)?.project?.projectId;
    return projectId ? dependencies.projects.get(projectId)?.directories.map(directory => directory.path) ?? [] : [];
  };
}
