import { Check, LoaderCircle } from 'lucide-react';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { CoordinatorThinkingLevel, ModelProfile, ModelProfileInput, ModelProtocol, ModelReasoningMode } from '@multivac/contracts';
import {
  draftReasoningLevels,
  draftReasoningSource,
  MODEL_PROTOCOLS,
  REASONING_MODES,
  THINKING_LEVEL_LABELS,
  type ReasoningLevelsView,
  type ReasoningSource,
} from './model-profile-view.js';

export interface ModelProfileFormProps {
  draft: ModelProfileInput;
  /** 正在编辑的已保存配置；新建时为 null。 */
  saved: ModelProfile | null;
  dirty: boolean;
  locked: boolean;
  /** 保存结果未知、冲突等需要处理的问题，写在操作按钮上方。 */
  issue: ReactNode;
  onChange: <K extends keyof ModelProfileInput>(key: K, value: ModelProfileInput[K]) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * “配置”小节里的原地编辑表单（按原型）：字段两列，推理能力是分段单选，
 * 底部左侧说明保存后的影响，右侧“取消 / ✓ 保存”。新建时多一个配置 ID。
 */
export function ModelProfileForm({
  draft,
  saved,
  dirty,
  locked,
  issue,
  onChange,
  onSave,
  onDiscard,
}: ModelProfileFormProps) {
  const creating = saved === null;
  const levels = draftReasoningLevels(draft, saved);
  const availableLevels = levels.kind === 'levels' ? levels.levels : levels.kind === 'none' ? ['off' as const] : [];
  const saveDisabled = locked || (!creating && !dirty) || !draft.profileId.trim() ||
    !draft.displayName.trim() || !draft.provider.trim() || !draft.modelId.trim();
  return (
    <form className="model-profile-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
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
          <small>兼容提供方必须填写 HTTP(S) 地址，且不得包含用户名或密码。</small>
        </label>
      </div>

      <ReasoningCapability
        value={draft.reasoning ?? 'auto'}
        source={draftReasoningSource(draft, saved)}
        levels={draftReasoningLevels(draft, saved)}
        disabled={locked}
        onChange={(mode) => onChange('reasoning', mode)}
      />

      <div className="model-form-grid">
        <label className="wide">
          <span>默认推理等级</span>
          <select aria-label="默认推理等级" value={draft.defaultThinkingLevel ?? ''} disabled={locked}
            onChange={event => onChange('defaultThinkingLevel', (event.target.value || undefined) as CoordinatorThinkingLevel | undefined)}>
            <option value="">未设置</option>
            {draft.defaultThinkingLevel && !availableLevels.includes(draft.defaultThinkingLevel) &&
              <option value={draft.defaultThinkingLevel} disabled>{THINKING_LEVEL_LABELS[draft.defaultThinkingLevel]}（待核对）</option>}
            {availableLevels.map(level => <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>)}
          </select>
          <small>{levels.kind === 'pending' ? '请先保存模型配置以读取支持的推理等级。' : '新会话使用默认模型或主动切换到此模型时应用，不修改已有会话的当前等级。'}</small>
        </label>
      </div>

      {issue}

      <div className="model-form-actions">
        <span className="model-edit-note">
          {creating
            ? '保存后再配置 API Key 并检查连接。'
            : '改了提供方、协议、模型 ID 或端点，保存后需要重新检查连接。'}
        </span>
        <button type="button" className="secondary-button" onClick={onDiscard} disabled={locked}>
          取消
        </button>
        <button type="submit" className="primary-button" disabled={saveDisabled}>
          {locked ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
          保存
        </button>
      </div>
    </form>
  );
}

/**
 * 推理能力：自动（按 Pi 目录）/ 支持 / 不支持 的分段单选，旁边如实标出判断来源，
 * 下方只读列出 Pi 给出的可选推理等级（规则见 draftReasoningLevels）。
 * 单选组按 WAI-ARIA 的 radiogroup：只有选中项在 Tab 序列里，方向键切换并选中。
 */
function ReasoningCapability({
  value,
  source,
  levels,
  disabled,
  onChange,
}: {
  value: ModelReasoningMode;
  source: ReasoningSource | null;
  levels: ReasoningLevelsView;
  disabled: boolean;
  onChange: (mode: ModelReasoningMode) => void;
}) {
  const titleId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + REASONING_MODES.length) % REASONING_MODES.length;
    onChange(REASONING_MODES[next]!.value);
    optionRefs.current[next]?.focus();
  }

  return (
    <div className="reasoning-capability">
      <div className="reasoning-head">
        <strong id={titleId}>推理能力</strong>
        <span className="reasoning-source">来源：{source ?? '保存后由 Pi 判断'}</span>
      </div>
      <div className="segmented reasoning-modes" role="radiogroup" aria-labelledby={titleId}>
        {REASONING_MODES.map((mode, index) => {
          const checked = mode.value === value;
          return (
            <button
              key={mode.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className={checked ? 'active' : ''}
              disabled={disabled}
              onClick={() => onChange(mode.value)}
              onKeyDown={(event) => moveSelection(event, index)}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
      {/* 等级放在单选组之外：只是展示，不是可选项。 */}
      {levels.kind !== 'none' && (
        <div className="reasoning-levels">
          <span>可选推理等级</span>
          {levels.kind === 'levels'
            ? levels.levels.map((level) => <em key={level}>{THINKING_LEVEL_LABELS[level]}</em>)
            : <span>保存后由 Pi 给出</span>}
        </div>
      )}
      {value === 'auto' && source === 'Pi 默认' && (
        <p className="reasoning-hint">
          该模型不在 Pi 模型目录中，自动模式按 Pi 默认视为不支持推理。如果确认它支持（例如自建地址的 Responses 模型），请选择“支持”。
        </p>
      )}
      {value === 'auto' && source === null && (
        <p className="reasoning-note">
          不在 Pi 模型目录中的模型（如自定义端点）在自动模式下按 Pi 默认视为不支持推理；确认它支持时请选择“支持”。
        </p>
      )}
      <p className="reasoning-note">
        这个设置只决定能不能开启推理，不保证模型一定返回可展示的思考内容。已开着的会话在下一次发送时按新设置生效。
      </p>
    </div>
  );
}
