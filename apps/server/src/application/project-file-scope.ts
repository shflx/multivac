import { GLOBAL_ASSISTANT_SESSION_ID, type WorkingDirectory } from '@multivac/contracts';
import type { ProjectRepository, WorkspaceRepository } from '../modules/projects/project.js';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';

/** 两类工作会话均逐次读取当前项目范围；任务 Run 身份另由执行租约核对。 */
export function projectFileScope(dependencies: {
  sessions: SessionRegistryRepository;
  workspaces: WorkspaceRepository;
  projects: ProjectRepository;
}): (sessionId: string, runtimeDirectory: WorkingDirectory) => readonly string[] {
  return (sessionId, _runtimeDirectory) => {
    if (sessionId === GLOBAL_ASSISTANT_SESSION_ID) return [];

    const session = dependencies.sessions.get(sessionId);
    if (!session || session.kind !== 'work' || session.host || session.archivedAt ||
      !session.workingDirectory) return [];
    const projectId = dependencies.workspaces.get(session.workspaceId)?.project?.projectId;
    return projectId ? dependencies.projects.get(projectId)?.directories.map(directory => directory.path) ?? [] : [];
  };
}
