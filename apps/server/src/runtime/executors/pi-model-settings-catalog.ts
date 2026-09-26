import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ModelRuntime,
  getAgentDir,
  type CreateModelRuntimeOptions,
} from '@earendil-works/pi-coding-agent';
import {
  modelReasoningOverride,
  type ModelAvailability,
  type ModelCapabilities,
  type ModelProfileInput,
} from '@multivac/contracts';
import {
  ModelSettingsCandidateError,
  type ModelCatalogInspection,
  type ModelSettingsCatalog,
  type ModelSettingsCatalogFactory,
} from '../../modules/model-settings/model-settings.js';
import { resolvePiRequestEndpoint, type PiModelAuthRuntime } from './pi-model-auth.js';
import { securePiAuthFile } from './pi-credential-security.js';

interface PiModelView {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Partial<Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;
}

interface PiModelRuntimeView extends PiModelAuthRuntime<PiModelView> {
  getModel(provider: string, modelId: string): PiModelView | undefined;
  getAvailable(providerId?: string, options?: { signal?: AbortSignal }): Promise<readonly PiModelView[]>;
  checkAuth(
    providerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ source?: string; type: 'api_key' | 'oauth' } | undefined>;
  refresh?: ModelRuntime['refresh'];
}

/** 新模型仅通过 Pi 官方目录解析；SDK 缓存提供离线回退，不按品牌猜测能力。 */
export async function refreshPiModelCatalog(
  runtime: Pick<PiModelRuntimeView, 'getModel' | 'refresh'>,
  profiles: readonly ModelProfileInput[],
  signal?: AbortSignal,
): Promise<void> {
  const providers = [...new Set(profiles.filter((profile) => !runtime.getModel(profile.provider, profile.modelId))
    .map((profile) => profile.provider))];
  if (!providers.length || !runtime.refresh || process.env.PI_OFFLINE !== undefined) return;
  const deadline = AbortSignal.timeout(4_000);
  await runtime.refresh({ providers, allowNetwork: true,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
}

type PiAuthView = Awaited<ReturnType<PiModelRuntimeView['checkAuth']>> | 'error';

export function mapPiModelCapabilities(
  model: PiModelView,
  source: ModelCapabilities['source'] = 'pi-catalog',
): ModelCapabilities {
  return {
    source,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning,
  };
}

function modelKey(provider: string, modelId: string, protocol: string): string {
  return `${provider}\0${modelId}\0${protocol}`;
}

function safeUnavailable(
  profileId: string,
  input: Omit<ModelAvailability, 'profileId'>,
): ModelAvailability {
  return { profileId, ...input };
}

class PiModelSettingsCatalog implements ModelSettingsCatalog {
  constructor(
    private readonly runtime: PiModelRuntimeView,
    private readonly catalogCapabilityKeys: ReadonlySet<string>,
  ) {}

  async inspect(profiles: readonly ModelProfileInput[]): Promise<ModelCatalogInspection> {
    const capabilities = new Map<string, ModelCapabilities | null>();
    const resolvedModels = new Map<
      string,
      { protocol: ModelProfileInput['protocol']; endpoint: string }
    >();
    const runtimeModels = new Map<string, PiModelView>();
    for (const profile of profiles) {
      const model = this.runtime.getModel(profile.provider, profile.modelId);
      if (model?.api === profile.protocol) {
        runtimeModels.set(profile.profileId, model);
      }
      capabilities.set(
        profile.profileId,
        model?.api === profile.protocol
          ? mapPiModelCapabilities(
              model,
              this.catalogCapabilityKeys.has(
                modelKey(profile.provider, profile.modelId, profile.protocol),
              )
                ? 'pi-catalog'
                : 'pi-default',
            )
          : null,
      );
    }

    const providers = [...new Set(profiles.map((profile) => profile.provider))];
    const providerInspections = await Promise.all(
      providers.map(async (provider) => {
        const signal = AbortSignal.timeout(5_000);
        try {
          const [available, auth] = await Promise.all([
            this.runtime.getAvailable(provider, { signal }),
            this.runtime.checkAuth(provider, { signal }),
          ]);
          return { provider, available, auth: auth as PiAuthView };
        } catch {
          return { provider, available: [] as readonly PiModelView[], auth: 'error' as const };
        }
      }),
    );
    const authByProvider = new Map<string, PiAuthView>(
      providerInspections.map(({ provider, auth }) => [provider, auth]),
    );
    const availableKeys = new Set(
      providerInspections.flatMap(({ available }) =>
        available.map((model) => modelKey(model.provider, model.id, model.api))),
    );
    const endpointErrors = new Set<string>();
    await Promise.all(profiles.map(async (profile) => {
      const model = runtimeModels.get(profile.profileId);
      if (!model || !authByProvider.get(profile.provider) ||
        authByProvider.get(profile.provider) === 'error') return;
      try {
        const resolved = await resolvePiRequestEndpoint(this.runtime, model, profile.endpoint);
        if (!resolved || resolved.mode !== 'fixed') { endpointErrors.add(profile.profileId); return; }
        resolvedModels.set(profile.profileId, { protocol: profile.protocol, endpoint: resolved.endpoint });
      } catch {
        endpointErrors.add(profile.profileId);
      }
    }));

    const availability = profiles.map((profile): ModelAvailability => {
      const key = modelKey(profile.provider, profile.modelId, profile.protocol);
      const model = runtimeModels.get(profile.profileId);
      if (!model) {
        return safeUnavailable(profile.profileId, {
          authenticated: false,
          available: false,
          authenticationType: null,
          reason: 'MODEL_NOT_FOUND',
          message: 'Pi 当前目录中未找到该模型。',
        });
      }
      const auth = authByProvider.get(profile.provider);
      if (auth === 'error') {
        return safeUnavailable(profile.profileId, {
          authenticated: false,
          available: false,
          authenticationType: null,
          reason: 'RUNTIME_ERROR',
          message: 'Pi 当前无法读取该模型的可用状态。',
        });
      }
      if (!auth) {
        return safeUnavailable(profile.profileId, {
          authenticated: false,
          available: false,
          authenticationType: null,
          reason: 'AUTH_MISSING',
          message: 'Pi 当前未检测到有效认证。',
        });
      }
      if (endpointErrors.has(profile.profileId)) {
        return safeUnavailable(profile.profileId, {
          authenticated: true,
          available: false,
          authenticationType: auth.type,
          reason: 'CONFIGURATION_INVALID',
          message: 'Pi 认证解析后无法保证该模型端点安全且符合配置。',
        });
      }
      if (!availableKeys.has(key)) {
        return safeUnavailable(profile.profileId, {
          authenticated: true,
          available: false,
          authenticationType: auth.type,
          reason: 'MODEL_UNAVAILABLE',
          message: 'Pi 已检测到认证，但当前未将该模型判定为可用。',
        });
      }
      return {
        profileId: profile.profileId,
        authenticated: true,
        available: true,
        authenticationType: auth.type,
        reason: null,
        message: null,
      };
    });

    return { capabilities, availability, resolvedModels };
  }
}

export function buildPiModelsConfig(
  profiles: readonly ModelProfileInput[],
  baseRuntime: PiModelRuntimeView,
) {
  const providers = Object.create(null) as Record<string, {
    baseUrl?: string;
    api?: ModelProfileInput['protocol'];
    modelOverrides?: Record<string, { reasoning: boolean }>;
    models?: Array<{ id: string; name: string; reasoning?: boolean; input?: ('text' | 'image')[];
      contextWindow?: number; maxTokens?: number; cost?: PiModelView['cost'];
      thinkingLevelMap?: PiModelView['thinkingLevelMap']; compat?: { forceAdaptiveThinking: boolean } }>;
  }>;
  const catalogCapabilityKeys = new Set<string>();
  for (const profile of profiles) {
    const key = modelKey(profile.provider, profile.modelId, profile.protocol);
    const baseModel = baseRuntime.getModel(profile.provider, profile.modelId);
    const knownModel = baseModel?.api === profile.protocol;
    if (baseModel) catalogCapabilityKeys.add(key);
    // 手动设置的推理能力以 Pi modelOverrides 覆盖目录与自定义模型的默认值；
    // 保存校验、会话启动、恢复与可用性检查都经此构建，推理能力判断一致。
    const reasoning = modelReasoningOverride(profile.reasoning);
    if (reasoning !== undefined) {
      const provider = providers[profile.provider] ??= {};
      (provider.modelOverrides ??= {})[profile.modelId] = { reasoning };
    }
    if (profile.endpoint === null) continue;
    const current = providers[profile.provider] ??= {};
    current.baseUrl ??= profile.endpoint;
    if (!knownModel) {
      current.api = profile.protocol;
      current.models ??= [];
      if (!current.models.some((model) => model.id === profile.modelId)) {
        current.models.push({ id: profile.modelId, name: profile.displayName,
          ...(baseModel ? {
            reasoning: baseModel.reasoning, input: [...baseModel.input], contextWindow: baseModel.contextWindow,
            maxTokens: baseModel.maxTokens,
            ...(baseModel.cost ? { cost: { ...baseModel.cost } } : {}),
            ...(baseModel.thinkingLevelMap ? { thinkingLevelMap: { ...baseModel.thinkingLevelMap } } : {}),
            // DeepSeek 的 Anthropic 接口忽略 budget_tokens，使用 SDK adaptive effort 传参。
            ...(profile.provider === 'deepseek' && profile.protocol === 'anthropic-messages' && baseModel.reasoning
              ? { compat: { forceAdaptiveThinking: true } } : {}),
          } : {}),
        });
      }
    }
  }
  return { config: { providers }, catalogCapabilityKeys };
}

export interface PiModelSettingsCatalogFactoryOptions {
  authPath?: string;
  candidateRoot: string;
  createRuntime?: (options: CreateModelRuntimeOptions) => Promise<PiModelRuntimeView>;
}

/** 每次保存先用临时、无凭据的 models.json 创建 Pi runtime，成功后才交给服务替换。 */
export class PiModelSettingsCatalogFactory implements ModelSettingsCatalogFactory {
  private readonly createRuntime: NonNullable<PiModelSettingsCatalogFactoryOptions['createRuntime']>;

  constructor(private readonly options: PiModelSettingsCatalogFactoryOptions) {
    this.createRuntime = options.createRuntime ?? (async (runtimeOptions) => {
      await securePiAuthFile(runtimeOptions.authPath ?? join(getAgentDir(), 'auth.json'));
      return ModelRuntime.create(runtimeOptions);
    });
  }

  async create(
    profiles: readonly ModelProfileInput[],
    options: { strictProfileIds?: readonly string[] } = {},
  ): Promise<ModelSettingsCatalog> {
    await mkdir(this.options.candidateRoot, { recursive: true });
    const directory = await mkdtemp(join(this.options.candidateRoot, 'candidate-'));
    try {
      const baseRuntime = await this.createRuntimeForConfig(directory, 'base', { providers: {} });
      await refreshPiModelCatalog(baseRuntime, profiles);
      const { config, catalogCapabilityKeys } = buildPiModelsConfig(profiles, baseRuntime);
      const runtime = await this.createRuntimeForConfig(directory, 'candidate', config);
      const strictProfileIds = new Set(options.strictProfileIds ?? []);
      for (const profile of profiles) {
        if (!strictProfileIds.has(profile.profileId)) continue;
        const model = runtime.getModel(profile.provider, profile.modelId);
        const baseModel = baseRuntime.getModel(profile.provider, profile.modelId);
        if (
          !model || model.api !== profile.protocol ||
          (profile.endpoint === null && baseModel?.api !== profile.protocol)
        ) {
          throw new ModelSettingsCandidateError(
            'Provider、模型 ID 或协议未通过 Pi 目录校验。',
          );
        }
        try {
          await resolvePiRequestEndpoint(runtime, model, profile.endpoint);
        } catch {
          throw new ModelSettingsCandidateError('Pi 认证解析后无法保证自定义端点生效。');
        }
      }
      return new PiModelSettingsCatalog(runtime, catalogCapabilityKeys);
    } catch (error) {
      if (error instanceof ModelSettingsCandidateError) throw error;
      throw new ModelSettingsCandidateError();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async createRuntimeForConfig(
    directory: string,
    name: string,
    config: object,
  ): Promise<PiModelRuntimeView> {
    const modelsPath = join(directory, `${name}-models.json`);
    await writeFile(modelsPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return this.createRuntime({
      ...(this.options.authPath ? { authPath: this.options.authPath } : {}),
      modelsPath,
      modelsStorePath: join(this.options.authPath ? dirname(this.options.authPath) : getAgentDir(), 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: true,
      signal: AbortSignal.timeout(5_000),
    });
  }
}
