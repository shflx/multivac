import { createContext, useContext } from 'react';
import type { CurrentFileReading, CurrentViewScene, CurrentViewSnapshot, ManagementPageIdValue } from '@multivac/contracts';

/**
 * 本窗口的当前视图：向全局 Multivac 发送消息时一并带上（契约 CurrentViewSnapshot），
 * Multivac 的 get_current_view 据此理解“这个 / 第二栏那个 / 当前工作区”。
 *
 * 当前面板、当前工作区与各栏位只在本窗口，服务端不另行保存，所以在发送的那一刻由外壳读取一次。
 * 快照只含面板、布局、对象 id 和可选文件阅读位置：名称由服务端按 id 读取，快照不改变任何权限。
 */

/** 工作区视图报告给外壳的当前工作区与界面呈现的现场；现场还没读完时 scene 为 null。 */
export interface WorkspaceViewReport {
  workspaceId: string;
  scene: CurrentViewScene | null;
  taskSession?: NonNullable<NonNullable<CurrentViewSnapshot['workspace']>['taskSession']>;
  reading?: CurrentFileReading | null;
}

export interface CurrentViewInput {
  panel: CurrentViewSnapshot['panel'];
  narrow: boolean;
  /** 工作区视图最近一次的报告；工作区还没在本窗口打开过时为 null。 */
  workspace: WorkspaceViewReport | null;
  /** 工作区还没打开过时，再进入工作区会回到的工作区（记在本机的当前工作区）。 */
  rememberedWorkspaceId: string;
  managementPage: ManagementPageIdValue;
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  selectedTaskId?: string | null;
}

/** 由外壳的状态组成发送时的视图快照。 */
export function currentViewSnapshot(input: CurrentViewInput): CurrentViewSnapshot {
  const selection = input.managementPage === 'archive' && input.selectedSessionId
    ? { kind: 'session' as const, sessionId: input.selectedSessionId }
    : input.managementPage === 'projects' && input.selectedProjectId
      ? { kind: 'project' as const, projectId: input.selectedProjectId }
      : input.managementPage === 'tasks' && input.selectedTaskId ? { kind: 'task' as const, taskId: input.selectedTaskId } : null;
  return {
    panel: input.panel,
    narrow: input.narrow,
    workspace: input.workspace ?? { workspaceId: input.rememberedWorkspaceId, scene: null },
    management: input.panel === 'management' ? { page: input.managementPage, selection } : null,
  };
}

/** 读取本窗口当前视图的函数；只由全局 Multivac 的发送使用。外壳之外（没有提供时）为 null。 */
export const CurrentViewContext = createContext<(() => CurrentViewSnapshot | null) | null>(null);

export function useCurrentView(): (() => CurrentViewSnapshot | null) | null {
  return useContext(CurrentViewContext);
}
