import { Type } from 'typebox';
import {
  AgentListSchema, AgentModelStateSchema, AgentReceiptSchema, AgentSchema, TaskListSchema,
  type Agent, type AgentList, type AgentModelState, type AgentReceipt, type CreateAgent, type DeleteAgent, type TaskList, type UpdateAgent,
} from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

const AgentDetailSchema = Type.Object({ agent: AgentSchema, modelState: AgentModelStateSchema }, { additionalProperties: false });
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const path = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}`;

export const listAgents = (): Promise<AgentList> => fetchJson('/api/agents', undefined, AgentListSchema);
export const getAgent = (agentId: string): Promise<{ agent: Agent; modelState: AgentModelState }> => fetchJson(path(agentId), undefined, AgentDetailSchema);
export const createAgent = (input: CreateAgent): Promise<AgentReceipt> => fetchJson('/api/agents', json('POST', input), AgentReceiptSchema);
export const updateAgent = (agentId: string, input: UpdateAgent): Promise<AgentReceipt> => fetchJson(path(agentId), json('PATCH', input), AgentReceiptSchema);
export const deleteAgent = (agentId: string, input: DeleteAgent): Promise<AgentReceipt> => fetchJson(path(agentId), json('DELETE', input), AgentReceiptSchema);

/** 用这个智能体执行的最近任务（按最近更新排序）。 */
export const recentAgentTasks = (agentId: string, limit: number): Promise<TaskList> =>
  fetchJson(`/api/tasks?${new URLSearchParams({ agentId, sort: 'recent', limit: String(limit) })}`, undefined, TaskListSchema);
