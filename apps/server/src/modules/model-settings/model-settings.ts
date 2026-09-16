import type {
  ModelAvailability,
  ModelCapabilities,
  ModelProfileInput,
  ModelSettingsApiErrorCode,
} from '@multivac/contracts';

export interface StoredModelSettingsCommand {
  commandId: string;
  fingerprint: string;
  resultRevision: number;
}

export interface StoredModelSettingsState {
  revision: number;
  profiles: ModelProfileInput[];
  defaultProfileId: string | null;
  commands: StoredModelSettingsCommand[];
}

export interface ModelSettingsStore {
  load(): Promise<StoredModelSettingsState>;
  save(state: StoredModelSettingsState): Promise<void>;
}

export interface ModelCatalogInspection {
  capabilities: Map<string, ModelCapabilities | null>;
  availability: ModelAvailability[];
  resolvedModels: Map<string, { protocol: ModelProfileInput['protocol']; endpoint: string }>;
}

export interface ModelSettingsCatalog {
  inspect(profiles: readonly ModelProfileInput[]): Promise<ModelCatalogInspection>;
}

export interface ModelSettingsCatalogFactory {
  create(
    profiles: readonly ModelProfileInput[],
    options?: { strictProfileIds?: readonly string[] },
  ): Promise<ModelSettingsCatalog>;
}

export class ModelSettingsServiceError extends Error {
  constructor(
    readonly code: ModelSettingsApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelSettingsServiceError';
  }
}

export class ModelSettingsCandidateError extends Error {
  constructor(message = '候选模型配置未通过 Pi 校验。') {
    super(message);
    this.name = 'ModelSettingsCandidateError';
  }
}
