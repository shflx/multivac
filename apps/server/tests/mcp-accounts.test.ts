import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { McpPrivateCredentials, McpCredentialVault } from '../src/modules/mcp/credentials.js';
import { McpAccountService } from '../src/application/mcp-account-service.js';
import { createMcpCredentialVault } from '../src/runtime/executors/pi-mcp-credentials.js';
import { mcpFingerprint } from '../src/modules/mcp/mcp.js';
import { mcpAt, mcpFixture, mcpTemporaryDirectory } from './fixtures/mcp-fixture.js';

function vaultFixture(): McpCredentialVault {
  const values = new Map<string, McpPrivateCredentials>();
  let chain = Promise.resolve();
  return { instanceId: 'test-instance', async read(ref) { return structuredClone(values.get(ref) ?? null); },
    modify(ref, operation) {
      const run = chain.then(async () => { const next = await operation(structuredClone(values.get(ref) ?? null)); if (next) values.set(ref, structuredClone(next)); });
      chain = run.catch(() => {}); return run;
    } };
}
const config = { issuer: 'https://oauth.test', authorizationEndpoint: 'https://oauth.test/authorize', tokenEndpoint: 'https://oauth.test/token', clientId: 'registered-public-client', scope: 'read write' };
const callback = 'http://127.0.0.1:4318/api/mcp/oauth/callback';
function remote(f: ReturnType<typeof mcpFixture>) {
  const transport = { kind: 'streamable-http' as const, url: 'https://mcp.test/mcp' };
  f.repository.commit('remote', mcpFingerprint('remote'), mcpAt, tx => tx.put('service', { ...f.service, revision: 2, transport, configVersion: mcpFingerprint(transport) }, 1));
}

test('MCP 凭据独立保存、参数对账、账号撤销与旧撤销重放不破坏新登录', async () => {
  const f = mcpFixture(), vault = vaultFixture(); remote(f);
  const service = new McpAccountService(f.repository, vault, { async authorize() {}, request: fetch }, callback);
  try {
    const account = service.create('static', 'service', 2, '独立账号', 'bearer');
    const ready = await service.configure('save', account.accountId, 1, { bearer: 'private-secret', environment: {} });
    assert.equal(ready.state, 'ready');
    assert.equal((await service.credentials(ready.accountId, ready.revision)).headers.Authorization, 'Bearer private-secret');
    const same = await service.configure('save', account.accountId, 1, { bearer: 'must-not-overwrite', environment: {} });
    assert.equal(same.revision, ready.revision);
    assert.equal((await service.credentials(ready.accountId, ready.revision)).headers.Authorization, 'Bearer private-secret');
    const revoked = await service.revoke('revoke', ready.accountId, ready.revision);
    await assert.rejects(service.credentials(ready.accountId, ready.revision), /不可用/);
    const next = await service.configure('save-next', ready.accountId, revoked.revision, { bearer: 'new-secret', environment: {} });
    await service.revoke('revoke', ready.accountId, ready.revision);
    assert.equal((await service.credentials(next.accountId, next.revision)).headers.Authorization, 'Bearer new-secret');
    const publicData = JSON.stringify(f.db.prepare('SELECT * FROM mcp_fact').all()) + JSON.stringify(f.db.prepare('SELECT * FROM mcp_command').all());
    for (const secret of ['private-secret', 'must-not-overwrite', 'new-secret', createHash('sha256').update('private-secret').digest('hex')]) assert.equal(publicData.includes(secret), false);
  } finally { f.close(); }
});

