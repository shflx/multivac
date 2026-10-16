import { useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_AGENT_ID, type AgentList } from '@multivac/contracts';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { AgentsStore } from './agents-store.js';

const agentsStore = new AgentsStore();

/** 立即重读智能体列表：本窗口修改后调用，不必等工作台事件回到本窗口。 */
export function reloadAgents(): void { void agentsStore.refresh(); }

/** 设置页、任务卡片与工作会话共用列表、错误和加载状态。 */
export function useAgentList() {
  const state = useSyncExternalStore(agentsStore.subscribe, agentsStore.snapshot);
  useEffect(() => { if (!agentsStore.snapshot().data) void agentsStore.load(); }, []);
  useOptionalWorkbenchEvents(agentsStore.applyEvent);
  return { ...state, load: agentsStore.load };
}

/** 当前智能体列表；尚未读到时为 null。在工作台中随智能体变更与事件流重连刷新。 */
export function useAgents(): AgentList | null {
  return useAgentList().data;
}

/** 任务所用智能体的显示名：旧任务缺省为通用执行；列表未读到时先按缺省显示。 */
export function agentName(agents: AgentList | null, agentId: string | undefined): string {
  const id = agentId ?? DEFAULT_AGENT_ID;
  const agent = agents?.agents.find((item) => item.agentId === id);
  if (agent) return agent.name;
  return id === DEFAULT_AGENT_ID ? '通用执行' : agents ? '已删除的智能体' : '读取中…';
}
