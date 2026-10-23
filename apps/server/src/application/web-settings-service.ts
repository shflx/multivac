import type { UpdateWebSettings, WebSettings } from '@multivac/contracts';
import { WebAccessError, type WebProvider } from '../modules/web/web-provider.js';

/** 私有配置与凭据在同一锁内写入；秘密不进入公共配置或业务命令账本。 */
export interface PrivateWebSettings { revision: number; enabled: boolean; provider: 'deepseek'; apiKey: string | null; lastCommandId: string | null; lastKeyAction: 'keep' | 'replace' | 'clear' }
export const DEFAULT_WEB_SETTINGS: PrivateWebSettings = { revision: 0, enabled: false, provider: 'deepseek', apiKey: null, lastCommandId: null, lastKeyAction: 'keep' };
export interface WebSettingsStore {
  read(): Promise<PrivateWebSettings>;
  modify(operation: (current: PrivateWebSettings) => PrivateWebSettings): Promise<void>;
}
export class WebSettingsError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export class WebSettingsService {
  constructor(private readonly store: Promise<WebSettingsStore>, private readonly environmentProvider: WebProvider | undefined,
    private readonly createProvider: (provider: string, key: string) => WebProvider, private readonly changed: () => void) {}
  async get(): Promise<WebSettings> {
    if (this.environmentProvider) return { revision: 0, enabled: true, provider: 'deepseek', configured: true, source: 'environment', lastCommandId: null };
    const current = await (await this.store).read();
    return { revision: current.revision, enabled: current.enabled, provider: current.provider, configured: Boolean(current.apiKey), source: 'settings', lastCommandId: current.lastCommandId };
  }
  async update(input: UpdateWebSettings): Promise<WebSettings> {
    if (this.environmentProvider) throw new WebSettingsError('当前由环境变量配置，请先移除网页环境变量并重启服务，再使用界面配置。');
    if (input.apiKey && input.clearKey) throw new WebSettingsError('不能同时设置和移除 API Key。', 400);
    const keyAction = input.clearKey ? 'clear' : input.apiKey ? 'replace' : 'keep';
    await (await this.store).modify(current => {
      if (current.lastCommandId === input.commandId) {
        if (current.revision !== input.revision + 1 || current.enabled !== input.enabled || current.provider !== input.provider
          || current.lastKeyAction !== keyAction || (input.apiKey !== undefined && current.apiKey !== input.apiKey)) throw new WebSettingsError('同一保存命令的内容不一致，请核对当前配置。');
        return current;
      }
      if (current.revision !== input.revision) throw new WebSettingsError('网页配置已在别处修改，请刷新并核对后再保存。');
      const apiKey = input.clearKey ? null : input.apiKey ?? current.apiKey;
      if (input.enabled && !apiKey) throw new WebSettingsError('请先填写 API Key，或关闭网页能力后保存。', 400);
      return { revision: current.revision + 1, enabled: input.enabled, provider: input.provider, apiKey, lastCommandId: input.commandId, lastKeyAction: keyAction };
    });
    this.changed();
    return this.get();
  }
  /** 每次调用读取已保存的配置；关闭后新调用不向外发请求，已发出的请求沿用原配置。 */
  async resolve(): Promise<WebProvider> {
    if (this.environmentProvider) return this.environmentProvider;
    const current = await (await this.store).read();
    if (!current.enabled || !current.apiKey) throw new WebAccessError('网页能力尚未启用，请在设置 → 能力 → 网页中配置。');
    return this.createProvider(current.provider, current.apiKey);
  }
}
