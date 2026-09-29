import type {
  ModelAvailability,
  ModelProfile,
  ModelProfileInput,
  ModelProtocol,
  ModelReasoningMode,
  ModelSettingsSnapshot,
} from '@multivac/contracts';

/**
 * 模型页的呈现规则（与界面无关，便于单测）：协议显示名、可用状态的短标签与说明、
 * 推理能力及其来源、默认模型失效时的页头提示。只决定怎么说，不改变任何状态。
 */

export const MODEL_PROTOCOLS: Array<{ value: ModelProtocol; label: string }> = [
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
];

/** 协议的显示名称；未知值（不应出现）原样显示。 */
export function protocolLabel(protocol: ModelProtocol): string {
  return MODEL_PROTOCOLS.find((item) => item.value === protocol)?.label ?? protocol;
}

export const REASONING_MODES: Array<{ value: ModelReasoningMode; label: string }> = [
  { value: 'auto', label: '自动（按 Pi 目录）' },
  { value: 'enabled', label: '支持' },
  { value: 'disabled', label: '不支持' },
];

export type ReasoningSource = '手动设置' | 'Pi 目录' | 'Pi 默认';

const CAPABILITY_SOURCES: Record<NonNullable<ModelProfile['capabilities']>['source'], ReasoningSource> = {
  'pi-catalog': 'Pi 目录',
  'pi-default': 'Pi 默认',
};

/** 推理能力与来源：手动设置优先；auto 时按 Pi 解析出的能力说明来源。 */
export function reasoningLabel(profile: ModelProfile): string {
  if (profile.reasoning !== 'auto') return `${profile.reasoning === 'enabled' ? '支持' : '不支持'}（手动设置）`;
  if (!profile.capabilities) return '未知';
  return `${profile.capabilities.reasoning ? '支持' : '不支持'}（${CAPABILITY_SOURCES[profile.capabilities.source]}）`;
}

/**
 * 编辑中的推理能力按什么判断：手动设置时是“手动设置”；自动时沿用已保存配置由 Pi 给出的来源，
 * 但只在连到的模型（提供方、模型 ID、协议）没有改动时才算数。新建或改了模型时返回 null，保存后才由 Pi 判断。
 */
export function draftReasoningSource(draft: ModelProfileInput, saved: ModelProfile | null): ReasoningSource | null {
  const mode = draft.reasoning ?? 'auto';
  if (mode !== 'auto') return '手动设置';
  if (!saved?.capabilities) return null;
  const sameModel = draft.provider.trim() === saved.provider &&
    draft.modelId.trim() === saved.modelId &&
    draft.protocol === saved.protocol;
  return sameModel ? CAPABILITY_SOURCES[saved.capabilities.source] : null;
}

/**
 * 可用状态的呈现：ok 为可用；invalid 为配置或模型本身有问题（红）；auth 为缺认证、unknown 为暂时读不到（琥珀）。
 */
export type AvailabilityState = 'ok' | 'invalid' | 'auth' | 'unknown';

export interface AvailabilityView {
  available: boolean;
  state: AvailabilityState;
  /** 短标签：详情头的状态标签、列表行“provider / modelId · 原因”都用它。 */
  label: string;
  /** 一句话说明：可用时写 Pi 的确认，不可用时写 Pi 给出的原因。 */
  message: string;
}

const AVAILABLE_MESSAGE = 'Pi 当前已确认该模型具备有效认证并可用。';

export function availabilityView(availability: ModelAvailability | undefined): AvailabilityView {
  if (!availability) {
    return { available: false, state: 'unknown', label: '状态未知', message: '还没有读到这个模型的可用状态。' };
  }
  if (availability.available) {
    return { available: true, state: 'ok', label: '可用', message: availability.message ?? AVAILABLE_MESSAGE };
  }
  const unavailable = (state: AvailabilityState, label: string, fallback: string): AvailabilityView =>
    ({ available: false, state, label, message: availability.message ?? fallback });
  switch (availability.reason) {
    case 'CONFIGURATION_INVALID':
      return unavailable('invalid', '配置需修复', '模型配置需要修复。');
    case 'MODEL_NOT_FOUND':
      return unavailable('invalid', '未找到模型', 'Pi 当前目录中未找到该模型。');
    case 'AUTH_MISSING':
      return unavailable('auth', '未认证', 'Pi 当前未检测到有效认证。');
    case 'MODEL_UNAVAILABLE':
      return unavailable('invalid', '当前不可用', 'Pi 当前未将该模型判定为可用。');
    case 'RUNTIME_ERROR':
      return unavailable('unknown', '状态未知', 'Pi 当前无法读取该模型的可用状态。');
    default:
      return availability.authenticated
        ? unavailable('invalid', '当前不可用', 'Pi 当前未将该模型判定为可用。')
        : unavailable('auth', '未认证', 'Pi 当前未检测到有效认证。');
  }
}

export function availabilityFor(
  snapshot: ModelSettingsSnapshot,
  profileId: string,
): ModelAvailability | undefined {
  return snapshot.availability.find((item) => item.profileId === profileId);
}

const AUTHENTICATION_TYPES = { api_key: 'API Key', oauth: 'OAuth' } as const;

/** 认证类型（技术字段，放在次要位置）：未认证时写“未认证”。 */
export function authenticationTypeLabel(availability: ModelAvailability | undefined): string {
  const type = availability?.authenticationType;
  return type ? AUTHENTICATION_TYPES[type] : '未认证';
}

/**
 * 默认模型失效时放在页头下方的提示（选中其他模型时也看得到）；默认模型可用或没有设置默认时为 null。
 * 默认引用保留、不自动换成其他模型，是模型配置的既定语义，这里只如实说明。
 */
export function defaultModelWarning(snapshot: ModelSettingsSnapshot): string | null {
  const profileId = snapshot.defaultProfileId;
  if (!profileId) return null;
  const profile = snapshot.profiles.find((item) => item.profileId === profileId);
  if (!profile) return null;
  const view = availabilityView(availabilityFor(snapshot, profileId));
  if (view.available) return null;
  const reason = /[。.！？]$/u.test(view.message) ? view.message : `${view.message}。`;
  return `默认模型「${profile.displayName}」当前不可用：${reason}` +
    '默认引用已保留，Multivac 不会自动换成其他模型；处理好后自动恢复，也可以把其他可用模型设为默认。';
}
