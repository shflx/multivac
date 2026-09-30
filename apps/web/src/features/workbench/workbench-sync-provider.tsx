import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkbenchEvent } from '@multivac/contracts';
import { windowId } from '../../data/window-id.js';
import { useAuthorizationGrantsStore } from '../authorizations/authorization-grants-provider.js';
import { useGlobalEvents } from '../events/global-events-provider.js';
import { useProposalsStore } from '../proposals/proposals-provider.js';
import { useWorkspaceStores } from '../workspace/workspace-sessions-provider.js';
import { applyWorkbenchEvent, resyncWorkbench, type WorkbenchStores } from './workbench-sync.js';

type WorkbenchListener = (event: WorkbenchEvent) => void;

/** 把收到的事件转给界面中的订阅者（工作区外壳与视图据此处理现场与重连）。 */
class WorkbenchChannel {
  private readonly listeners = new Set<WorkbenchListener>();

  subscribe(listener: WorkbenchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WorkbenchEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const WorkbenchContext = createContext<WorkbenchChannel | null>(null);

/**
 * 工作台变更同步：从本窗口的全局事件流取工作台变更，把别处（其他窗口、Multivac）的会话、项目、记住的授权与
 * 对话内提议的变化写回应用内共享的列表，连上与重连（含游标过期后重新起流）时重读一次；现场事件转给工作区外壳与视图，
 * 由它们按版本应用。共享列表只替换数据，已打开的面板、草稿、阅读位置与焦点不受影响。
 */
export function WorkbenchSyncProvider({ children }: { children: ReactNode }) {
  const { sessions, workspaces } = useWorkspaceStores();
  const grants = useAuthorizationGrantsStore();
  const proposals = useProposalsStore();
  const events = useGlobalEvents();
  const [channel] = useState(() => new WorkbenchChannel());

  useEffect(() => {
    const stores: WorkbenchStores = { sessions, workspaces, grants, proposals };
    return events.subscribeWorkbench((event) => {
      if (event.type === 'workbench.connected') resyncWorkbench(stores);
      else applyWorkbenchEvent(event, stores, windowId());
      channel.emit(event);
    });
  }, [channel, events, grants, proposals, sessions, workspaces]);

  return <WorkbenchContext.Provider value={channel}>{children}</WorkbenchContext.Provider>;
}

/** 订阅工作台事件（含连上与重连时的 `workbench.connected`）；回调总是取最新的一次渲染。 */
export function useWorkbenchEvents(listener: WorkbenchListener): void {
  const channel = useContext(WorkbenchContext);
  if (!channel) throw new Error('工作台事件必须在 WorkbenchSyncProvider 内使用。');
  const listenerRef = useRef(listener);
  listenerRef.current = listener;
  useEffect(() => channel.subscribe((event) => listenerRef.current(event)), [channel]);
}
