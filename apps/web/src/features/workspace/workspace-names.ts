import { DEFAULT_WORKSPACE_ID } from '@multivac/contracts';

/** 不属于任何项目的会话所在的工作区；首版只有它一个。 */
export const DEFAULT_WORKSPACE_NAME = '默认工作区';

/** 工作区的显示名称。多工作区之后项目工作区取项目名称，在这里补上。 */
export function workspaceName(workspaceId: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE_NAME : workspaceId;
}
