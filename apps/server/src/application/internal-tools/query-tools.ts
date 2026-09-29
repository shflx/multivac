import { Type } from 'typebox';
import type { Workspace } from '@multivac/contracts';
import { defineInternalTool } from './internal-tool-service.js';

const DIRECTORY_KINDS = { managed: '托管', mounted: '挂载' } as const;

function describeWorkspace(workspace: Workspace, sessionCount: number): string {
  const sessions = `${sessionCount} 个未归档会话`;
  if (!workspace.project) {
    return `- 「${workspace.name}」（id: ${workspace.workspaceId}）：不属于项目，其中的会话各自使用临时目录；${sessions}`;
  }
  const primary = workspace.project.directories[0]!;
  return `- 「${workspace.name}」（id: ${workspace.workspaceId}，项目工作区）：主目录（${DIRECTORY_KINDS[primary.kind]}）${primary.path}；${sessions}`;
}

/**
 * 列出全部工作区：项目工作区（与项目同名、同 id）在前，默认工作区在最后，与界面的工作区切换菜单一致。
 */
export const listWorkspacesTool = defineInternalTool({
  name: 'list_workspaces',
  effect: 'query',
  description: '列出 Multivac 中的全部工作区：项目工作区（与项目同名、同 id，写明主目录）与默认工作区（不属于项目），' +
    '以及各自未归档的会话数。用户问“有哪些工作区 / 项目”或需要工作区 id 时使用。只读，不改变任何东西。',
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute(_params, { services }) {
    const { workspaces } = services.projects.listWorkspaces();
    const counts = new Map<string, number>();
    for (const session of services.sessions.list({ workspaceId: null }).sessions) {
      counts.set(session.workspaceId, (counts.get(session.workspaceId) ?? 0) + 1);
    }
    return {
      content: [
        `共 ${workspaces.length} 个工作区：`,
        ...workspaces.map((workspace) => describeWorkspace(workspace, counts.get(workspace.workspaceId) ?? 0)),
      ].join('\n'),
      result: {
        summary: `共 ${workspaces.length} 个工作区`,
        refs: workspaces.map((workspace) => ({
          kind: 'workspace' as const, workspaceId: workspace.workspaceId, label: workspace.name,
        })),
      },
    };
  },
});
