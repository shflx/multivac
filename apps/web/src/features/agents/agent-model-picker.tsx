import { ArrowRight, Check, ChevronDown, CircleAlert, Cpu, Settings2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { CoordinatorThinkingLevel, ModelSettingsSnapshot } from '@multivac/contracts';
import { THINKING_LEVEL_LABELS, availabilityFor, availabilityView } from '../models/model-profile-view.js';
import { agentModelLabel, agentThinkingLabel, agentThinkingLevels, modelChange, type AgentModelFields } from './agent-view.js';

/**
 * 智能体的模型与推理等级选择：沿用会话模型选择器的触发器、弹层与推理等级下拉，
 * 多一个“跟随默认模型”与“模型默认等级”。不可用的模型不能选，只说明原因；
 * 选择即通过 onChange 交给调用方（详情里立即保存，新建表单里写进草稿）。
 */
export function AgentModelPicker({
  label,
  snapshot,
  value,
  unavailable,
  disabled,
  onChange,
  onOpen,
  onManage,
}: {
  /** 触发器与弹层的可访问名称，例如“代码审查 的模型与推理等级”。 */
  label: string;
  snapshot: ModelSettingsSnapshot | null;
  value: AgentModelFields;
  /** 已保存的引用待核对：触发器换成警示图标。 */
  unavailable?: boolean;
  /** 正在保存：忽略新的选择，弹层保持打开。 */
  disabled?: boolean;
  onChange: (next: AgentModelFields) => void;
  /** 打开弹层时调用，用于刷新模型配置快照。 */
  onOpen?: () => void;
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const levels = agentThinkingLevels(snapshot, value.modelProfileId);
  const title = agentModelLabel(value, snapshot);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  // 保存期间不禁用弹层里的控件（禁用会让焦点掉到页面上），只忽略新的选择。
  function choose(profileId: string | null): void {
    if (disabled) return;
    if (profileId !== null && snapshot) {
      const view = availabilityView(availabilityFor(snapshot, profileId));
      if (!view.available) {
        setError(`这个模型当前不可用：${view.message}`);
        return;
      }
    }
    setError(null);
    const next = modelChange(value, profileId, snapshot);
    if (next.modelProfileId !== value.modelProfileId || next.thinkingLevel !== value.thinkingLevel) onChange(next);
  }

  return (
    <div className="model-selector agent-model-selector" ref={root} onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }}>
      <button type="button" ref={trigger} className="model-selector-trigger" aria-label={label} aria-expanded={open}
        aria-controls={menuId} aria-busy={disabled || undefined} title={title}
        onClick={() => { setOpen((current) => !current); setError(null); onOpen?.(); }}>
        {unavailable ? <CircleAlert aria-hidden="true" className="agent-model-alert" /> : <Cpu aria-hidden="true" />}
        <span className="model-selector-name">{title}</span>
        <small>{agentThinkingLabel(value.thinkingLevel)}</small>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="model-selector-menu" id={menuId} aria-label={label}>
          <div className="model-selector-heading"><span>智能体模型</span><strong title={title}>{title}</strong></div>
          {!snapshot && <p className="model-selector-note" role="status">正在读取模型配置…</p>}
          {error && <p role="alert" className="model-selector-error">{error}</p>}
          <div className="model-options">
            <div className="model-option">
              <button type="button" className={value.modelProfileId === null ? 'selected' : ''} onClick={() => choose(null)}>
                <Cpu aria-hidden="true" />
                <span className="model-option-copy"><strong>跟随默认模型</strong><small>使用新会话的默认模型与默认等级</small></span>
                <span className="model-option-indicator">{value.modelProfileId === null && <Check aria-label="已选择" />}</span>
              </button>
            </div>
            {snapshot?.profiles.map((profile) => {
              const view = availabilityView(availabilityFor(snapshot, profile.profileId));
              const selected = profile.profileId === value.modelProfileId;
              return (
                <div key={profile.profileId} className="model-option">
                  <button type="button" className={selected ? 'selected' : ''} data-unavailable={!view.available}
                    title={`${profile.displayName}\n${profile.provider} / ${profile.modelId}${view.available ? '' : `\n${view.message}`}`}
                    onClick={() => choose(profile.profileId)}>
                    <Cpu aria-hidden="true" />
                    <span className="model-option-copy"><strong>{profile.displayName}</strong><small>{profile.provider} / {profile.modelId}</small></span>
                    <span className="model-option-indicator">
                      {!view.available && <em>{view.label}</em>}
                      {selected && <Check aria-label="已选择" />}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <label className="thinking-select">
            <span>推理等级</span>
            <select aria-label="推理等级" value={value.thinkingLevel ?? ''} disabled={value.modelProfileId === null || levels.length === 0}
              onChange={(event) => { if (!disabled) onChange({ ...value, thinkingLevel: (event.target.value || null) as CoordinatorThinkingLevel | null }); }}>
              <option value="">模型默认等级</option>
              {levels.map((level) => <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>)}
              {value.thinkingLevel !== null && !levels.includes(value.thinkingLevel) && (
                <option value={value.thinkingLevel}>{THINKING_LEVEL_LABELS[value.thinkingLevel]}（不再支持）</option>
              )}
            </select>
          </label>
          {value.modelProfileId === null && <p className="model-selector-note">跟随默认模型时使用模型配置的默认等级；要指定等级，先选择一个模型。</p>}
          {value.modelProfileId !== null && levels.length === 0 && snapshot && <p className="model-selector-note">这个模型不支持指定推理等级，使用模型默认。</p>}
          {onManage && (
            <button type="button" className="manage-models-link" data-shell-navigation onClick={() => { setOpen(false); onManage(); }}>
              <Settings2 aria-hidden="true" />管理模型配置<ArrowRight aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
