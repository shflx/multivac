import { DeepSeekWebProvider } from '../adapters/web/deepseek-web-provider.js';
import type { WebProvider } from '../modules/web/web-provider.js';

/** 显式启用并使用独立的网页服务密钥，不自动借用模型或其他实例的认证。 */
export function createWebProvider(environment: NodeJS.ProcessEnv): WebProvider | undefined {
  const provider = environment.MULTIVAC_WEB_PROVIDER?.trim();
  if (!provider) return undefined;
  if (provider !== 'deepseek') throw new Error('MULTIVAC_WEB_PROVIDER 当前仅支持 deepseek。');
  const key = environment.MULTIVAC_WEB_API_KEY?.trim();
  if (!key || key.length > 4096 || /\s/u.test(key)) throw new Error('启用网页能力须配置有效的 MULTIVAC_WEB_API_KEY。');
  return createNamedWebProvider(provider, key);
}

export function createNamedWebProvider(provider: string, key: string): WebProvider {
  if (provider === 'deepseek') return new DeepSeekWebProvider(key);
  throw new Error('网页服务商暂不支持。');
}
