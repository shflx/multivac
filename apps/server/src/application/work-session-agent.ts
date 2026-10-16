import type { AgentService } from './agent-service.js';
import type { ModelSettingsService } from './model-settings-service.js';
import type { CoordinatorRuntimeConfig, CoordinatorThinkingLevel } from '@multivac/contracts';
import type { AssistantAgentExecution } from '../modules/sessions/assistant-turn.js';
import { createNewSessionRuntimeConfigResolver } from './new-session-runtime-config.js';
import { resolveTaskAgentModel, renderTaskConventions, type TaskConventions } from './task-agent-runtime.js';

/** 复用执行智能体准入与新会话默认解析。跟随默认指全局默认，不读取当前会话的选模。 */
export async function resolveWorkSessionAgent(input: {
  agentId: string;
  agents: AgentService;
  settings: ModelSettingsService;
  base: CoordinatorRuntimeConfig;
  conventions: Omit<TaskConventions, 'agentName' | 'instructions'>;
}): Promise<AssistantAgentExecution> {
  const agent = await input.agents.admit(input.agentId);
  const version = input.settings.readVersion();
  let model = await resolveTaskAgentModel(input.settings, agent, input.base.model.thinkingLevel)
    ?? (await createNewSessionRuntimeConfigResolver(input.settings, input.base)()).model;
  // 异步模型解析后核对智能体版本；编辑或删除时拒绝本次受理，不能混合两版配置。
  if (input.agents.requireExecutable(agent.agentId).revision !== agent.revision) throw new Error('智能体配置已变化，请重新选择后发送。');
  const snapshot = await input.settings.getSnapshot();
  input.settings.assertReadVersion(version);
  if (input.agents.requireExecutable(agent.agentId).revision !== agent.revision) throw new Error('智能体配置已变化，请重新选择后发送。');
  const profile = snapshot.profiles.find(profile => profile.profileId === model.profileId);
  const levels: readonly CoordinatorThinkingLevel[] | null = profile?.capabilities?.thinkingLevels ?? (profile?.capabilities?.reasoning === false ? ['off'] : null);
  // 没有配置等级时沿用新会话的能力适配结果；显式设置的失效等级仍由准入拒绝。
  if (agent.thinkingLevel === null && profile?.defaultThinkingLevel === undefined && levels?.length && !levels.includes(model.thinkingLevel)) {
    model = { ...model, thinkingLevel: levels.includes('off') ? 'off' : levels[0]! };
  }
  const modelName = profile?.displayName ?? `${model.provider}/${model.modelId}`;
  return {
    executor: { agentId: agent.agentId, revision: agent.revision, name: agent.name, modelProfileId: model.profileId ?? null, modelName, provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel },
    model,
    instructions: renderTaskConventions({ ...input.conventions, agentName: agent.name, instructions: agent.instructions }).replace('## 本任务的执行约定', '## 本轮的执行约定'),
  };
}
