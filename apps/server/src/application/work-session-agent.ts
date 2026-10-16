import { agentModelState, type AgentService } from './agent-service.js';
import type { ModelSettingsService } from './model-settings-service.js';
import type { Agent, AssistantExecutor, CoordinatorModelConfig, CoordinatorRuntimeConfig, CoordinatorThinkingLevel, ModelSettingsSnapshot } from '@multivac/contracts';
import type { AssistantAgentExecution } from '../modules/sessions/assistant-turn.js';
import { createNewSessionRuntimeConfigResolver } from './new-session-runtime-config.js';
import { resolveTaskAgentModel, renderTaskConventions, type TaskConventions } from './task-agent-runtime.js';

/** 统一列表预览与执行快照的能力适配；显式配置的等级由各自准入校验。 */
function describeExecution(agent: Agent, model: CoordinatorModelConfig, snapshot: ModelSettingsSnapshot) {
  const profile = snapshot.profiles.find(profile => profile.profileId === model.profileId);
  const levels: readonly CoordinatorThinkingLevel[] | null = profile?.capabilities?.thinkingLevels ?? (profile?.capabilities?.reasoning === false ? ['off'] : null);
  if (agent.thinkingLevel === null && profile?.defaultThinkingLevel === undefined && levels?.length && !levels.includes(model.thinkingLevel)) {
    model = { ...model, thinkingLevel: levels.includes('off') ? 'off' : levels[0]! };
  }
  const executor: AssistantExecutor = {
    agentId: agent.agentId, revision: agent.revision, name: agent.name, modelProfileId: model.profileId ?? null,
    modelName: profile?.displayName ?? `${model.provider}/${model.modelId}`,
    provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel,
  };
  return { executor, model };
}

/** 列表只读一份模型快照，不为每个候选重新检查认证或构建执行配置。 */
export function previewWorkSessionAgent(agent: Agent, snapshot: ModelSettingsSnapshot | null, fallback: CoordinatorModelConfig): AssistantExecutor {
  if (!snapshot) throw new Error('模型配置暂时无法读取，请稍后重试。');
  const profileId = agent.modelProfileId ?? snapshot.defaultProfileId;
  if (profileId === null) return describeExecution(agent, fallback, snapshot).executor;
  const state = agentModelState({ modelProfileId: profileId, thinkingLevel: agent.thinkingLevel }, snapshot);
  if (state.status === 'review') throw new Error(state.message ?? '模型当前不可用。');
  const profile = snapshot.profiles.find(profile => profile.profileId === profileId)!;
  const availability = snapshot.availability.find(item => item.profileId === profileId);
  if (!availability?.authenticated) throw new Error(availability?.message ?? '模型当前未认证。');
  const levels = profile.capabilities?.thinkingLevels ?? (profile.capabilities?.reasoning === false ? ['off'] : []);
  if (agent.thinkingLevel === null && profile.defaultThinkingLevel !== undefined && !levels.includes(profile.defaultThinkingLevel)) {
    throw new Error('模型的默认推理等级不再受支持，请修复模型配置。');
  }
  return describeExecution(agent, {
    profileId, provider: profile.provider, modelId: profile.modelId,
    thinkingLevel: agent.thinkingLevel ?? profile.defaultThinkingLevel ?? fallback.thinkingLevel,
  }, snapshot).executor;
}

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
  const model = await resolveTaskAgentModel(input.settings, agent, input.base.model.thinkingLevel)
    ?? (await createNewSessionRuntimeConfigResolver(input.settings, input.base)()).model;
  // 异步模型解析后核对智能体版本；编辑或删除时拒绝本次受理，不能混合两版配置。
  if (input.agents.requireExecutable(agent.agentId).revision !== agent.revision) throw new Error('智能体配置已变化，请重新选择后发送。');
  const snapshot = await input.settings.getSnapshot();
  input.settings.assertReadVersion(version);
  if (input.agents.requireExecutable(agent.agentId).revision !== agent.revision) throw new Error('智能体配置已变化，请重新选择后发送。');
  return {
    ...describeExecution(agent, model, snapshot),
    instructions: renderTaskConventions({ ...input.conventions, agentName: agent.name, instructions: agent.instructions }).replace('## 本任务的执行约定', '## 本轮的执行约定'),
  };
}
