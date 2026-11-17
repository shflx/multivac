import { Check, LoaderCircle } from 'lucide-react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { MODEL_CONTEXT_WINDOW_MAX } from '@multivac/contracts';
import type { CoordinatorThinkingLevel, ModelProfile, ModelProfileInput, ModelProtocol } from '@multivac/contracts';
import {
  draftDefaultContextWindow,
  draftReasoningLevels,
  draftReasoningSource,
  MODEL_PROTOCOLS,
  REASONING_MODES,
  THINKING_LEVEL_LABELS,
  type ReasoningLevelsView,
} from './model-profile-view.js';

export interface ModelProfileFormProps {
  /** 表单 id：保存按钮在详情头里，经 form 属性提交本表单。 */
  formId: string;
  draft: ModelProfileInput;
  /** 正在编辑的已保存配置；新建时为 null。 */
  saved: ModelProfile | null;
  locked: boolean;
  /** 保存结果未知、冲突等需要处理的问题，写在表单顶部，靠近详情头的保存按钮。 */
  issue: ReactNode;
  onChange: <K extends keyof ModelProfileInput>(key: K, value: ModelProfileInput[K]) => void;
  onSave: () => void;
}

/** 能否保存：必填项齐全，编辑已有配置时还要有改动。 */
export function modelProfileSaveDisabled(draft: ModelProfileInput, creating: boolean, dirty: boolean, locked: boolean): boolean {
  return locked || (!creating && !dirty) || !draft.profileId.trim() ||
    !draft.displayName.trim() || !draft.provider.trim() || !draft.modelId.trim();
}

/**
 * 编辑时的“取消 / ✓ 保存”：放在详情头原来“编辑”的位置，点了编辑就在原处出现，
 * 详情头在编辑期间吸顶，滚到表单下方也能直接保存。
 */
