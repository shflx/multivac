import {
  modelReasoningOverride,
  type CoordinatorThinkingLevel,
  type ModelAvailability,
  type ModelCapabilities,
  type ModelProfileInput,
} from '@multivac/contracts';
import type {
  ModelSettingsCatalog,
  ModelSettingsCatalogFactory,
} from '../../modules/model-settings/model-settings.js';

/** 夹具模型支持推理时的等级：取 Pi 对没有等级映射的推理模型给出的等级，夹具会话选模用同一份。 */
export const FAKE_REASONING_LEVELS: readonly CoordinatorThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

const FAKE_CAPABILITIES: ModelCapabilities = {
  source: 'pi-catalog',
  input: ['text', 'image'],
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  reasoning: true,
};

/** 与 Pi 一致：不支持推理时只有 off。 */
function fakeThinkingLevels(reasoning: boolean): CoordinatorThinkingLevel[] {
  return reasoning ? [...FAKE_REASONING_LEVELS] : ['off'];
}

class FakeModelSettingsCatalog implements ModelSettingsCatalog {
  constructor(private readonly authenticated: (provider: string) => boolean) {}
  async inspect(profiles: readonly ModelProfileInput[]) {
    const capabilities = new Map(
      profiles.map((profile) => {
        const reasoning = modelReasoningOverride(profile.reasoning) ?? FAKE_CAPABILITIES.reasoning;
        return [profile.profileId, { ...FAKE_CAPABILITIES, reasoning, thinkingLevels: fakeThinkingLevels(reasoning) }] as const;
      }),
    );
    const resolvedModels = new Map(profiles.map((profile) => [profile.profileId, {
      protocol: profile.protocol,
      endpoint: profile.endpoint ?? `https://${profile.provider}.example/v1`,
    }] as const));
    const availability: ModelAvailability[] = profiles.map((profile) => {
      const authenticated = this.authenticated(profile.provider);
      return {
        profileId: profile.profileId,
        authenticated,
        available: authenticated,
        authenticationType: authenticated ? 'api_key' : null,
        reason: authenticated ? null : 'AUTH_MISSING',
        message: authenticated ? null : 'Pi 当前未检测到有效认证。',
      };
    });
    return { capabilities, availability, resolvedModels };
  }
}

export class FakeModelSettingsCatalogFactory implements ModelSettingsCatalogFactory {
  constructor(private readonly authenticated: (provider: string) => boolean = (provider) => provider !== 'missing-auth') {}
  async create(_profiles: readonly ModelProfileInput[]): Promise<ModelSettingsCatalog> {
    return new FakeModelSettingsCatalog(this.authenticated);
  }
}
