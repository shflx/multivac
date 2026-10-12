import { AgentListSchema, type AgentList } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

export const listAgents = (): Promise<AgentList> => fetchJson('/api/agents', undefined, AgentListSchema);
