import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantQuote, WorkspaceScene } from '@multivac/contracts';
import { windowId } from '../../data/window-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { isOwnDirectChange } from '../workbench/workbench-sync.js';
import { WorkspaceView } from './workspace-view.js';
import { rememberedWorkspaceId, rememberWorkspaceId } from './workspaces.js';

interface WorkspaceShellProps {
  /** 工作区是否正在显示。 */
  active: boolean;
  onManageModels: () => void;
  /** 工作区切换菜单的“项目设置”：打开设置 · 项目并选中当前项目（默认工作区为 null）。 */
  onManageProject: (projectId: string | null) => void;
  /** 从别处（管理 · 会话页）打开的会话及其所在的工作区；id 递增表示一次新的打开。 */
  openRequest?: WorkspaceOpenRequest | null;
  /** 当前焦点会话变化时报告给外壳：Multivac 侧栏据此提示“正在看”，并在发送时作为上下文。 */
  onFocusChange: (focus: { sessionId: string; title: string } | null) => void;
  /** 把会话中选中的内容交给 Multivac：外壳展开侧栏并把引用写入侧栏输入区。 */
  onHandToMultivac: (quote: AssistantQuote) => void;
}

export interface WorkspaceOpenRequest {
  id: number;
  sessionId: string;
  workspaceId: string;
}

/**
 * 工作区外壳：当前工作区的会话区。Multivac 侧栏由应用外壳统一提供（工作区与管理共用），
 * 这里只报告当前焦点会话并转交“交给 Multivac”。
 *
 * 当前工作区记在本机，下次进入时回到这里。切换工作区时整个会话区按新工作区重建：
 * 离开的工作区先保存现场，进入的工作区读回自己的现场（本页已打开过的直接用本页记下的最新现场）。
 * 侧栏与全局 Multivac 不随工作区变化。
 */
export function WorkspaceShell({
  active, onManageModels, onManageProject, openRequest = null, onFocusChange, onHandToMultivac,
}: WorkspaceShellProps) {
  const [workspaceId, setWorkspaceId] = useState(rememberedWorkspaceId);
  // 本页各工作区的最新现场（带服务端版本）：切回来时直接恢复，不必等离开时的保存与重新读取往返。
  const [sceneCache] = useState(() => new Map<string, WorkspaceScene>());
  // 尚未处理的打开请求：先切到会话所在的工作区，由该工作区读完现场后聚焦。
  const [pendingOpen, setPendingOpen] = useState<WorkspaceOpenRequest | null>(null);
  const handledOpenRef = useRef(0);
  // 工作区内发起的打开（如归入项目后到项目中打开）用负数 id，与外部打开请求的递增 id 互不冲突。
  const localOpenRef = useRef(0);

  // 不在显示的工作区也可能被别处改动：记下的现场随之更新（本窗口离开时自己保存的，只更新版本），
  // 切回来时看到的是最新现场；事件流重连后不再信任记下的现场，切回来时重新读取。当前工作区由视图自己处理。
  useWorkbenchEvents((event) => {
    if (event.type === 'workbench.connected') {
      for (const id of [...sceneCache.keys()]) if (id !== workspaceId) sceneCache.delete(id);
      return;
    }
    if (event.type !== 'scene.changed' || event.scene.workspaceId === workspaceId) return;
    const cached = sceneCache.get(event.scene.workspaceId);
    if (!cached || cached.revision >= event.scene.revision) return;
    sceneCache.set(event.scene.workspaceId, isOwnDirectChange(event.origin, windowId())
      ? { ...cached, revision: event.scene.revision }
      : event.scene);
  });

  /** 切换当前工作区并记在本机；会话区随之按新工作区重建。 */
  const switchWorkspace = useCallback((id: string) => {
    rememberWorkspaceId(id);
    setWorkspaceId(id);
  }, []);

  useEffect(() => {
    if (!openRequest || openRequest.id === handledOpenRef.current) return;
    handledOpenRef.current = openRequest.id;
    switchWorkspace(openRequest.workspaceId);
    setPendingOpen(openRequest);
  }, [openRequest]);

  /** 切到另一个工作区并聚焦其中的会话：与外部打开请求走同一条路径。 */
  const openSession = useCallback((targetWorkspaceId: string, sessionId: string) => {
    localOpenRef.current -= 1;
    switchWorkspace(targetWorkspaceId);
    setPendingOpen({ id: localOpenRef.current, sessionId, workspaceId: targetWorkspaceId });
  }, [switchWorkspace]);

  return (
    <div className="workspace-shell">
      <WorkspaceView
        key={workspaceId}
        workspaceId={workspaceId}
        onSwitchWorkspace={switchWorkspace}
        sceneCache={sceneCache}
        active={active}
        onManageModels={onManageModels}
        onManageProject={onManageProject}
        openRequest={pendingOpen?.workspaceId === workspaceId ? pendingOpen : null}
        onOpenHandled={() => setPendingOpen(null)}
        onFocusChange={onFocusChange}
        onHandToMultivac={onHandToMultivac}
        onOpenSession={openSession}
      />
    </div>
  );
}
