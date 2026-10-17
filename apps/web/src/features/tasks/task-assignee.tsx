import { UserRound } from 'lucide-react';
import { DEFAULT_AGENT_ID, type AgentList, type Task } from '@multivac/contracts';
import { agentName } from '../agents/use-agents.js';

/** 任务卡片的负责人头像：只标记例外的处理方，默认智能体不显示，保持卡片简洁。 */
export function TaskAssignee({ task, agents }: { task: Task; agents: AgentList | null }) {
  if (task.humanOnly) {
    return <span className="task-card-assignee human" role="img" aria-label="我来处理" title="我来处理"><UserRound aria-hidden="true" /></span>;
  }
  if ((task.agentId ?? DEFAULT_AGENT_ID) === DEFAULT_AGENT_ID) return null;

  const name = agentName(agents, task.agentId);
  return <span className="task-card-assignee agent" role="img" aria-label={`执行智能体：${name}`} title={`执行智能体：${name}`}>{Array.from(name)[0]}</span>;
}
