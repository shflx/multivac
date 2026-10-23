import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { DEFAULT_WEB_SETTINGS, WebSettingsError, type PrivateWebSettings, type WebSettingsStore } from '../../application/web-settings-service.js';
import { createPiCredentialStore } from './pi-guarded-credential-store.js';
import { securePiAuthFile } from './pi-credential-security.js';

const Schema = Type.Object({ revision: Type.Integer({ minimum: 0 }), enabled: Type.Boolean(), provider: Type.Literal('deepseek'),
  apiKey: Type.Union([Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\s]+$' }), Type.Null()]),
  lastCommandId: Type.Union([Type.String(), Type.Null()]), lastKeyAction: Type.Union([Type.Literal('keep'), Type.Literal('replace'), Type.Literal('clear')]),
}, { additionalProperties: false });

/** 复用 Pi 原生凭据存储与文件锁，独立于模型/MCP 认证；文件权限为 0600。 */
export async function createWebSettingsStore(path: string): Promise<WebSettingsStore> {
  await securePiAuthFile(path);
  const store = await createPiCredentialStore(path);
  const decode = (credential: Awaited<ReturnType<typeof store.read>>): PrivateWebSettings => {
    if (!credential) return { ...DEFAULT_WEB_SETTINGS };
    try {
      if (credential.type !== 'api_key' || !credential.key) throw new Error();
      const data: unknown = JSON.parse(credential.key);
      if (!Check(Schema, data) || (data.enabled && !data.apiKey)) throw new Error();
      return data;
    } catch { throw new WebSettingsError('网页私有配置无法读取，请检查本实例凭据文件。', 503); }
  };
  return {
    async read() {
      try {
        let value = { ...DEFAULT_WEB_SETTINGS };
        // 只读锁内的原始凭据，避免 SDK 的缓存回退与环境/命令形式密钥解析。
        // 返回 undefined 表示不写入；损坏文件必须报错，不能继续使用旧密钥。
        await store.modify('multivac-web', async credential => { value = decode(credential); return undefined; }, { signal: AbortSignal.timeout(5000) });
        return value;
      }
      catch { throw new WebSettingsError('网页私有配置读取失败。', 503); }
    },
    async modify(operation) {
      let rejected: WebSettingsError | undefined;
      try {
        await store.modify('multivac-web', async credential => {
          try {
            const current = decode(credential), next = operation(current);
            if (next === current) return undefined;
            return { type: 'api_key', key: JSON.stringify(next) };
          } catch (error) { if (error instanceof WebSettingsError) rejected = error; throw error; }
        }, { signal: AbortSignal.timeout(5000) });
      } catch { throw rejected ?? new WebSettingsError('网页配置保存结果待核对，请刷新查看；不要自动重发密钥。', 503); }
    },
  };
}
