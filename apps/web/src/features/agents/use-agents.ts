import { useEffect, useReducer } from 'react';
import { DEFAULT_AGENT_ID, type AgentList } from '@multivac/contracts';
import { listAgents } from '../../data/agent-api.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

// 智能体列表在窗口内共享一份：多处只显示名称，避免每个任务卡片和会话各自请求。
let snapshot: AgentList | null = null;
let loading = false;
let reloadAfter = false;
const listeners = new Set<() => void>();

/** 立即重读智能体列表：本窗口修改后调用，不必等工作台事件回到本窗口。 */
export function reloadAgents(): void { load(); }

function load() {
  if (loading) { reloadAfter = true; return; }
  loading = true;
  void listAgents().then((next) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }).catch(() => undefined).finally(() => {
    loading = false;
    if (reloadAfter) { reloadAfter = false; load(); }
  });
}

/** 当前智能体列表；尚未读到时为 null。在工作台中随智能体变更与事件流重连刷新。 */
export function useAgents(): AgentList | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    if (!snapshot) load();
    return () => { listeners.delete(rerender); };
  }, []);
  useOptionalWorkbenchEvents((event) => { if (event.type === 'workbench.connected' || event.type === 'agent.changed') load(); });
  return snapshot;
}

/** 任务所用智能体的显示名：旧任务缺省为通用执行；列表未读到时先按缺省显示。 */
export function agentName(agents: AgentList | null, agentId: string | undefined): string {
  const id = agentId ?? DEFAULT_AGENT_ID;
  const agent = agents?.agents.find((item) => item.agentId === id);
  if (agent) return agent.name;
  return id === DEFAULT_AGENT_ID ? '通用执行' : agents ? '已删除的智能体' : '读取中…';
}