test('MCP OAuth PKCE、state、回调来源、成功登录和刷新并发', async () => {
  const f = mcpFixture(), vault = vaultFixture(); remote(f);
  let requests = 0, clock = Date.parse(mcpAt);
  const forms: URLSearchParams[] = [];
  const service = new McpAccountService(f.repository, vault, { async authorize() {}, async request(_url, init) {
    requests++; forms.push(new URLSearchParams(String(init?.body)));
    return Response.json({ access_token: `access-${requests}`, refresh_token: `refresh-${requests}`, token_type: 'Bearer', expires_in: 60 });
  } }, callback, () => clock);
  try {
    const account = service.create('oauth', 'service', 2, 'OAuth', 'oauth');
    const login = await service.beginOAuth('login', account.accountId, 1, config);
    const url = new URL(login.loginUrl), state = url.searchParams.get('state')!;
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('resource'), 'https://mcp.test/mcp');
    await assert.rejects(service.finishOAuth(account.accountId, `${callback}?state=wrong&code=code`), /state/);
    await assert.rejects(service.finishOAuth(account.accountId, `http://127.0.0.1:9000/api/mcp/oauth/callback?state=${state}&code=code`), /来源/);
    assert.equal(requests, 0);
    const ready = await service.finishCallback(`${callback}?state=${state}&code=one-time-code`);
    assert.equal(ready.state, 'ready');
    assert.equal(createHash('sha256').update(forms[0]!.get('code_verifier')!).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal((await service.credentials(account.accountId, ready.revision)).headers.Authorization, 'Bearer access-1');
    await assert.rejects(service.finishOAuth(account.accountId, `${callback}?state=${state}&code=one-time-code`), /失效/);
    clock += 60001;
    assert.equal((await service.status(account.accountId)).phase, 'expired');
    await assert.rejects(service.credentials(account.accountId, ready.revision), /已过期/);
    const results = await Promise.allSettled([service.refresh(account.accountId, ready.revision), service.refresh(account.accountId, ready.revision)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(requests, 2);
    assert.equal(forms[1]?.get('refresh_token'), 'refresh-1');
    const current = f.repository.get('account', account.accountId)!;
    assert.equal((await service.credentials(current.accountId, current.revision)).headers.Authorization, 'Bearer access-2');
    assert.equal(JSON.stringify(await service.status(current.accountId)).includes('access-2'), false);
  } finally { f.close(); }
});

test('MCP OAuth 取消、配置变化及未知响应不重发授权码', async () => {
  const f = mcpFixture(), vault = vaultFixture(); remote(f);
  let requests = 0;
  const service = new McpAccountService(f.repository, vault, { async authorize() {}, async request() { requests++; throw new Error('private-response-body'); } }, callback, () => Date.parse(mcpAt));
  try {
    const account = service.create('oauth', 'service', 2, 'OAuth', 'oauth');
    const login = await service.beginOAuth('login', account.accountId, 1, config);
    await service.cancelOAuth('cancel', account.accountId, login.account.revision);
    await assert.rejects(service.finishOAuth(account.accountId, `${callback}?state=${new URL(login.loginUrl).searchParams.get('state')}&code=code`), /失效/);
    assert.equal(requests, 0);
    const current = f.repository.get('account', account.accountId)!;
    const retry = await service.beginOAuth('new-login', account.accountId, current.revision, config);
    const returned = `${callback}?state=${new URL(retry.loginUrl).searchParams.get('state')}&code=code`;
    await assert.rejects(service.finishOAuth(account.accountId, returned), error => (error as Error).message.includes('待核对') && !(error as Error).message.includes('private-response-body'));
    await assert.rejects(service.finishOAuth(account.accountId, returned), /失效/);
    assert.equal(requests, 1);
    assert.equal((await service.status(account.accountId)).phase, 'exchanging');
    const original = f.repository.get('service', 'service')!;
    f.repository.commit('change-config', mcpFingerprint('change-config'), mcpAt, tx => tx.put('service', { ...original, revision: 3, enabled: false }, 2));
    await assert.rejects(service.reconcile(account.accountId), /待核对/);
  } finally { f.close(); }
});

test('MCP 私有存储复用原生锁，开发与生产命名空间不串用', async () => {
  const root = mcpTemporaryDirectory('credentials-');
  try {
    const privatePath = path.join(root, 'mcp-auth.json');
    const dev = await createMcpCredentialVault(privatePath, 'development');
    const production = await createMcpCredentialVault(privatePath, 'production');
    const secret: McpPrivateCredentials = { instanceId: 'development', serviceId: 'service', accountId: 'account', configVersion: 'version', accountRevision: 1, state: 'ready', bearer: 'private', environment: {}, oauth: null };
    await dev.modify('ref', async () => secret);
    assert.equal((await dev.read('ref'))?.bearer, 'private');
    assert.equal(await production.read('ref'), null);
    assert.equal(statSync(privatePath).mode & 0o777, 0o600);
    await assert.rejects(production.modify('ref', async () => secret), /实例不匹配/);
    const results = await Promise.all([dev.modify('ref', async value => ({ ...value!, accountRevision: value!.accountRevision + 1 })), dev.modify('ref', async value => ({ ...value!, accountRevision: value!.accountRevision + 1 }))]);
    assert.equal(results.length, 2);
    assert.equal((await dev.read('ref'))?.accountRevision, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
