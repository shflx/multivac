import { Brain, Cpu } from 'lucide-react';
import type { CoordinatorThinkingLevel, ModelSettingsSnapshot } from '@multivac/contracts';
import { THINKING_LEVEL_LABELS } from '../models/model-profile-view.js';
import { TaskFilter, type TaskFilterOption } from '../tasks/task-filter.js';

export interface AgentModelValue {
  modelProfileId: string | null;
  thinkingLevel: CoordinatorThinkingLevel | null;
}

/** 某个模型配置可选的推理等级；能力未知时为空。 */
export function profileThinkingLevels(snapshot: ModelSettingsSnapshot | null, profileId: string | null): CoordinatorThinkingLevel[] {
  if (!snapshot || profileId === null) return [];
  return [...(snapshot.profiles.find((profile) => profile.profileId === profileId)?.capabilities?.thinkingLevels ?? [])];
}

/**
 * 智能体的模型与推理等级：沿用模型页的配置与可用性，使用任务表单的同一套选择菜单。
 * 不选模型表示跟随全局默认；推理等级要先选模型。不可用的模型不能选；
 * 已保存的引用失效时仍显示为当前值并标“待核对”，由用户改选。
 */
export function AgentModelField({ value, snapshot, disabled, onChange }: {
  value: AgentModelValue;
  snapshot: ModelSettingsSnapshot | null;
  disabled: boolean;
  onChange: (next: AgentModelValue) => void;
}) {
  const profiles = snapshot?.profiles ?? [];
  const defaultName = profiles.find((profile) => profile.profileId === snapshot?.defaultProfileId)?.displayName;
  const available = (profileId: string) => snapshot?.availability.find((item) => item.profileId === profileId)?.available === true;
  const current = value.modelProfileId === null ? null : profiles.find((profile) => profile.profileId === value.modelProfileId) ?? null;
  const levels = profileThinkingLevels(snapshot, value.modelProfileId);
  const models: TaskFilterOption[] = [{
    id: '', label: snapshot ? '跟随全局默认' : '正在读取模型配置…',
    description: snapshot ? defaultName ?? '未设置默认模型' : '',
  }];
  if (value.modelProfileId !== null && !current) {
    models.push({ id: value.modelProfileId, label: '已删除的模型（待核对）', disabled: true });
  }
  models.push(...profiles.map((profile) => {
    const usable = available(profile.profileId) && !!profile.capabilities;
    const selected = profile.profileId === value.modelProfileId;
    return {
      id: profile.profileId,
      label: `${profile.displayName}${usable ? '' : selected ? '（待核对）' : '（不可用）'}`,
      description: `${profile.provider} / ${profile.modelId}`,
      disabled: !usable,
    };
  }));
  const thinking: TaskFilterOption[] = [{ id: '', label: '模型默认' }];
  if (value.thinkingLevel !== null && !levels.includes(value.thinkingLevel)) {
    thinking.push({ id: value.thinkingLevel, label: `${THINKING_LEVEL_LABELS[value.thinkingLevel]}（待核对）`, disabled: true });
  }
  thinking.push(...levels.map((level) => ({ id: level, label: THINKING_LEVEL_LABELS[level] })));

  function changeModel(profileId: string | null) {
    // 新模型不支持当前推理等级时回到模型默认，不替用户挑一个等级。
    const keep = value.thinkingLevel !== null && profileThinkingLevels(snapshot, profileId).includes(value.thinkingLevel);
    onChange({ modelProfileId: profileId, thinkingLevel: keep ? value.thinkingLevel : null });
  }

  return (
    <div className="agent-model-field">
      <div className="agent-field">
        <span>模型</span>
        <TaskFilter label="模型" name="模型" icon={Cpu} appearance="field" value={value.modelProfileId ?? ''}
          options={models} disabled={disabled || !snapshot} onChange={(id) => changeModel(id || null)} />
      </div>
      <div className="agent-field" title={value.modelProfileId === null ? '跟随全局默认时使用默认模型的推理等级；选择模型后可单独设置。' : undefined}>
        <span>推理等级</span>
        <TaskFilter label="推理等级" name="推理等级" icon={Brain} appearance="field" value={value.thinkingLevel ?? ''}
          options={thinking} disabled={disabled || value.modelProfileId === null || !levels.length}
          onChange={(id) => onChange({ ...value, thinkingLevel: (id || null) as CoordinatorThinkingLevel | null })} />
      </div>
    </div>
  );
}