export function ModelFormActions({ formId, saveDisabled, locked, onDiscard }: {
  formId: string;
  saveDisabled: boolean;
  locked: boolean;
  onDiscard: () => void;
}) {
  return (
    <div className="model-detail-actions">
      <button type="button" className="secondary-button" onClick={onDiscard} disabled={locked}>
        取消
      </button>
      <button type="submit" form={formId} className="primary-button" disabled={saveDisabled}>
        {locked ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
        保存
      </button>
    </div>
  );
}

/**
 * “配置”小节里的原地编辑表单：分“连接”（连到哪个模型）与“能力”（上下文窗口、推理能力、默认推理等级）两组，
 * 字段两列；推理能力与默认推理等级都是分段单选，默认推理等级的选项即 Pi 给出的可选等级。新建时多一个配置 ID。
 */
export function ModelProfileForm({
  formId,
  draft,
  saved,
  locked,
  issue,
  onChange,
  onSave,
}: ModelProfileFormProps) {
  const creating = saved === null;
  const contextHintId = useId();
  const reasoningId = useId();
  const levelId = useId();
  const source = draftReasoningSource(draft, saved);
  const reasoning = draft.reasoning ?? 'auto';
  const levels = draftReasoningLevels(draft, saved);
  return (
    <form id={formId} className="model-profile-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      {issue}

      <fieldset className="model-form-group">
        <legend>连接</legend>
        <div className="model-form-grid">
          {creating && (
            <label className="wide">
              <span>配置 ID</span>
              <input
                autoFocus
                aria-label="配置 ID"
                value={draft.profileId}
                disabled={locked}
                onChange={(event) => onChange('profileId', event.target.value)}
                placeholder="例如 openai-main"
              />
              <small>保存后保持稳定，用于默认模型引用。</small>
            </label>
          )}
          <label>
            <span>显示名称</span>
            <input
              autoFocus={!creating}
              aria-label="显示名称"
              value={draft.displayName}
              disabled={locked}
              onChange={(event) => onChange('displayName', event.target.value)}
              placeholder="例如 GPT 主模型"
            />
          </label>
          <label>
            <span>提供方</span>
            <input
              aria-label="提供方"
              value={draft.provider}
              disabled={locked}
              onChange={(event) => onChange('provider', event.target.value)}
              placeholder="例如 openai"
            />
          </label>
          <label>
            <span>协议</span>
            <select
              aria-label="协议"
              value={draft.protocol}
              disabled={locked}
              onChange={(event) => onChange('protocol', event.target.value as ModelProtocol)}
            >
              {MODEL_PROTOCOLS.map((protocol) => (
                <option key={protocol.value} value={protocol.value}>{protocol.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>模型 ID</span>
            <input
              aria-label="模型 ID"
              value={draft.modelId}
              disabled={locked}
              onChange={(event) => onChange('modelId', event.target.value)}
              placeholder="例如 gpt-5"
            />
          </label>
          <label className="wide">
            <span>API 端点</span>
            <input
              aria-label="API 端点"
              value={draft.endpoint ?? ''}
              disabled={locked}
              onChange={(event) => onChange('endpoint', event.target.value || null)}
              placeholder="官方提供方可留空"
            />
            <small>
              兼容提供方必须填写 HTTP(S) 地址，且不得包含用户名或密码。
              {creating ? '保存后再配置 API Key 并检查连接。' : '改了提供方、协议、模型 ID 或端点，保存后需要重新检查连接。'}
            </small>
          </label>
        </div>
      </fieldset>

      <fieldset className="model-form-group">
        <legend>能力</legend>
        <div className="model-form-grid">
          <label className="wide">
            <span>上下文窗口（token）</span>
            <input aria-label="上下文窗口（token）" type="number" min={1} max={MODEL_CONTEXT_WINDOW_MAX} step={1}
              value={draft.contextWindow ?? ''} disabled={locked} placeholder="留空沿用 Pi"
              aria-describedby={contextHintId}
              onInvalid={event => event.currentTarget.setCustomValidity(`上下文窗口必须是 1 至 ${MODEL_CONTEXT_WINDOW_MAX.toLocaleString('en-US')} 的整数（token），或留空沿用 Pi。`)}
              onChange={event => {
                event.currentTarget.setCustomValidity('');
                onChange('contextWindow', event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber);
              }} />
            <small id={contextHintId}>{draftDefaultContextWindow(draft, saved)}。留空沿用 Pi；已打开会话空闲时生效，运行中的会话会等待本轮结束。</small>
          </label>

          <div className="model-field wide">
            <div className="model-field-label">
              <span id={reasoningId}>推理能力</span>
              <span className="reasoning-source">来源：{source ?? '保存后由 Pi 判断'}</span>
            </div>
            <SegmentedRadio
              labelledBy={reasoningId}
              options={REASONING_MODES}
              value={reasoning}
              disabled={locked}
              onChange={(mode) => onChange('reasoning', mode)}
            />
            {reasoning === 'auto' && source === 'Pi 默认' && (
              <p className="reasoning-hint">
                该模型不在 Pi 模型目录中，自动模式按 Pi 默认视为不支持推理。如果确认它支持（例如自建地址的 Responses 模型），请选择“支持”。
              </p>
            )}
            <small>
              {reasoning === 'auto' && source === null && '不在 Pi 模型目录中的模型（如自定义端点）在自动模式下按 Pi 默认视为不支持推理；确认它支持时请选择“支持”。'}
              只决定能不能开启推理，不保证模型一定返回可展示的思考内容；已开着的会话在下一次发送时按新设置生效。
            </small>
          </div>

          <DefaultThinkingLevel
            id={levelId}
            value={draft.defaultThinkingLevel}
            levels={levels}
            disabled={locked}
            onChange={(level) => onChange('defaultThinkingLevel', level)}
          />
        </div>
      </fieldset>
    </form>
  );
}

/** 默认推理等级的取值：未设置用空串表示，便于和等级放进同一个分段单选。 */
type DefaultLevelValue = CoordinatorThinkingLevel | '';

/**
 * 默认推理等级：“未设置”加 Pi 给出的可选等级，一组分段单选同时说明能选什么、选了什么。
 * 不支持推理时只有“关闭”；草稿改了连到的模型或推理设置时，等保存后由 Pi 给出等级。
 * 已选的等级不在可选范围内时保留为“待核对”，由服务端保存时核对，不静默改掉。
 */
function DefaultThinkingLevel({ id, value, levels, disabled, onChange }: {
  id: string;
  value: CoordinatorThinkingLevel | undefined;
  levels: ReasoningLevelsView;
  disabled: boolean;
  onChange: (level: CoordinatorThinkingLevel | undefined) => void;
}) {
  const available: CoordinatorThinkingLevel[] = levels.kind === 'levels' ? levels.levels : levels.kind === 'none' ? ['off'] : [];
  const options: Array<{ value: DefaultLevelValue; label: string; stale?: boolean }> = [
    { value: '', label: '未设置' },
    ...(value && !available.includes(value) ? [{ value, label: `${THINKING_LEVEL_LABELS[value]}（待核对）`, stale: true }] : []),
    ...available.map((level) => ({ value: level, label: THINKING_LEVEL_LABELS[level] })),
  ];
  return (
    <div className="model-field wide">
      <div className="model-field-label"><span id={id}>默认推理等级</span></div>
      <SegmentedRadio
        labelledBy={id}
        options={options}
        value={value ?? ''}
        disabled={disabled}
        onChange={(level) => onChange(level || undefined)}
      />
      <small>
        {levels.kind === 'pending'
          ? '可选等级保存后由 Pi 给出。'
          : '新会话使用默认模型或主动切换到此模型时应用，不修改已有会话的当前等级。'}
      </small>
    </div>
  );
}

/**
 * 分段单选，按 WAI-ARIA 的 radiogroup：只有选中项在 Tab 序列里，方向键切换并选中。
 * 标为 stale 的选项只用来如实显示当前值，方向键不会切到它。
 */
function SegmentedRadio<T extends string>({ labelledBy, options, value, disabled, onChange }: {
  labelledBy: string;
  options: ReadonlyArray<{ value: T; label: string; stale?: boolean }>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectable = options.flatMap((option, index) => option.stale ? [] : [index]);

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || selectable.length === 0) return;
    event.preventDefault();
    const position = selectable.indexOf(index);
    const next = selectable[position < 0 ? 0 : (position + step + selectable.length) % selectable.length]!;
    onChange(options[next]!.value);
    optionRefs.current[next]?.focus();
  }

  return (
    <div className="segmented model-segmented" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => { optionRefs.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={[checked ? 'active' : '', option.stale ? 'stale' : ''].filter(Boolean).join(' ')}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => moveSelection(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
