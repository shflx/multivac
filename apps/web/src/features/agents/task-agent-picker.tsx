import { DEFAULT_AGENT_ID, type AgentList } from '@multivac/contracts';
import { THINKING_LEVEL_LABELS } from '../models/model-profile-view.js';
import { agentName, useAgents } from './use-agents.js';

/** 可被任务选用的智能体（协调者是固定配置，不出现在选择里）。 */
function executableAgents(list: AgentList) {
  return list.agents.filter((agent) => !agent.fixed);
}

/**
 * 所选执行智能体此刻不能用于执行的原因；可以执行时为 null。列表未读到、智能体已不存在或模型待核对时不能确认，
 * 不回退到其他智能体或模型。最终仍以服务端确认时的核对为准。
 */
export function taskAgentBlocker(list: AgentList | null, agentId: string): string | null {
  if (!list) return '正在读取执行智能体…';
  const agent = executableAgents(list).find((item) => item.agentId === agentId);
  if (!agent) return '所选执行智能体已不存在，请改选。';
  if (list.modelStates[agentId]?.status === 'review') return `执行智能体「${agent.name}」的模型待核对，不能以它执行，请改选或到设置 · 智能体修复。`;
  return null;
}

/** 卡片能否确认：与选择器读同一份智能体列表。 */
export function useTaskAgentBlocker(agentId: string): string | null {
  return taskAgentBlocker(useAgents(), agentId);
}

/** 所选智能体的模型与推理等级摘要；模型待核对时写明原因。 */
function ModelSummary({ list, agentId }: { list: AgentList; agentId: string }) {
  const agent = list.agents.find((item) => item.agentId === agentId);
  const state = list.modelStates[agentId];
  if (!agent || !state) return null;
  if (state.status === 'review') return <small className="receipt-agent-summary review">模型待核对：{state.message ?? '模型当前不可用。'}</small>;
  const model = state.status === 'default' ? '跟随全局默认模型' : state.modelName ?? '已选模型';
  const thinking = agent.thinkingLevel ? THINKING_LEVEL_LABELS[agent.thinkingLevel] : '模型默认';
  return <small className="receipt-agent-summary">{model} · 推理：{thinking}</small>;
}

/**
 * 任务确认卡上的执行智能体选择：默认通用执行，可以改选；下方显示所选智能体的模型与推理等级。
 * 智能体只是执行配置，不改变权限边界，卡上不展示指令。
 */
export function TaskAgentPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (agentId: string) => void }) {
  const list = useAgents();
  const agents = list ? executableAgents(list) : [];
  const missing = list !== null && !agents.some((agent) => agent.agentId === value);
  return (
    <span className="receipt-agent-field">
      <select className="receipt-agent" aria-label="执行智能体" value={value} disabled={disabled || !list} onChange={(event) => onChange(event.target.value)}>
        {!list && <option value={value}>{agentName(null, value)}</option>}
        {missing && <option value={value} disabled>已删除的智能体</option>}
        {agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>)}
      </select>
      {list && <ModelSummary list={list} agentId={value} />}
    </span>
  );
}

/** 远程访问读不到智能体列表：只显示卡上的默认选择，更换要回到本机。 */
export function RemoteTaskAgent({ value }: { value: string }) {
  return <>{value === DEFAULT_AGENT_ID ? '通用执行' : '提议指定的智能体'}<small className="receipt-agent-summary">在本机的确认卡上可以更换执行智能体。</small></>;
}
