import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getAgentDir, ModelRuntime, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import type { ModelProfileInput } from '@multivac/contracts';
import { ModelAccessError, type ModelAccessBackend } from '../../modules/model-settings/model-access.js';
import { buildPiModelsConfig } from './pi-model-settings-catalog.js';
import { resolvePiRequestEndpoint } from './pi-model-auth.js';
import { securePiAuthFile } from './pi-credential-security.js';
import { supportsSingleApiKeyInput } from './pi-api-key-capabilities.js';
import { createGuardedPiCredentialStore, isPiCredentialConflict } from './pi-guarded-credential-store.js';
export { securePiAuthFile } from './pi-credential-security.js';


/** Pi 的配置值会解释 !命令/$环境引用；按其转义规则存储一次性输入的字面 Key。 */
export function piLiteralApiKey(key: string): string {
  const escaped = key.replace(/\$/gu, () => '$$');
  return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

export interface PiModelAccessBackendOptions {
  authPath?: string;
  createRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
}

export class PiModelAccessBackend implements ModelAccessBackend {
  readonly authPath: string;
  private readonly createRuntime: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  constructor(options: PiModelAccessBackendOptions = {}) {
    this.authPath = options.authPath ?? join(getAgentDir(), 'auth.json');
    this.createRuntime = options.createRuntime ?? ModelRuntime.create;
  }
  async credentialVersion(): Promise<string> {
    try {
      const value = await stat(this.authPath, { bigint: true });
      return `${value.dev}:${value.ino}:${value.mtimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw new ModelAccessError('ACCESS_UNAVAILABLE');
    }
  }
  async credentialInfo(profile: ModelProfileInput, signal: AbortSignal) {
    return this.withRuntime(profile, signal, async (runtime) => {
      const stored = (await runtime.listCredentials({ signal })).find((entry) => entry.providerId === profile.provider);
      return {
        storedApiKey: stored?.type === 'api_key',
        configurable: stored?.type !== 'oauth' && supportsSingleApiKeyInput(profile.provider) &&
          Boolean(runtime.getProvider(profile.provider)?.auth.apiKey?.login),
      };
    });
  }
  async configure(profile: ModelProfileInput, apiKey: string, signal: AbortSignal, version?: string): Promise<void> {
    await securePiAuthFile(this.authPath);
    const baseline = version ?? await this.credentialVersion();
    const credentials = await createGuardedPiCredentialStore(this.authPath, baseline, () => this.credentialVersion());
    await this.withRuntime(profile, signal, async (runtime) => {
      const existing = (await runtime.listCredentials({ signal })).find((entry) => entry.providerId === profile.provider);
      if (existing?.type === 'oauth' || !supportsSingleApiKeyInput(profile.provider) ||
        !runtime.getProvider(profile.provider)?.auth.apiKey?.login) {
        if (existing?.type === 'oauth' && await this.credentialVersion() !== baseline) throw new ModelAccessError('ACCESS_CONFLICT');
        throw new ModelAccessError('CREDENTIAL_UNSUPPORTED');
      }
      let prompts = 0;
      try {
        // SDK 的 api_key 入口只完成原生 CredentialStore 持久化，不执行 OAuth 登录。
        await runtime.login(profile.provider, 'api_key', {
          signal,
          prompt: async (prompt) => {
            if (prompt.type !== 'secret' || ++prompts !== 1) throw new ModelAccessError('CREDENTIAL_UNSUPPORTED');
            return piLiteralApiKey(apiKey);
          },
          notify: () => {},
        });
      } catch (error) {
        if (isPiCredentialConflict(error)) throw new ModelAccessError('ACCESS_CONFLICT');
        if (error instanceof ModelAccessError) throw error;
        throw new ModelAccessError('CREDENTIAL_RESULT_UNKNOWN');
      }
    }, credentials);
  }
  async revoke(profile: ModelProfileInput, signal: AbortSignal, version?: string): Promise<void> {
    await securePiAuthFile(this.authPath);
    const baseline = version ?? await this.credentialVersion();
    const credentials = await createGuardedPiCredentialStore(this.authPath, baseline, () => this.credentialVersion());
    await this.withRuntime(profile, signal, async (runtime) => {
      const existing = (await runtime.listCredentials({ signal })).find((entry) => entry.providerId === profile.provider);
      if (existing?.type === 'oauth') throw new ModelAccessError(await this.credentialVersion() !== baseline ? 'ACCESS_CONFLICT' : 'CREDENTIAL_UNSUPPORTED');
      if (!existing) return;
      try { await runtime.logout(profile.provider, { signal }); }
      catch (error) { throw new ModelAccessError(isPiCredentialConflict(error) ? 'ACCESS_CONFLICT' : 'CREDENTIAL_RESULT_UNKNOWN'); }
    }, credentials);
  }
  async check(profile: ModelProfileInput, signal: AbortSignal): Promise<void> {
    await this.withRuntime(profile, signal, async (runtime) => {
      const model = runtime.getModel(profile.provider, profile.modelId);
      if (!model || model.api !== profile.protocol) throw new ModelAccessError('CHECK_MODEL_UNAVAILABLE');
      const auth = await runtime.checkAuth(profile.provider, { signal });
      if (auth?.type !== 'api_key') throw new ModelAccessError('CHECK_AUTH_MISSING');
      const resolved = await resolvePiRequestEndpoint(runtime, model, profile.endpoint, 'controlled', signal);
      if (!resolved || resolved.mode !== 'fixed') throw new ModelAccessError('CHECK_MODEL_UNAVAILABLE');
      const available = await runtime.getAvailable(profile.provider, { signal });
      if (!available.some((entry) => entry.id === model.id && entry.api === model.api)) {
        throw new ModelAccessError('CHECK_MODEL_UNAVAILABLE');
      }
      // 请求、协议适配及认证都交给 Pi；不把生成内容、usage 或上游错误放进状态。
      const result = await runtime.completeSimple(model, {
        messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }],
      }, { signal, timeoutMs: 20_000, maxRetries: 0, maxTokens: 16 });
      if (signal.aborted) throw signal.reason;
      if (!['stop', 'length', 'toolUse'].includes(result.stopReason)) throw new ModelAccessError('CHECK_FAILED');
    });
    signal.throwIfAborted();
  }
  private async withRuntime<T>(
    profile: ModelProfileInput, signal: AbortSignal, operation: (runtime: ModelRuntime) => Promise<T>,
    credentials?: CreateModelRuntimeOptions['credentials'],
  ): Promise<T> {
    await securePiAuthFile(this.authPath);
    const directory = await mkdtemp(join(tmpdir(), 'multivac-access-'));
    try {
      const basePath = join(directory, 'base.json');
      await writeFile(basePath, '{"providers":{}}', { mode: 0o600 });
      const base = await this.createRuntime({ ...(credentials ? { credentials } : {}), authPath: this.authPath, modelsPath: basePath,
        modelsStorePath: join(directory, 'base-store.json'), signal, allowModelNetwork: false });
      const { config } = buildPiModelsConfig([profile], base);
      const candidate = join(directory, 'candidate.json');
      await writeFile(candidate, JSON.stringify(config), { mode: 0o600 });
      const runtime = await this.createRuntime({ ...(credentials ? { credentials } : {}), authPath: this.authPath, modelsPath: candidate,
        modelsStorePath: join(directory, 'candidate-store.json'), signal, allowModelNetwork: false });
      return await operation(runtime);
    } finally {
      try { await securePiAuthFile(this.authPath); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}
