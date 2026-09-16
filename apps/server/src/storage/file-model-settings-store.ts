import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ModelProfileInputSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import type {
  ModelSettingsStore,
  StoredModelSettingsCommand,
  StoredModelSettingsState,
} from '../modules/model-settings/model-settings.js';

const EMPTY_STATE: StoredModelSettingsState = {
  revision: 0,
  profiles: [],
  defaultProfileId: null,
  commands: [],
};

function isCommand(value: unknown): value is StoredModelSettingsCommand {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.commandId === 'string' &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.resultRevision === 'number' &&
    Number.isInteger(candidate.resultRevision) && candidate.resultRevision >= 0;
}

function parseState(value: unknown): StoredModelSettingsState {
  if (
    typeof value !== 'object' || value === null ||
    !('revision' in value) || !Number.isInteger(value.revision) || Number(value.revision) < 0 ||
    !('profiles' in value) || !Array.isArray(value.profiles) ||
    !('defaultProfileId' in value) ||
    !(value.defaultProfileId === null || typeof value.defaultProfileId === 'string') ||
    !('commands' in value) || !Array.isArray(value.commands)
  ) {
    throw new Error('模型设置文件结构无效。');
  }
  if (!value.profiles.every((profile) => Check(ModelProfileInputSchema, profile))) {
    throw new Error('模型设置文件包含无效 profile。');
  }
  if (!value.commands.every(isCommand)) {
    throw new Error('模型设置文件包含无效幂等记录。');
  }
  const profileIds = new Set(value.profiles.map((profile) => profile.profileId));
  if (profileIds.size !== value.profiles.length) {
    throw new Error('模型设置文件包含重复 profile ID。');
  }
  if (value.defaultProfileId !== null && !profileIds.has(value.defaultProfileId)) {
    throw new Error('模型设置文件的默认引用不存在。');
  }
  const commandIds = new Set(value.commands.map((command) => command.commandId));
  if (commandIds.size !== value.commands.length) {
    throw new Error('模型设置文件包含重复命令 ID。');
  }
  return {
    revision: value.revision as number,
    profiles: structuredClone(value.profiles),
    defaultProfileId: value.defaultProfileId,
    commands: value.commands.map((command) => ({
      commandId: command.commandId,
      fingerprint: command.fingerprint,
      resultRevision: command.resultRevision,
    })),
  };
}

export interface FileModelSettingsStoreOptions {
  initialState?: StoredModelSettingsState;
}

/** 模型元数据使用单一受控文件；凭据和 Pi 动态目录均不进入该文件。 */
export class FileModelSettingsStore implements ModelSettingsStore {
  private readonly initialState: StoredModelSettingsState;

  constructor(
    private readonly path: string,
    options: FileModelSettingsStoreOptions = {},
  ) {
    this.initialState = parseState(options.initialState ?? EMPTY_STATE);
  }

  async load(): Promise<StoredModelSettingsState> {
    try {
      return parseState(JSON.parse(await readFile(this.path, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(this.initialState);
      }
      throw error;
    }
  }

  async save(state: StoredModelSettingsState): Promise<void> {
    const validated = parseState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
