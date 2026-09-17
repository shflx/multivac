import type { ModelProfileInput } from '@multivac/contracts';
import { ModelAccessError, type ModelAccessBackend } from '../../modules/model-settings/model-access.js';
import { supportsSingleApiKeyInput } from './pi-api-key-capabilities.js';

/** 仅在显式 Fake 模式使用，不保存测试输入 Key，只维护认证标记与可控请求。 */
export class FakeModelAccessBackend implements ModelAccessBackend {
  private readonly stored = new Set<string>();
  private version = 0;
  private failVersionRead = false;
  behavior: 'pass' | 'fail' | 'wait' | 'wait-read-failure' = 'pass';
  clockOffset = 0;
  authenticated(provider: string): boolean { return this.stored.has(provider) || provider !== 'missing-auth'; }
  async credentialVersion(): Promise<string> {
    if (this.failVersionRead) { this.failVersionRead = false; throw new Error('Fake credential version unavailable'); }
    return String(this.version);
  }
  credentialVersionNow(): string { return String(this.version); }
  async credentialInfo(profile: ModelProfileInput) {
    return { storedApiKey: this.stored.has(profile.provider), configurable: supportsSingleApiKeyInput(profile.provider) };
  }
  async configure(profile: ModelProfileInput): Promise<void> {
    if (!supportsSingleApiKeyInput(profile.provider)) throw new ModelAccessError('CREDENTIAL_UNSUPPORTED');
    this.stored.add(profile.provider); this.version += 1;
  }
  async revoke(profile: ModelProfileInput): Promise<void> { this.stored.delete(profile.provider); this.version += 1; }
  async check(profile: ModelProfileInput, signal: AbortSignal): Promise<void> {
    if (!this.authenticated(profile.provider)) throw new ModelAccessError('CHECK_AUTH_MISSING');
    if (this.behavior === 'fail') throw new Error('untrusted upstream content');
    const failSettlement = this.behavior === 'wait-read-failure';
    if (this.behavior === 'wait' || failSettlement) await new Promise<void>((_resolve, reject) => {
      const abort = () => { if (failSettlement) this.failVersionRead = true; reject(signal.reason); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }
  reset(): void { this.stored.clear(); this.version += 1; this.behavior = 'pass'; this.clockOffset = 0; this.failVersionRead = false; }
}
