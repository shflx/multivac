import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpAccount, McpService } from '@multivac/contracts';
import type { McpCredentialVault, McpOAuthConfig, McpOAuthHttp, McpPrivateCredentials } from '../modules/mcp/credentials.js';
import { McpError, mcpFingerprint, type McpRepository } from '../modules/mcp/mcp.js';

export class McpAccountService {
  constructor(private readonly repository: McpRepository, private readonly vault: McpCredentialVault,
    private readonly http: McpOAuthHttp, private readonly callbackUrl: string, private readonly now = () => Date.now()) {}
  create(commandId: string, serviceId: string, serviceRevision: number, label: string, auth: McpAccount['auth']): McpAccount {
    const accountId = mcpFingerprint(['account', commandId, serviceId]);
    const fingerprint = mcpFingerprint({ serviceId, serviceRevision, label, auth });
    this.repository.commit(`account:${commandId}`, fingerprint, this.at(), tx => {
      const service = tx.get('service', serviceId);
      if (!service || service.removed || service.revision !== serviceRevision) throw new McpError('identity-changed', 'MCP 服务已变化。');
      tx.put('account', { accountId, serviceId, revision: 1, label, auth, credentialRef: null,
        state: auth === 'none' ? 'ready' : 'unconfigured', createdAt: this.at(), updatedAt: this.at() }, 0);
    });
    return this.account(accountId);
  }
  async configure(commandId: string, accountId: string, revision: number, secret: { bearer: string | null; environment: Record<string, string> }): Promise<McpAccount> {
    const account = this.account(accountId), service = this.service(account.serviceId);
    if (account.auth !== 'bearer') throw new McpError('invalid-config', '此账号不接受静态凭据。');
    const ref = mcpFingerprint(['credential', this.vault.instanceId, commandId, accountId]);
    const fingerprint = mcpFingerprint({ accountId, revision, configVersion: service.configVersion });
    if (this.repository.receipt(`credential:${commandId}`, fingerprint)) return this.reconcile(accountId, ref);
    if (account.revision !== revision) throw new McpError('conflict', 'MCP 账号已变化。');
    this.checkSecret(service, secret);
    const pending: McpAccount = { ...account, revision: revision + 1, credentialRef: ref, state: 'unconfigured', updatedAt: this.at() };
    this.repository.commit(`credential:${commandId}`, fingerprint, this.at(), tx => tx.put('account', pending, revision));
    const value: McpPrivateCredentials = { instanceId: this.vault.instanceId, serviceId: service.serviceId, accountId, configVersion: service.configVersion,
      accountRevision: pending.revision + 1, state: 'ready', bearer: secret.bearer, environment: { ...secret.environment }, oauth: null };
    await this.vault.modify(ref, async current => {
      if (current) throw new McpError('conflict', 'MCP 凭据意图已存在；请只读对账。');
      this.assertBinding(pending, service);
      return value;
    });
    return this.reconcile(accountId, ref);
  }
  async reconcile(accountId: string, ref?: string): Promise<McpAccount> {
    const account = this.account(accountId), service = this.service(account.serviceId);
    if (!account.credentialRef || (ref && account.credentialRef !== ref)) throw new McpError('identity-changed', 'MCP 账号引用已变化。');
    const value = await this.vault.read(account.credentialRef);
    this.assertBinding(account, service);
    if (!value || value.state !== 'ready' || value.instanceId !== this.vault.instanceId || value.accountId !== accountId
      || value.serviceId !== service.serviceId || value.configVersion !== service.configVersion) throw new McpError('result-unknown', '凭据保存或认证结果待核对；不能自动重发秘密。');
    if (account.state === 'ready' && value.accountRevision === account.revision) return account;
    if (value.accountRevision !== account.revision + 1 || account.state === 'revoked') throw new McpError('identity-changed', 'MCP 账号版本已变化。');
    const ready: McpAccount = { ...account, revision: account.revision + 1, state: 'ready', updatedAt: this.at() };
    this.repository.commit(`credential-ready:${account.credentialRef}:${ready.revision}`, mcpFingerprint(ready), this.at(), tx => tx.put('account', ready, account.revision));
    return ready;
  }
  async beginOAuth(commandId: string, accountId: string, revision: number, config: McpOAuthConfig): Promise<{ account: McpAccount; loginUrl: string }> {
    const account = this.account(accountId), service = this.service(account.serviceId);
    if (account.auth !== 'oauth' || service.transport.kind !== 'streamable-http') throw new McpError('invalid-config', 'OAuth 仅用于远程 Streamable HTTP 账号。');
    this.checkOAuth(config);
    await this.http.authorize(config.authorizationEndpoint, service.serviceId);
    await this.http.authorize(config.tokenEndpoint, service.serviceId);
    this.assertBinding(account, service);
    const callback = new URL(this.callbackUrl);
    if (callback.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(callback.hostname) || callback.search || callback.hash)
      throw new McpError('invalid-config', 'OAuth 回调必须是本实例固定的回环地址。');
    const fingerprint = mcpFingerprint({ accountId, revision, config, callbackUrl: this.callbackUrl, configVersion: service.configVersion });
    const ref = mcpFingerprint(['oauth', this.vault.instanceId, commandId, accountId]);
    if (this.repository.receipt(`oauth-start:${commandId}`, fingerprint)) return this.oauthView(accountId, ref);
    if (account.revision !== revision) throw new McpError('conflict', 'MCP 账号已变化。');
    const pending: McpAccount = { ...account, revision: revision + 1, credentialRef: ref, state: 'login-required', updatedAt: this.at() };
    this.repository.commit(`oauth-start:${commandId}`, fingerprint, this.at(), tx => tx.put('account', pending, revision));
    await this.vault.modify(ref, async current => {
      if (current) throw new McpError('conflict', 'OAuth 登录已登记；请核对现有登录。');
      this.assertBinding(pending, service);
      return { instanceId: this.vault.instanceId, serviceId: service.serviceId, accountId, configVersion: service.configVersion,
        accountRevision: pending.revision, state: 'pending', bearer: null, environment: {}, oauth: {
          ...config, redirectUri: this.callbackUrl, resource: service.transport.kind === 'streamable-http' ? service.transport.url : '',
          state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), expiresAt: this.now() + 10 * 60_000,
          accessToken: null, refreshToken: null, tokenExpiresAt: null,
        } };
    });
    return this.oauthView(accountId, ref);
  }
  private async oauthView(accountId: string, ref: string): Promise<{ account: McpAccount; loginUrl: string }> {
    const account = this.account(accountId), value = await this.vault.read(ref);
    if (account.credentialRef !== ref || account.state !== 'login-required' || !value?.oauth || value.state !== 'pending'
      || value.accountRevision !== account.revision || value.oauth.expiresAt <= this.now()) throw new McpError('authorization-invalid', 'OAuth 登录已失效。');
    const oauth = value.oauth, url = new URL(oauth.authorizationEndpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: oauth.clientId, redirect_uri: oauth.redirectUri, scope: oauth.scope,
      state: oauth.state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(oauth.verifier).digest('base64url'), resource: oauth.resource }).toString();
    return { account, loginUrl: url.href };
  }
  async finishCallback(callbackUrl: string): Promise<McpAccount> {
    const state = new URL(callbackUrl).searchParams.get('state') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) throw new McpError('authorization-invalid', 'OAuth state 无效。');
    let accountId: string | null = null;
    for (let offset = 0; ; offset += 100) {
      const accounts = this.repository.list('account', { offset, limit: 100 });
      for (const account of accounts) {
        if (account.auth !== 'oauth' || account.state !== 'login-required' || !account.credentialRef) continue;
        const value = await this.vault.read(account.credentialRef);
        if (value?.state === 'pending' && value.oauth && sameSecret(state, value.oauth.state)) {
          if (accountId) throw new McpError('authorization-invalid', 'OAuth state 身份不唯一。');
          accountId = account.accountId;
        }
      }
      if (accounts.length < 100) break;
    }
    if (!accountId) throw new McpError('authorization-invalid', 'OAuth 登录不存在或已失效。');
    return this.finishOAuth(accountId, callbackUrl);
  }
  async finishOAuth(accountId: string, callbackUrl: string): Promise<McpAccount> {
    const account = this.account(accountId), service = this.service(account.serviceId);
    if (!account.credentialRef || account.auth !== 'oauth') throw new McpError('authorization-invalid', 'OAuth 登录不存在。');
    let pending: McpPrivateCredentials | null = null;
    await this.vault.modify(account.credentialRef, async current => {
      const oauth = current?.oauth;
      if (!current || !oauth || current.state !== 'pending' || current.accountRevision !== account.revision
        || current.configVersion !== service.configVersion || current.instanceId !== this.vault.instanceId) throw new McpError('authorization-invalid', 'OAuth 登录身份已失效。');
      const callback = new URL(callbackUrl), expected = new URL(oauth.redirectUri);
      if (callback.searchParams.has('iss') && callback.searchParams.get('iss') !== oauth.issuer) throw new McpError('authorization-invalid', 'OAuth 回调 issuer 不匹配。');
      const state = callback.searchParams.get('state') ?? '';
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash
        || callback.searchParams.getAll('state').length !== 1 || !sameSecret(state, oauth.state) || oauth.expiresAt <= this.now())
        throw new McpError('authorization-invalid', 'OAuth 回调来源、state 或时限无效。');
      if (callback.searchParams.has('error')) throw new McpError('authorization-invalid', '用户取消或提供方拒绝 OAuth 登录。');
      if (callback.searchParams.getAll('code').length !== 1 || !callback.searchParams.get('code') || callback.searchParams.get('code')!.length > 4096)
        throw new McpError('authorization-invalid', 'OAuth 回调缺少有效授权码。');
      this.assertBinding(account, service);
      pending = { ...current, state: 'exchanging' }; return pending;
    });
    const value = pending as McpPrivateCredentials | null;
    if (!value?.oauth) throw new McpError('authorization-invalid', 'OAuth 登录不可用。');
    const code = new URL(callbackUrl).searchParams.get('code')!;
    return this.exchange(account, service, value, { grant_type: 'authorization_code', code, code_verifier: value.oauth.verifier,
      redirect_uri: value.oauth.redirectUri, client_id: value.oauth.clientId, resource: value.oauth.resource });
  }
  async refresh(accountId: string, revision: number): Promise<McpAccount> {
    const account = this.account(accountId), service = this.service(account.serviceId);
    if (account.revision !== revision || account.auth !== 'oauth' || !account.credentialRef || account.state !== 'ready') throw new McpError('conflict', 'OAuth 账号已变化或不可刷新。');
    let pending: McpPrivateCredentials | null = null;
    await this.vault.modify(account.credentialRef, async current => {
      if (!current?.oauth?.refreshToken || current.state !== 'ready' || current.accountRevision !== revision || current.configVersion !== service.configVersion)
        throw new McpError('credential-unavailable', 'OAuth 刷新凭据不可用，或此前刷新结果待核对。');
      this.assertBinding(account, service); pending = { ...current, state: 'refreshing' }; return pending;
    });
    const value = pending as McpPrivateCredentials | null;
    if (!value?.oauth?.refreshToken) throw new McpError('credential-unavailable', 'OAuth 无可用刷新令牌。');
    return this.exchange(account, service, value, { grant_type: 'refresh_token', refresh_token: value.oauth.refreshToken, client_id: value.oauth.clientId, resource: value.oauth.resource });
  }
  private async exchange(account: McpAccount, service: McpService, pending: McpPrivateCredentials, form: Record<string, string>): Promise<McpAccount> {
    const oauth = pending.oauth!;
    let sent = false;
    try {
      await this.http.authorize(oauth.tokenEndpoint, service.serviceId);
      this.assertBinding(account, service);
      sent = true;
      const response = await this.http.request(oauth.tokenEndpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new McpError('credential-unavailable', 'OAuth 令牌交换失败。'); }
      const reader = response.body?.getReader();
      if (!reader) throw new McpError('credential-unavailable', 'OAuth 响应为空。');
      let raw = '', size = 0;
      try {
        const decoder = new TextDecoder();
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 64000) throw new Error(); raw += decoder.decode(chunk.value, { stream: true }); }
        raw += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const token = JSON.parse(raw) as Record<string, unknown>;
      if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 16000 || /[\r\n\0]/u.test(token.access_token)
        || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
        || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 366 * 86400
        || (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || token.refresh_token.length > 16000))) throw new Error();
      const next: McpPrivateCredentials = { ...pending, state: 'ready', accountRevision: account.revision + 1, oauth: { ...oauth,
        state: '', verifier: '', accessToken: token.access_token, refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : oauth.refreshToken,
        tokenExpiresAt: this.now() + token.expires_in * 1000 } };
      await this.vault.modify(account.credentialRef!, async current => {
        this.assertBinding(account, service);
        if (!current || current.state !== pending.state || current.accountRevision !== pending.accountRevision) throw new McpError('conflict', 'OAuth 操作已变化。');
        return next;
      });
      return this.reconcile(account.accountId);
    } catch (error) {
      if (!sent) throw error instanceof McpError ? error : new McpError('rule-denied', 'OAuth 网络或身份核对未通过，尚未交换令牌。');
      // 网络发出后失败可能已经轮换令牌。保留 exchanging/refreshing，不重复提交。
      throw new McpError('result-unknown', 'OAuth 交换结果待核对；请重新登录，不能自动重试旧授权码或刷新令牌。');
    }
  }
  async cancelOAuth(commandId: string, accountId: string, revision: number): Promise<McpAccount> {
    const account = this.account(accountId);
    this.repository.commit(`oauth-cancel:${commandId}`, mcpFingerprint({ accountId, revision }), this.at(), tx => {
      if (account.auth !== 'oauth' || account.revision !== revision) throw new McpError('conflict', 'OAuth 登录已变化。');
      tx.put('account', { ...account, revision: revision + 1, state: 'unconfigured', updatedAt: this.at() }, revision);
    });
    const cancelled = this.account(accountId);
    if (cancelled.revision === revision + 1 && cancelled.state === 'unconfigured' && cancelled.credentialRef)
      await this.vault.modify(cancelled.credentialRef, async current => current ? { ...current, state: 'revoked', bearer: null, environment: {}, oauth: null } : undefined);
    return cancelled;
  }
  async revoke(commandId: string, accountId: string, revision: number): Promise<McpAccount> {
    const fingerprint = mcpFingerprint({ accountId, revision });
    this.repository.commit(`account-revoke:${commandId}`, fingerprint, this.at(), tx => {
      const account = tx.get('account', accountId);
      if (!account || account.revision !== revision) throw new McpError('conflict', 'MCP 账号已变化。');
      tx.put('account', { ...account, revision: revision + 1, state: 'revoked', updatedAt: this.at() }, revision);
    });
    const account = this.account(accountId);
    if (account.revision === revision + 1 && account.state === 'revoked' && account.credentialRef)
      await this.vault.modify(account.credentialRef, async current => current ? { ...current, state: 'revoked', bearer: null, environment: {}, oauth: null } : undefined);
    return account;
  }
  async status(accountId: string): Promise<{ account: McpAccount; phase: string; expiresAt: number | null }> {
    const account = this.account(accountId), value = account.credentialRef ? await this.vault.read(account.credentialRef) : null;
    const expiresAt = value?.oauth?.tokenExpiresAt ?? null;
    return { account, phase: expiresAt !== null && expiresAt <= this.now() ? 'expired' : value?.state ?? account.state, expiresAt };
  }
  async credentials(accountId: string, revision: number): Promise<{ headers: Record<string, string>; environment: Record<string, string> }> {
    const account = this.account(accountId), service = this.service(account.serviceId);
    if (account.revision !== revision || account.state !== 'ready') throw new McpError('credential-unavailable', 'MCP 账号版本或状态不可用。');
    if (account.auth === 'none') return { headers: {}, environment: {} };
    if (!account.credentialRef) throw new McpError('credential-unavailable', 'MCP 账号尚未配置。');
    const value = await this.vault.read(account.credentialRef);
    this.assertBinding(account, service);
    if (!value || value.instanceId !== this.vault.instanceId || value.accountId !== accountId || value.serviceId !== service.serviceId
      || value.configVersion !== service.configVersion || value.accountRevision !== revision || value.state !== 'ready') throw new McpError('credential-unavailable', 'MCP 凭据身份不可用。');
    const token = value.oauth?.accessToken ?? value.bearer;
    if (value.oauth && (!token || !value.oauth.tokenExpiresAt || value.oauth.tokenExpiresAt <= this.now() + 30000)) throw new McpError('credential-unavailable', 'OAuth 已过期；请刷新账号后重新验证连接。');
    return { headers: token ? { Authorization: `Bearer ${token}` } : {}, environment: { ...value.environment } };
  }
  private account(id: string): McpAccount { const value = this.repository.get('account', id); if (!value) throw new McpError('not-found', 'MCP 账号不存在。', 404); return value; }
  private service(id: string): McpService { const value = this.repository.get('service', id); if (!value || value.removed) throw new McpError('not-found', 'MCP 服务不存在。', 404); return value; }
  private assertBinding(account: McpAccount, service: McpService): void {
    if (this.account(account.accountId).revision !== account.revision || this.service(service.serviceId).revision !== service.revision) throw new McpError('identity-changed', 'MCP 账号或服务已变化。');
  }
  private at(): string { return new Date(this.now()).toISOString(); }
  private checkSecret(service: McpService, secret: { bearer: string | null; environment: Record<string, string> }): void {
    if (secret.bearer !== null && (typeof secret.bearer !== 'string' || !secret.bearer || secret.bearer.length > 16000 || /[\r\n\0]/u.test(secret.bearer))) throw new McpError('invalid-config', 'MCP 凭据格式无效。');
    const allowed = service.transport.kind === 'stdio' ? service.transport.environmentKeys : [];
    if (Object.keys(secret.environment).some(key => !allowed.includes(key) || /^(PATH|HOME|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|OPENSSL_CONF|TMPDIR)$/u.test(key)
      || typeof secret.environment[key] !== 'string' || secret.environment[key]!.length > 16000 || secret.environment[key]!.includes('\0'))
      || (service.transport.kind === 'stdio' && secret.bearer !== null)) throw new McpError('invalid-config', 'MCP 私有环境变量不适用。');
  }
  private checkOAuth(config: McpOAuthConfig): void {
    const issuer = safeUrl(config.issuer), authorization = safeUrl(config.authorizationEndpoint), token = safeUrl(config.tokenEndpoint);
    if ([issuer, authorization, token].some(url => url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      || authorization.origin !== issuer.origin || token.origin !== issuer.origin || !config.clientId || config.clientId.length > 512 || config.scope.length > 2048)
      throw new McpError('invalid-config', 'OAuth 仅支持同源 HTTPS 端点与已登记公共客户端。');
  }
}
function safeUrl(value: string): URL {
  try { return new URL(value); } catch { throw new McpError('invalid-config', 'OAuth 地址无效。'); }
}
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
