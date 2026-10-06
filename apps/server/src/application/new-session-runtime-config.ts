import type { CoordinatorModelConfig, CoordinatorRuntimeConfig } from '@multivac/contracts';
import type { ModelSettingsService } from './model-settings-service.js';
import { sameSessionModelConfig } from '../modules/sessions/session-model-selection.js';
import { AssistantSessionServiceError } from './assistant-session-service.js';

/** 仅真正新建 Pi 会话时调用；错误直接传播，不用基础配置替代已设默认。 */
export function createNewSessionRuntimeConfigResolver(
  settings: ModelSettingsService,
  base: CoordinatorRuntimeConfig,
  initialModel?: CoordinatorModelConfig,
): () => Promise<CoordinatorRuntimeConfig> {
  return async () => {
    if (initialModel) {
      // 仅复核身份、能力与认证；模型的默认等级已变化时仍保留父会话的实际等级。
      if (initialModel.profileId) {
        try {
          const configured = await settings.getModelProfileRuntimeConfig(initialModel.profileId, { applyDefaultThinking: false });
          if (!sameSessionModelConfig(initialModel, { ...configured, thinkingLevel: initialModel.thinkingLevel })) {
            throw new Error('模型配置与创建时的快照不同。');
          }
        } catch (error) {
          throw new AssistantSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE',
            `继承的父会话模型 ${initialModel.provider}/${initialModel.modelId} 当前不可用：${error instanceof Error ? error.message : '配置或认证无法核对。'} 请修复后重试，不会自动切换全局默认模型。`);
        }
      }
      return { ...base, model: { ...initialModel } };
    }
    const selected = await settings.getDefaultModelForNewSession();
    if (selected === null) return base;
    return {
      ...base,
      model: { thinkingLevel: base.model.thinkingLevel, ...selected },
    };
  };
}
