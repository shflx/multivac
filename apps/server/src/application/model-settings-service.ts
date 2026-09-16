import { createHash } from 'node:crypto';
import type {
  ModelAvailability,
  ModelProfileInput,
  ModelSettingsSnapshot,
  SaveModelSettings,
  SetDefaultModel,
} from '@multivac/contracts';
import {
  ModelSettingsCandidateError,
  ModelSettingsServiceError,
  type ModelSettingsCatalog,
  type ModelSettingsCatalogFactory,
  type ModelSettingsStore,
  type StoredModelSettingsState,
} from '../modules/model-settings/model-settings.js';

const MAX_COMMAND_HISTORY = 100;

interface ProfileAnalysis {
  profiles: ModelProfileInput[];
  invalidProfileIds: Set<string>;
}

interface CapturedModelSettings {
  state: StoredModelSettingsState;
  catalog: ModelSettingsCatalog;
  invalidProfileIds: Set<string>;
}

function normalizeProfile(profile: ModelProfileInput): ModelProfileInput {
  return {
    profileId: profile.profileId.trim(),
    displayName: profile.displayName.trim(),
    provider: profile.provider.trim(),
    modelId: profile.modelId.trim(),
    protocol: profile.protocol,
    endpoint: profile.endpoint?.trim() || null,
  };
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ModelSettingsServiceError(
      'MODEL_SETTINGS_CANDIDATE_INVALID',
      '端点必须是有效的 HTTP(S) URL。',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ModelSettingsServiceError(
      'MODEL_SETTINGS_CANDIDATE_INVALID',
      '端点必须是有效的 HTTP(S) URL。',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ModelSettingsServiceError(
      'MODEL_SETTINGS_CANDIDATE_INVALID',
      '端点 URL 不得包含用户信息、查询参数或片段。',
    );
  }
  return parsed.toString().replace(/\/$/u, '');
}

function validateChangedProfile(profile: ModelProfileInput): ModelProfileInput {
  const normalized = normalizeProfile(profile);
  if (
    !normalized.profileId || !normalized.displayName ||
    !normalized.provider || !normalized.modelId
  ) {
    throw new ModelSettingsServiceError(
      'MODEL_SETTINGS_CANDIDATE_INVALID',
      '模型配置字段不得为空。',
    );
  }
  if (normalized.endpoint !== null) {
    normalized.endpoint = normalizeEndpoint(normalized.endpoint);
  }
  return normalized;
}

function profileIsIndividuallySafe(profile: ModelProfileInput): boolean {
  try {
    validateChangedProfile(profile);
    return true;
  } catch {
    return false;
  }
}

function analyzeProfiles(profiles: readonly ModelProfileInput[]): ProfileAnalysis {
  const normalized = profiles.map(normalizeProfile);
  const invalidProfileIds = new Set<string>();
  const seenProfileIds = new Set<string>();

  for (const profile of normalized) {
    if (seenProfileIds.has(profile.profileId) || !profileIsIndividuallySafe(profile)) {
      invalidProfileIds.add(profile.profileId);
    }
    seenProfileIds.add(profile.profileId);
  }

  const byProvider = new Map<string, ModelProfileInput[]>();
  for (const profile of normalized) {
    if (invalidProfileIds.has(profile.profileId)) continue;
    const group = byProvider.get(profile.provider) ?? [];
    group.push(profile);
    byProvider.set(profile.provider, group);
  }
  for (const group of byProvider.values()) {
    const customProfiles = group.filter((profile) => profile.endpoint !== null);
    const mixesOfficialAndCustom = customProfiles.length > 0 && customProfiles.length !== group.length;
    const customConfiguration = new Set(
      customProfiles.map((profile) => `${profile.protocol}\0${profile.endpoint}`),
    );
    if (mixesOfficialAndCustom || customConfiguration.size > 1) {
      for (const profile of group) invalidProfileIds.add(profile.profileId);
    }
  }

  return { profiles: normalized, invalidProfileIds };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function configurationInvalidAvailability(profileId: string): ModelAvailability {
  return {
    profileId,
    authenticated: false,
    available: false,
    authenticationType: null,
    reason: 'CONFIGURATION_INVALID',
    message: '该旧配置不符合当前安全规则；请编辑并保存后再使用。',
  };
}

export class ModelSettingsService {
  private state: StoredModelSettingsState | undefined;
  private catalog: ModelSettingsCatalog | undefined;
  private invalidProfileIds = new Set<string>();
  private initializationFailed = false;
  private initializationFailureReported = false;
  private initializationPromise: Promise<void> | undefined;
  private mutationTail = Promise.resolve();

  constructor(
    private readonly store: ModelSettingsStore,
    private readonly catalogFactory: ModelSettingsCatalogFactory,
  ) {}

  /** 初始化失败只关闭模型设置能力，不阻塞助手和 HTTP 服务启动。 */
  async initialize(): Promise<void> {
    await this.tryInitialize();
  }

  async getSnapshot(): Promise<ModelSettingsSnapshot> {
    await this.ensureInitialized();
    return this.snapshotFrom(this.capture());
  }

  /** 仅确认未设置默认时允许基础配置；已设默认的任何失效都必须由用户修复。 */
  async getDefaultModelForNewSession(): Promise<{
    source: 'controlled';
    provider: string;
    modelId: string;
    protocol: ModelProfileInput['protocol'];
    endpoint: string | null;
    resolvedEndpoint: string;
    profileId: string;
  } | null> {
    try {
      if (this.initializationPromise) await this.initializationPromise;
      if (this.state?.defaultProfileId === null) return null;
      await this.ensureInitialized();
      const captured = this.capture();
      const defaultProfileId = captured.state.defaultProfileId;
      if (defaultProfileId === null) return null;
      if (captured.invalidProfileIds.has(defaultProfileId)) throw new Error('invalid default');
      const profile = captured.state.profiles.find(
        (candidate) => candidate.profileId === defaultProfileId,
      );
      if (!profile) throw new Error('missing default');
      const inspection = await captured.catalog.inspect([profile]);
      const availability = inspection.availability.find((item) => item.profileId === profile.profileId);
      const resolved = inspection.resolvedModels.get(profile.profileId);
      if (!availability?.authenticated || !availability.available || !resolved ||
        resolved.protocol !== profile.protocol) throw new Error('unavailable default');
      return {
        source: 'controlled',
        provider: profile.provider,
        modelId: profile.modelId,
        protocol: profile.protocol,
        endpoint: profile.endpoint,
        resolvedEndpoint: normalizeEndpoint(resolved.endpoint),
        profileId: profile.profileId,
      };
    } catch {
      throw new ModelSettingsServiceError(
        'DEFAULT_MODEL_UNAVAILABLE',
        '全局默认模型当前无法使用；请修复模型配置或认证后重试，不会自动切换模型。',
      );
    }
  }

  save(command: SaveModelSettings): Promise<ModelSettingsSnapshot> {
    return this.serializeMutation(async () => {
      await this.ensureInitialized();
      const state = this.requireState();
      const profile = validateChangedProfile(command.profile);
      const commandFingerprint = fingerprint({ kind: 'save', profile });
      if (this.replay(command.commandId, commandFingerprint)) {
        return this.snapshotFrom(this.capture());
      }
      this.assertRevision(command.revision);

      const existingIndex = state.profiles.findIndex(
        (candidate) => candidate.profileId === profile.profileId,
      );
      const nextProfiles = existingIndex === -1
        ? [...state.profiles, profile]
        : state.profiles.map((candidate, index) => index === existingIndex ? profile : candidate);
      const analysis = analyzeProfiles(nextProfiles);
      if (analysis.invalidProfileIds.has(profile.profileId)) {
        throw new ModelSettingsServiceError(
          'MODEL_SETTINGS_CANDIDATE_INVALID',
          '变更后的模型配置与同 Provider 的协议或端点不一致。',
        );
      }
      const safeProfiles = analysis.profiles.filter(
        (candidate) => !analysis.invalidProfileIds.has(candidate.profileId),
      );
      const candidateCatalog = await this.createCandidate(safeProfiles, [profile.profileId]);
      const nextState = this.nextState(
        { profiles: analysis.profiles },
        command.commandId,
        commandFingerprint,
      );
      await this.persist(nextState);
      this.state = nextState;
      this.catalog = candidateCatalog;
      this.invalidProfileIds = analysis.invalidProfileIds;
      return this.snapshotFrom(this.capture());
    });
  }

  setDefault(command: SetDefaultModel): Promise<ModelSettingsSnapshot> {
    return this.serializeMutation(async () => {
      await this.ensureInitialized();
      const state = this.requireState();
      const commandFingerprint = fingerprint({ kind: 'set-default', profileId: command.profileId });
      if (this.replay(command.commandId, commandFingerprint)) {
        return this.snapshotFrom(this.capture());
      }
      this.assertRevision(command.revision);
      if (!state.profiles.some((profile) => profile.profileId === command.profileId)) {
        throw new ModelSettingsServiceError('INVALID_REQUEST', '指定的模型配置不存在。');
      }
      const snapshot = await this.snapshotFrom(this.capture());
      const availability = snapshot.availability.find(
        (candidate) => candidate.profileId === command.profileId,
      );
      if (!availability?.authenticated || !availability.available) {
        throw new ModelSettingsServiceError(
          'DEFAULT_MODEL_UNAVAILABLE',
          '仅可将 Pi 当前判定已认证且可用的模型设为默认。',
        );
      }
      const nextState = this.nextState(
        { defaultProfileId: command.profileId },
        command.commandId,
        commandFingerprint,
      );
      await this.persist(nextState);
      this.state = nextState;
      return this.snapshotFrom(this.capture());
    });
  }

  /** 仅由显式启用的 E2E 控制路由调用。 */
  replaceStateForTest(state: StoredModelSettingsState): Promise<void> {
    return this.serializeMutation(async () => {
      const analysis = analyzeProfiles(state.profiles);
      const safeProfiles = analysis.profiles.filter(
        (profile) => !analysis.invalidProfileIds.has(profile.profileId),
      );
      const catalog = await this.catalogFactory.create(safeProfiles, { strictProfileIds: [] });
      const nextState = { ...structuredClone(state), profiles: analysis.profiles };
      await this.store.save(nextState);
      this.state = nextState;
      this.catalog = catalog;
      this.invalidProfileIds = analysis.invalidProfileIds;
      this.initializationFailed = false;
      this.initializationFailureReported = false;
    });
  }

  private async tryInitialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      let loaded: StoredModelSettingsState | undefined;
      try {
        loaded = await this.store.load();
        const analysis = analyzeProfiles(loaded.profiles);
        const safeProfiles = analysis.profiles.filter(
          (profile) => !analysis.invalidProfileIds.has(profile.profileId),
        );
        const catalog = await this.catalogFactory.create(safeProfiles, { strictProfileIds: [] });
        this.state = { ...loaded, profiles: analysis.profiles };
        this.catalog = catalog;
        this.invalidProfileIds = analysis.invalidProfileIds;
        this.initializationFailed = false;
        this.initializationFailureReported = false;
      } catch {
        // 配置读取已成功时保留“未设默认”的确定事实；目录故障不能伪造一个失效默认。
        this.state = loaded;
        this.catalog = undefined;
        this.invalidProfileIds = new Set();
        this.initializationFailed = true;
      }
    })().finally(() => {
      this.initializationPromise = undefined;
    });
    return this.initializationPromise;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.state && this.catalog) return;
    if (this.initializationFailed && !this.initializationFailureReported) {
      this.initializationFailureReported = true;
      throw new ModelSettingsServiceError(
        'MODEL_SETTINGS_UNAVAILABLE',
        '模型设置暂时无法加载，请稍后重试。',
      );
    }
    await this.tryInitialize();
    if (!this.state || !this.catalog) {
      throw new ModelSettingsServiceError(
        'MODEL_SETTINGS_UNAVAILABLE',
        '模型设置暂时无法加载，请稍后重试。',
      );
    }
  }

  private capture(): CapturedModelSettings {
    return {
      state: structuredClone(this.requireState()),
      catalog: this.requireCatalog(),
      invalidProfileIds: new Set(this.invalidProfileIds),
    };
  }

  private async snapshotFrom(captured: CapturedModelSettings): Promise<ModelSettingsSnapshot> {
    const safeProfiles = captured.state.profiles.filter(
      (profile) => !captured.invalidProfileIds.has(profile.profileId),
    );
    const inspection = await captured.catalog.inspect(safeProfiles);
    const inspectedAvailability = new Map(
      inspection.availability.map((availability) => [availability.profileId, availability]),
    );
    return {
      revision: captured.state.revision,
      profiles: captured.state.profiles.map((profile) => {
        const invalid = captured.invalidProfileIds.has(profile.profileId);
        return {
          ...profile,
          endpoint: invalid ? null : profile.endpoint,
          capabilities: invalid ? null : inspection.capabilities.get(profile.profileId) ?? null,
        };
      }),
      defaultProfileId: captured.state.defaultProfileId,
      availability: captured.state.profiles.map((profile) =>
        captured.invalidProfileIds.has(profile.profileId)
          ? configurationInvalidAvailability(profile.profileId)
          : inspectedAvailability.get(profile.profileId) ?? {
              profileId: profile.profileId,
              authenticated: false,
              available: false,
              authenticationType: null,
              reason: 'RUNTIME_ERROR',
              message: 'Pi 当前无法读取该模型的可用状态。',
            }),
    };
  }

  private nextState(
    change: Partial<Pick<StoredModelSettingsState, 'profiles' | 'defaultProfileId'>>,
    commandId: string,
    commandFingerprint: string,
  ): StoredModelSettingsState {
    const state = this.requireState();
    const revision = state.revision + 1;
    return {
      ...state,
      ...change,
      revision,
      commands: [
        ...state.commands,
        { commandId, fingerprint: commandFingerprint, resultRevision: revision },
      ].slice(-MAX_COMMAND_HISTORY),
    };
  }

  private replay(commandId: string, commandFingerprint: string): boolean {
    const existing = this.requireState().commands.find((command) => command.commandId === commandId);
    if (!existing) return false;
    if (existing.fingerprint !== commandFingerprint) {
      throw new ModelSettingsServiceError(
        'MODEL_SETTINGS_COMMAND_ID_CONFLICT',
        '命令 ID 已用于不同的模型设置操作。',
      );
    }
    return true;
  }

  private assertRevision(revision: number): void {
    if (revision !== this.requireState().revision) {
      throw new ModelSettingsServiceError(
        'MODEL_SETTINGS_CONFLICT',
        '模型设置已被其他页面更新，请重新加载后再试。',
      );
    }
  }

  private async createCandidate(
    profiles: readonly ModelProfileInput[],
    strictProfileIds: readonly string[],
  ): Promise<ModelSettingsCatalog> {
    try {
      return await this.catalogFactory.create(profiles, { strictProfileIds });
    } catch (error) {
      if (error instanceof ModelSettingsServiceError) throw error;
      if (error instanceof ModelSettingsCandidateError) {
        throw new ModelSettingsServiceError('MODEL_SETTINGS_CANDIDATE_INVALID', error.message);
      }
      throw new ModelSettingsServiceError(
        'MODEL_SETTINGS_CANDIDATE_INVALID',
        '候选模型配置未通过 Pi 校验，原配置已保留。',
      );
    }
  }

  private async persist(state: StoredModelSettingsState): Promise<void> {
    try {
      await this.store.save(state);
    } catch {
      throw new ModelSettingsServiceError(
        'MODEL_SETTINGS_UNAVAILABLE',
        '模型设置保存失败，原配置已保留。',
      );
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireState(): StoredModelSettingsState {
    if (!this.state) {
      throw new ModelSettingsServiceError('MODEL_SETTINGS_UNAVAILABLE', '模型设置尚未初始化。');
    }
    return this.state;
  }

  private requireCatalog(): ModelSettingsCatalog {
    if (!this.catalog) {
      throw new ModelSettingsServiceError('MODEL_SETTINGS_UNAVAILABLE', '模型设置尚未初始化。');
    }
    return this.catalog;
  }
}
