import { COORDINATOR_AGENT_ID, DEFAULT_AGENT_ID, type Agent } from '@multivac/contracts';

export interface AgentCommandRecord {
  commandId: string;
  fingerprint: string;
  result: Agent;
}

/** 命令回执与智能体记录在同一个短事务中提交。 */
export interface AgentRepository {
  transaction<T>(operation: () => T): T;
  get(agentId: string): Agent | null;
  /** 预置记录在前，其余按创建先后。 */
  list(): Agent[];
  /** 按规范化名称查找，用于名称唯一校验。 */
  byNameKey(nameKey: string): Agent | null;
  save(agent: Agent, previousRevision: number | null): void;
  delete(agentId: string, revision: number): void;
  command(commandId: string): AgentCommandRecord | null;
  saveCommand(command: AgentCommandRecord): void;
  /** 写入缺失的预置记录；已存在（包括用户改过）的不覆盖。 */
  seed(presets: readonly Agent[]): void;
}

/** 名称唯一按去掉首尾空白、全半角归一与大小写无关的形式比较。 */
export function agentNameKey(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

/**
 * 预置记录：协调者只作说明（固定，不可修改或删除）；通用执行是任务未指定智能体时的默认，
 * 跟随全局默认模型与默认推理等级、不带额外指令，保持引入智能体之前的执行行为。
 */
export function presetAgents(at: string): Agent[] {
  return [
    {
      agentId: COORDINATOR_AGENT_ID, name: 'Multivac（协调）',
      description: '只带内部工具与只读查询；有副作用的操作转交任务会话执行。',
      modelProfileId: null, thinkingLevel: null, instructions: '', fixed: true,
      revision: 1, createdAt: at, updatedAt: at,
    },
    {
      agentId: DEFAULT_AGENT_ID, name: '通用执行',
      description: '编码、文档与日常执行，适合大多数任务。',
      modelProfileId: null, thinkingLevel: null, instructions: '', fixed: false,
      revision: 1, createdAt: at, updatedAt: at,
    },
  ];
}
