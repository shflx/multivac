import { Check, ChevronDown, Cpu, Settings2, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CoordinatorThinkingLevel, ModelConnectionCheck } from '@multivac/contracts';
import { useSessionModel, type SessionModelChange } from './session-model.js';

const labels: Record<CoordinatorThinkingLevel, string> = { off: '关闭', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
const connectionLabels: Record<ModelConnectionCheck['status'], string> = {
  passed: '通过', failed: '失败', checking: '检查中', 'timed-out': '超时', cancelled: '已取消', invalidated: '检查已失效', expired: '检查已过期',
};

/** 会话模型选择器：只负责呈现与弹层交互，选模状态与命令来自共享的会话选模控制器。 */
export function ModelSelector({ active, running, onManage }: {
  active: boolean; running: boolean; onManage?: (() => void) | undefined;
}) {
  const { data, busy, error, readError, refresh, change: submitChange, reportError } = useSessionModel();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const originalFocus = useRef<HTMLElement | null>(null);

  useEffect(() => { if (active) void refresh(); else setOpen(false); }, [active, refresh]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  async function change(value: SessionModelChange) {
    if (running) return;
    if (await submitChange(value)) {
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }
  }

  const selection = data?.selection;
  const selected = data?.options.find((option) => option.profileId === selection?.profileId);
  const title = selected && selected.provider === selection?.provider && selected.modelId === selection.modelId
    ? selected.displayName : selection?.modelId || '未读取模型';
  const disabledReason = busy ? '模型选择正在提交或对账，暂不能发送或继续切换。'
    : running || data?.running ? data?.disabledReason ?? '会话运行中（包含重试与压缩），暂不能切换。' : data?.disabledReason ?? null;

  return <div className="model-selector" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape') { setOpen(false); trigger.current?.focus({ preventScroll: true }); event.stopPropagation(); }
  }}>
    <button type="button" ref={trigger} className="model-selector-trigger" aria-label="当前会话模型"
      aria-expanded={open} aria-controls="assistant-model-menu" title={disabledReason ?? title}
      onPointerDown={() => { if (!open && document.activeElement instanceof HTMLElement) originalFocus.current = document.activeElement; }}
      onClick={() => { setOpen((value) => !value); void refresh(); }}>
      <Cpu aria-hidden="true" /><span className="model-selector-name">{title}</span>
      <small>{selection ? labels[selection.thinkingLevel] : '未知'}</small><ChevronDown aria-hidden="true" />
    </button>
    {open && <div className="model-selector-menu" id="assistant-model-menu" aria-label="会话模型选择">
      <div className="model-selector-heading"><span>当前会话模型</span><strong title={title}>{title}</strong></div>
      {selection?.source === 'base' && <p className="model-selector-note">基础 Pi 模型 / {selection.provider} / {selection.modelId}</p>}
      {disabledReason && <p role="status" className="model-selector-note">{disabledReason}</p>}
      {(readError || error || selection?.availability.message) && <p role="alert" className="model-selector-error">{readError ?? error ?? selection?.availability.message}</p>}
      <div className="model-options">
        {data?.options.length === 0 && <p className="model-selector-note">尚无模型配置。</p>}
        {data?.options.map((option) => {
          const status = `${option.availability.authenticated ? '已认证' : '未认证'} · ${option.availability.available ? '可用' : '不可用'} · 连接${option.connection ? connectionLabels[option.connection.status] : '未测试'}`;
          const badge = !option.availability.available
            ? option.availability.authenticated ? '不可用' : '未配置'
            : option.connection?.status === 'failed' ? '连接失败'
              : option.connection?.status === 'timed-out' ? '连接超时'
                : option.connection?.status === 'checking' ? '检查中' : null;
          return <div key={option.profileId} className="model-option">
          <button type="button" className={option.profileId === selection?.profileId ? 'selected' : ''}
            disabled={Boolean(disabledReason) || Boolean(readError)}
            aria-describedby={`assistant-model-status-${option.profileId}`}
            title={`${option.displayName}\n${option.provider} / ${option.modelId}\n${status}${option.availability.message ? `\n${option.availability.message}` : ''}`}
            data-unavailable={!option.availability.available}
            onClick={() => option.availability.available ? void change({ profileId: option.profileId })
              : reportError(option.availability.message ?? '当前模型不可用，请进入管理页面修复。')}>
            <Cpu aria-hidden="true" /><span className="model-option-copy"><strong>{option.displayName}</strong><small>{option.provider} / {option.modelId}</small></span>
            <span className="model-option-indicator">
              {badge && <em>{badge}</em>}
              {option.profileId === selection?.profileId && <Check aria-label="已选择" />}
            </span>
          </button>
          <small id={`assistant-model-status-${option.profileId}`} className="model-option-status sr-only">{status}</small>
        </div>;
        })}
      </div>
      <label className="thinking-select"><span>推理等级</span><select aria-label="推理等级" value={selection?.thinkingLevel ?? ''}
        disabled={Boolean(disabledReason) || !selection?.availability.available || Boolean(readError)}
        onChange={(event) => void change({ thinkingLevel: event.target.value as CoordinatorThinkingLevel })}>
        {selection?.availableThinkingLevels.length
          ? selection.availableThinkingLevels.map((level) => <option key={level} value={level}>{labels[level]}</option>)
          : <option value={selection?.thinkingLevel ?? ''}>等级不可读取</option>}
      </select></label>
      {onManage && <button type="button" className="manage-models-link" data-shell-navigation onClick={() => {
        setOpen(false);
        if (originalFocus.current?.isConnected) originalFocus.current.focus({ preventScroll: true });
        onManage();
      }}><Settings2 aria-hidden="true" />管理模型配置<ArrowRight aria-hidden="true" /></button>}
    </div>}
  </div>;
}
