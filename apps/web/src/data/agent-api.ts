import {
  AgentListSchema, AgentReceiptSchema, TaskListSchema,
  type AgentList, type AgentReceipt, type CreateAgent, type DeleteAgent, type TaskList, type UpdateAgent,
} from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export const listAgents = (): Promise<AgentList> => fetchJson('/api/agents', undefined, AgentListSchema);

export const createAgent = (input: CreateAgent): Promise<AgentReceipt> =>
  fetchJson('/api/agents', jsonInit('POST', input), AgentReceiptSchema);

export const updateAgent = (agentId: string, input: UpdateAgent): Promise<AgentReceipt> =>
  fetchJson(`/api/agents/${encodeURIComponent(agentId)}`, jsonInit('PATCH', input), AgentReceiptSchema);

export const deleteAgent = (agentId: string, input: DeleteAgent): Promise<AgentReceipt> =>
  fetchJson(`/api/agents/${encodeURIComponent(agentId)}`, jsonInit('DELETE', input), AgentReceiptSchema);

/** 用这个智能体执行的最近任务（按更新时间倒序）；旧任务缺省计入通用执行。 */
export const listAgentTasks = (agentId: string, limit: number): Promise<TaskList> =>
  fetchJson(`/api/tasks?${new URLSearchParams({ agentId, sort: 'recent', limit: String(limit) })}`, undefined, TaskListSchema);
