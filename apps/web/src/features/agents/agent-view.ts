import type { Agent, AgentModelState, CoordinatorThinkingLevel, ModelSettingsSnapshot } from '@multivac/contracts';
import { THINKING_LEVEL_LABELS } from '../models/model-profile-view.js';

/**
 * 智能体页的呈现规则（与界面无关，便于单测）：列表摘要、模型与推理等级的显示名、可选等级，
 * 以及换模型时推理等级怎么跟着变。只决定怎么说、提交什么，校验以服务端为准。
 */

export type AgentModelFields = Pick<Agent, 'modelProfileId' | 'thinkingLevel'>;

/** 列表行的一句话：协调者标“固定配置”，其他写用途（描述）。 */
export function agentListSummary(agent: Pick<Agent, 'fixed' | 'description'>): string {
  if (agent.fixed) return '固定配置';
  return agent.description || '未填写用途';
}

/** 模型的显示名：跟随默认时写明当前默认模型；引用的配置已删除时保留原 ID。 */
export function agentModelLabel(fields: AgentModelFields, snapshot: ModelSettingsSnapshot | null): string {
  if (fields.modelProfileId === null) {
    const fallback = snapshot?.profiles.find((profile) => profile.profileId === snapshot.defaultProfileId);
    return fallback ? `跟随默认（${fallback.displayName}）` : '跟随默认模型';
  }
  return snapshot?.profiles.find((profile) => profile.profileId === fields.modelProfileId)?.displayName ?? fields.modelProfileId;
}

/** 推理等级的显示名：未指定时使用模型配置的默认等级。 */
export function agentThinkingLabel(level: CoordinatorThinkingLevel | null): string {
  return level === null ? '模型默认等级' : THINKING_LEVEL_LABELS[level];
}

/** 所选模型可指定的推理等级（Pi 给出的能力）；跟随默认、不支持推理或能力未知时为空。 */
export function agentThinkingLevels(snapshot: ModelSettingsSnapshot | null, profileId: string | null): CoordinatorThinkingLevel[] {
  if (profileId === null) return [];
  const capabilities = snapshot?.profiles.find((profile) => profile.profileId === profileId)?.capabilities;
  if (!capabilities?.reasoning) return [];
  return capabilities.thinkingLevels ?? [];
}

/**
 * 换模型时一并提交的字段：跟随默认时推理等级回到模型默认（服务端不接受只有等级没有模型）；
 * 新模型不支持当前等级时同样回到模型默认，避免换模型被拒。
 */
export function modelChange(current: AgentModelFields, profileId: string | null, snapshot: ModelSettingsSnapshot | null): AgentModelFields {
  if (profileId === null) return { modelProfileId: null, thinkingLevel: null };
  const level = current.thinkingLevel;
  const keep = level !== null && agentThinkingLevels(snapshot, profileId).includes(level);
  return { modelProfileId: profileId, thinkingLevel: keep ? level : null };
}

/** 模型待核对时的说明：保留原引用，不会自动换成其他模型。 */
export function agentModelReview(state: AgentModelState | undefined): string | null {
  if (state?.status !== 'review') return null;
  const reason = state.message ?? '模型当前不可用。';
  return `模型待核对：${/[。.！？]$/u.test(reason) ? reason : `${reason}。`}用它的任务不能启动，也不会自动换成其他模型；可以重新选择，或去模型配置处理。`;
}
