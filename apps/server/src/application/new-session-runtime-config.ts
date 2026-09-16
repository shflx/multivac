import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import type { ModelSettingsService } from './model-settings-service.js';

/** 仅真正新建 Pi 会话时调用；错误直接传播，不用基础配置替代已设默认。 */
export function createNewSessionRuntimeConfigResolver(
  settings: ModelSettingsService,
  base: CoordinatorRuntimeConfig,
): () => Promise<CoordinatorRuntimeConfig> {
  return async () => {
    const selected = await settings.getDefaultModelForNewSession();
    if (selected === null) return base;
    return {
      ...base,
      model: { thinkingLevel: base.model.thinkingLevel, ...selected },
    };
  };
}
