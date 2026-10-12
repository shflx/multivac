import { useEffect, useReducer } from 'react';
import { DEFAULT_AGENT_ID, type AgentList } from '@multivac/contracts';
import { listAgents } from '../../data/agent-api.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

// 智能体列表在窗口内共享一份：多处只显示名称，避免每个任务卡片和会话各自请求。
let snapshot: AgentList | null = null;
let loadError: string | null = null;
let inflight: Promise<void> | null = null;
let reloadAfter: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function load(): Promise<void> {
  // 读取期间又有变化时，等这次结束后再读一次，保证拿到变化之后的列表。
  if (inflight) return reloadAfter ??= inflight.then(() => { reloadAfter = null; return load(); });
  inflight = listAgents().then((next) => {
    snapshot = next;
    loadError = null;
  }).catch((error: unknown) => {
    loadError = error instanceof Error && error.message ? error.message : '智能体读取失败。';
  }).finally(() => {
    inflight = null;
    notify();
  });
  return inflight;
}

/** 重新读取共享的智能体列表（含按当前模型配置计算的模型状态）；读取完成后各处随之刷新。 */
export function reloadAgents(): Promise<void> {
  return load();
}

/** 当前智能体列表；尚未读到时为 null。在工作台中随智能体变更与事件流重连刷新。 */
export function useAgents(): AgentList | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    listeners.add(rerender);
    if (!snapshot) void load();
    return () => { listeners.delete(rerender); };
  }, []);
  useOptionalWorkbenchEvents((event) => { if (event.type === 'workbench.connected' || event.type === 'agent.changed') void load(); });
  return snapshot;
}

/** 最近一次读取失败的原因；读取成功后清除。只在需要说明读取失败的地方使用。 */
export function agentsLoadError(): string | null {
  return loadError;
}

/** 任务所用智能体的显示名：旧任务缺省为通用执行；列表未读到时先按缺省显示。 */
export function agentName(agents: AgentList | null, agentId: string | undefined): string {
  const id = agentId ?? DEFAULT_AGENT_ID;
  const agent = agents?.agents.find((item) => item.agentId === id);
  if (agent) return agent.name;
  return id === DEFAULT_AGENT_ID ? '通用执行' : agents ? '已删除的智能体' : '读取中…';
}
