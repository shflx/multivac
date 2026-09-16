import type {
  ModelAvailability,
  ModelCapabilities,
  ModelProfileInput,
} from '@multivac/contracts';
import type {
  ModelSettingsCatalog,
  ModelSettingsCatalogFactory,
} from '../../modules/model-settings/model-settings.js';

const FAKE_CAPABILITIES: ModelCapabilities = {
  source: 'pi-catalog',
  input: ['text', 'image'],
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  reasoning: true,
};

class FakeModelSettingsCatalog implements ModelSettingsCatalog {
  constructor(private readonly authenticated: (provider: string) => boolean) {}
  async inspect(profiles: readonly ModelProfileInput[]) {
    const capabilities = new Map(
      profiles.map((profile) => [profile.profileId, FAKE_CAPABILITIES] as const),
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
