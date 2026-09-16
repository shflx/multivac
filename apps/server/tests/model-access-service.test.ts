import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import type { ModelAccessCommand, ModelProfileInput } from '@multivac/contracts';
import { ModelAccessService } from '../src/application/model-access-service.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { ModelAccessError, type ModelAccessBackend, type ModelAccessState, type ModelAccessStore } from '../src/modules/model-settings/model-access.js';
import { FileModelAccessStore } from '../src/storage/file-model-access-store.js';
import { FileModelSettingsStore } from '../src/storage/file-model-settings-store.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import { createModelAccessRequestHandler } from '../src/adapters/http/model-access-routes.js';
import { admitAccessSnapshot } from '../../web/src/features/models/model-settings-view-state.js';

const profile: ModelProfileInput = {
  profileId: 'model', displayName: 'Model', provider: 'provider', modelId: 'model',
  protocol: 'openai-responses', endpoint: 'https://provider.example/v1',
};
class Backend implements ModelAccessBackend {
  authenticated = false;
  writes = 0;
  revocations = 0;
  checks = 0;
  version = 0;
  fail = false;
  wait = false;
  configureBarrier: Promise<void> | undefined;
  markEntered: (() => void) | undefined;
  async credentialInfo() { return { storedApiKey: this.authenticated, configurable: true }; }
  async credentialVersion() { return String(this.version); }
  async configure() { this.writes += 1; await this.configureBarrier; this.authenticated = true; this.version += 1; }
  async revoke() { this.revocations += 1; this.authenticated = false; this.version += 1; }
  async check(_profile: ModelProfileInput, signal: AbortSignal) {
    this.checks += 1;
    if (!this.authenticated) throw new ModelAccessError('CHECK_AUTH_MISSING');
    this.markEntered?.();
    if (this.wait) await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    if (this.fail) throw new Error('secret-upstream-payload');
  }
}
async function fixture(options: { timeoutMs?: number; store?: ModelAccessStore } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-access-service-'));
  const backend = new Backend();
  const settingsPath = join(root, 'models.json');
  const accessPath = join(root, 'access.json');
  await writeFile(settingsPath, JSON.stringify({ revision: 0, profiles: [profile], defaultProfileId: null, commands: [] }));
  const settings = new ModelSettingsService(new FileModelSettingsStore(settingsPath, {
    initialState: { revision: 0, profiles: [profile], defaultProfileId: null, commands: [] },
  }), new FakeModelSettingsCatalogFactory(() => backend.authenticated));
  await settings.initialize();
  let clock = Date.parse('2026-09-16T08:00:00Z');
  const store = options.store ?? new FileModelAccessStore(accessPath);
  const create = () => new ModelAccessService({ settings, backend, store,
    now: () => clock, ttlMs: 100, timeoutMs: options.timeoutMs ?? 1000 });
  const service = create();
  const unsubscribe = settings.onConfigurationChanged(() => service.configurationChanged());
  return { root, backend, settings, service, create, store, accessPath, settingsPath,
    advance: () => { clock += 101; }, close: async () => { unsubscribe(); await service.close(); await rm(root, { recursive: true, force: true }); } };
}
async function command(service: ModelAccessService, id: string): Promise<ModelAccessCommand> {
  const state = await service.getSnapshot();
  return { commandId: id, profileId: profile.profileId, revision: state.revision, accessRevision: state.accessRevision };
}
async function terminal(service: ModelAccessService, id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const found = (await service.getSnapshot()).checks.find((entry) => entry.checkId === id);
    if (found && found.status !== 'checking') return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('check did not settle');
}
const errorCode = (code: string) => (error: unknown) => error instanceof ModelAccessError && error.code === code;

test('凭据文件 version 不变但 Pi 认证消失，持久化新 epoch/失效旧检查并拒绝旧 auth snapshot', async () => {
  const target = await fixture();
  target.backend.authenticated = true;
  try {
    await target.service.startCheck(await command(target.service, 'ambient-pass'));
    await terminal(target.service, 'ambient-pass');
    const before = await target.service.getSnapshot();
    const version = target.backend.version;
    target.backend.authenticated = false;
    const after = await target.service.getSnapshot();
    assert.equal(target.backend.version, version);
    assert.ok(after.accessRevision > before.accessRevision && after.credentialRevision > before.credentialRevision);
    assert.equal(after.availability[0]?.authenticated, false);
    assert.equal(after.checks[0]?.status, 'invalidated');
    assert.equal((await target.store.load()).accessRevision, after.accessRevision);
    assert.equal(admitAccessSnapshot(after, before), after);
  } finally { await target.close(); }
});

for (const action of ['configure', 'revoke'] as const) {
  for (const read of ['receipt', 'snapshot', 'replay'] as const) {
    test(`${action} Pi 写入后版本瞬时失败，同实例由 ${read} 持久化恢复 unconfirmed，不重发 Key`, async () => {
      const target = await fixture();
      try {
        if (action === 'revoke') await target.service.configure({ ...await command(target.service, 'seed'), apiKey: 'seed-secret' });
        const cmd = await command(target.service, `version-failure-${action}-${read}`);
        const version = target.backend.credentialVersion.bind(target.backend);
        let failVersion = false;
        target.backend.credentialVersion = async () => {
          if (failVersion) { failVersion = false; throw new Error('private-version-error'); }
          return version();
        };
        const operation = target.backend[action].bind(target.backend);
        target.backend[action] = async () => { await operation(); failVersion = true; };
        const submit = () => action === 'configure' ? target.service.configure({ ...cmd, apiKey: 'one-shot-secret' }) : target.service.revoke(cmd);
        await assert.rejects(submit(), errorCode('CREDENTIAL_RESULT_UNKNOWN'));
        const begun = await target.store.load();
        assert.equal(begun.commands.at(-1)?.state, 'begun');
        const writes = target.backend.writes;
        const revocations = target.backend.revocations;
        if (read === 'snapshot') assert.equal((await target.service.getSnapshot()).credentials[0]?.lastCommand?.state, 'unconfirmed');
        else if (read === 'receipt') assert.equal((await target.service.getReceipt(cmd.commandId)).state, 'unconfirmed');
        else {
          const result = await submit();
          assert.equal(result.replayed, true); assert.equal(result.state, 'unconfirmed');
        }
        const restored = await target.store.load();
        assert.ok(restored.accessRevision > begun.accessRevision);
        assert.equal(restored.commands.at(-1)?.state, 'unconfirmed');
        assert.equal(restored.commands.at(-1)?.errorCode, 'CREDENTIAL_RESULT_UNKNOWN');
        const snapshot = await target.service.getSnapshot();
        assert.equal(snapshot.credentials[0]?.storedApiKey, action === 'configure');
        assert.equal(snapshot.credentials[0]?.lastCommand?.state, 'unconfirmed');
        assert.equal(snapshot.accessRevision, restored.accessRevision);
        const replay = action === 'configure' ? await target.service.configure({ ...cmd, apiKey: 'new-secret-not-to-be-sent' })
          : await target.service.revoke(cmd);
        assert.equal(replay.replayed, true); assert.equal(replay.state, 'unconfirmed');
        assert.equal(target.backend.writes, writes); assert.equal(target.backend.revocations, revocations);
        const persisted = await readFile(target.accessPath, 'utf8');
        for (const secret of ['one-shot-secret', 'new-secret-not-to-be-sent', 'private-version-error']) assert.equal(persisted.includes(secret), false);
      } finally { await target.close(); }
    });
  }
  test(`${action} 写后版本失败且恢复读/写失败时安全 503，恢复后同实例对账且不重复修改 Pi`, async () => {
    let saved: ModelAccessState = { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
    let failSave = false;
    const store: ModelAccessStore = {
      load: async () => structuredClone(saved),
      save: async (next, beforeCommit) => {
        if (failSave && next.commands.some((record) => record.state === 'unconfirmed')) throw new Error('private-recovery-write-error');
        beforeCommit?.(); saved = structuredClone(next);
      },
    };
    const target = await fixture({ store });
    try {
      if (action === 'revoke') await target.service.configure({ ...await command(target.service, 'seed'), apiKey: 'seed-secret' });
      const cmd = await command(target.service, `recovery-failed-${action}`);
      const version = target.backend.credentialVersion.bind(target.backend);
      let failRead = false;
      target.backend.credentialVersion = async () => { if (failRead) throw new Error('private-version-error'); return version(); };
      const operation = target.backend[action].bind(target.backend);
      target.backend[action] = async () => { await operation(); failRead = true; };
      const submit = () => action === 'configure' ? target.service.configure({ ...cmd, apiKey: 'not-to-be-replayed' }) : target.service.revoke(cmd);
      await assert.rejects(submit(), errorCode('CREDENTIAL_RESULT_UNKNOWN'));
      const revision = saved.accessRevision;
      await assert.rejects(target.service.getReceipt(cmd.commandId), errorCode('ACCESS_UNAVAILABLE'));
      await assert.rejects(target.service.getSnapshot(), errorCode('ACCESS_UNAVAILABLE'));
      assert.equal(saved.commands.at(-1)?.state, 'begun'); assert.equal(saved.accessRevision, revision);
      failRead = false; failSave = true;
      await assert.rejects(target.service.getReceipt(cmd.commandId), errorCode('ACCESS_UNAVAILABLE'));
      await assert.rejects(submit(), errorCode('ACCESS_UNAVAILABLE'));
      assert.equal(saved.commands.at(-1)?.state, 'begun');
      const writes = target.backend.writes; const revocations = target.backend.revocations;
      failSave = false;
      assert.equal((await target.service.getReceipt(cmd.commandId)).state, 'unconfirmed');
      assert.ok(saved.accessRevision > revision);
      assert.equal((await submit()).replayed, true);
      assert.equal(target.backend.writes, writes); assert.equal(target.backend.revocations, revocations);
    } finally { failSave = false; await target.close(); }
  });
}

for (const dependency of ['credential', 'configuration'] as const) {
  test(`旧 HTTP checking GET gate + ${dependency} 结算读取失败 + cancel invalidated 乱序不回滚`, async () => {
    const target = await fixture();
    target.backend.authenticated = true; target.backend.wait = true;
    let entered!: () => void; let release!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = createModelAccessRequestHandler(target.service);
    const server = createServer(async (request, response) => {
      if (request.headers['x-hold-old-snapshot']) {
        const snapshot = await target.service.getSnapshot(); entered(); await gate;
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(snapshot));
      } else await handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/model-access`;
    try {
      const cmd = await command(target.service, `read-failed-${dependency}`);
      await target.service.startCheck(cmd);
      const oldResponse = fetch(root, { headers: { 'x-hold-old-snapshot': '1' } });
      await entry;
      let fail = true;
      const version = target.backend.credentialVersion.bind(target.backend);
      const config = target.settings.getConfigurationForAccess.bind(target.settings);
      target.backend.credentialVersion = async () => {
        if (dependency === 'credential' && fail) { fail = false; throw new Error('private-dependency-error'); }
        return version();
      };
      target.settings.getConfigurationForAccess = async () => {
        if (dependency === 'configuration' && fail) { fail = false; throw new Error('private-dependency-error'); }
        return config();
      };
      const cancellation = await fetch(`${root}/cancel-check`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ checkId: cmd.commandId }) });
      assert.equal(cancellation.status, 200);
      const settled = await cancellation.json() as import('@multivac/contracts').ModelAccessSnapshot;
      assert.equal(settled.checks[0]?.status, 'invalidated');
      const persisted = await target.store.load();
      assert.equal(persisted.accessRevision, settled.accessRevision);
      assert.equal(persisted.checks[0]?.status, 'invalidated');
      release();
      const old = await (await oldResponse).json() as import('@multivac/contracts').ModelAccessSnapshot;
      assert.equal(old.checks[0]?.status, 'checking');
      assert.equal(settled.accessRevision, old.accessRevision + 1);
      assert.equal(settled.revision, old.revision);
      assert.equal(settled.credentialRevision, old.credentialRevision);
      assert.equal(admitAccessSnapshot(settled, old), settled);
      assert.equal((await target.service.cancelCheck(cmd.commandId)).checks[0]?.status, 'invalidated');
      assert.equal(JSON.stringify(settled).includes('private-dependency-error'), false);
    } finally {
      release(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await target.close();
    }
  });
}

for (const partialCommit of [false, true]) {
  test(`异常降级持久化失败（部分提交 ${partialCommit}）只返回安全 503，恢复提交新 revision 后才发布`, async () => {
    let saved: ModelAccessState = { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
    let failWrites = false;
    const store: ModelAccessStore = {
      load: async () => structuredClone(saved),
      save: async (next, beforeCommit) => {
        beforeCommit?.();
        if (failWrites && next.checks.some((check) => check.status === 'invalidated')) {
          if (partialCommit) saved = structuredClone(next);
          throw new Error('private-disk-error');
        }
        saved = structuredClone(next);
      },
    };
    const target = await fixture({ store });
    target.backend.authenticated = true; target.backend.wait = true;
    try {
      const cmd = await command(target.service, 'degrade-write-failed');
      await target.service.startCheck(cmd);
      const old = await target.service.getSnapshot();
      const version = target.backend.credentialVersion.bind(target.backend);
      let readFailure = true;
      target.backend.credentialVersion = async () => {
        if (readFailure) { readFailure = false; throw new Error('private-read-error'); }
        return version();
      };
      failWrites = true;
      await assert.rejects(target.service.cancelCheck(cmd.commandId), errorCode('ACCESS_UNAVAILABLE'));
      await assert.rejects(target.service.getSnapshot(), errorCode('ACCESS_UNAVAILABLE'));
      readFailure = true;
      await assert.rejects(target.service.getSnapshot(), errorCode('ACCESS_UNAVAILABLE'));
      await assert.rejects(target.service.getReceipt(cmd.commandId), errorCode('ACCESS_UNAVAILABLE'));
      failWrites = false;
      const recovered = await target.service.getSnapshot();
      assert.ok(recovered.accessRevision > old.accessRevision);
      assert.equal(recovered.checks[0]?.status, 'invalidated');
      assert.equal(saved.accessRevision, recovered.accessRevision);
      assert.equal(admitAccessSnapshot(recovered, old), recovered);
      const restarted = target.create();
      const restored = await restarted.getSnapshot();
      assert.ok(restored.accessRevision > recovered.accessRevision);
      assert.equal(restored.checks[0]?.status, 'invalidated');
      await restarted.close();
    } finally { failWrites = false; await target.close(); }
  });
}

test('Pi 同锁凭据冲突作为明确失败对账，不写秘密或宣称结果未知', async () => {
  const target = await fixture();
  try {
    target.backend.configure = async () => { throw new ModelAccessError('ACCESS_CONFLICT'); };
    const cmd = await command(target.service, 'credential-conflict');
    const receipt = await target.service.configure({ ...cmd, apiKey: 'must-not-persist' });
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.errorCode, 'ACCESS_CONFLICT');
    assert.equal((await target.service.getReceipt(cmd.commandId)).errorCode, 'ACCESS_CONFLICT');
    assert.equal((await readFile(target.accessPath, 'utf8')).includes('must-not-persist'), false);
  } finally { await target.close(); }
});

for (const stage of ['cleanup', 'settlement', 'persistence'] as const) {
  for (const abort of ['cancel', 'timeout', 'invalidated'] as const) {
    test(`${stage} 等待期间 ${abort} 不得提交 passed，提交后的终态不因取消改变`, async () => {
      let saved: ModelAccessState = { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entry = new Promise<void>((resolve) => { entered = resolve; });
      let armed = false;
      const store: ModelAccessStore = {
        load: async () => structuredClone(saved),
        save: async (next, beforeCommit) => {
          if (armed && stage === 'persistence' && next.checks.some((check) => check.status === 'passed')) {
            armed = false; entered(); await gate;
          }
          beforeCommit?.();
          saved = structuredClone(next);
        },
      };
      const target = await fixture({ store, timeoutMs: 100 });
      target.backend.authenticated = true;
      try {
        const cmd = await command(target.service, `late-${stage}-${abort}`);
        target.backend.check = async () => {
          if (stage === 'cleanup') { entered(); await gate; }
          if (stage === 'settlement') armed = true;
        };
        const version = target.backend.credentialVersion.bind(target.backend);
        target.backend.credentialVersion = async () => {
          if (armed && stage === 'settlement') { armed = false; entered(); await gate; }
          return version();
        };
        armed = stage === 'persistence';
        await target.service.startCheck(cmd);
        await entry;
        const cancellation = abort === 'cancel' ? target.service.cancelCheck(cmd.commandId) : undefined;
        if (abort === 'timeout') await new Promise((resolve) => setTimeout(resolve, 120));
        if (abort === 'invalidated') await target.settings.save({ commandId: `invalidate-${stage}`, revision: 0,
          profile: { ...profile, displayName: 'Changed' } });
        release();
        await cancellation;
        if (abort === 'invalidated') await target.service.cancelCheck(cmd.commandId);
        const result = await terminal(target.service, cmd.commandId);
        assert.equal(result.status, abort === 'cancel' ? 'cancelled' : abort === 'timeout' ? 'timed-out' : 'invalidated');
        assert.equal(saved.checks[0]?.status, result.status);
        assert.equal((await target.service.cancelCheck(cmd.commandId)).checks[0]?.status, result.status);
      } finally { release(); await target.close(); }
    });
  }
}

test('终态已提交但持久化收尾等待时取消/超时不改已提交 passed', async () => {
  let saved: ModelAccessState = { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  const store: ModelAccessStore = {
    load: async () => structuredClone(saved),
    save: async (next, beforeCommit) => {
      beforeCommit?.(); saved = structuredClone(next);
      if (next.checks.some((check) => check.status === 'passed')) { entered(); await gate; }
    },
  };
  const target = await fixture({ store, timeoutMs: 100 });
  target.backend.authenticated = true;
  try {
    await target.service.startCheck(await command(target.service, 'committed'));
    await entry;
    const cancellation = target.service.cancelCheck('committed');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(saved.checks[0]?.status, 'passed');
    release();
    assert.equal((await cancellation).checks[0]?.status, 'passed');
  } finally { release(); await target.close(); }
});

test('真实文件 store 在提交复核拒绝时保留旧文件', async () => {
  const target = await fixture();
  try {
    await target.service.getSnapshot();
    const before = await readFile(target.accessPath, 'utf8');
    const next = await target.store.load(); next.accessRevision += 1;
    await assert.rejects(target.store.save(next, () => { throw new ModelAccessError('CHECK_CANCELLED'); }), errorCode('CHECK_CANCELLED'));
    assert.equal(await readFile(target.accessPath, 'utf8'), before);
  } finally { await target.close(); }
});

test('外部只变更凭据时 access 同步发布真实认证及 availability 和凭据 revision', async () => {
  const target = await fixture();
  try {
    const before = await target.service.getSnapshot();
    assert.equal(before.availability[0]?.authenticated, false);
    target.backend.authenticated = true; target.backend.version += 1;
    const configured = await target.service.getSnapshot();
    assert.equal(configured.revision, before.revision);
    assert.ok(configured.credentialRevision > before.credentialRevision);
    assert.equal(configured.availability[0]?.authenticated, true);
    target.backend.authenticated = false; target.backend.version += 1;
    const revoked = await target.service.getSnapshot();
    assert.ok(revoked.credentialRevision > configured.credentialRevision);
    assert.equal(revoked.availability[0]?.authenticated, false);
    assert.equal(revoked.availability[0]?.available, false);
  } finally { await target.close(); }
});

test('检查落盘后配置复核失败不派发请求且已接受尝试收敛为失效', async () => {
  const target = await fixture();
  target.backend.authenticated = true;
  try {
    const cmd = await command(target.service, 'recheck-failure');
    const configuration = target.settings.getConfigurationForAccess.bind(target.settings);
    let reads = 0;
    target.settings.getConfigurationForAccess = async () => {
      if (++reads === 2) throw new Error('private-config-failure');
      return configuration();
    };
    assert.equal((await target.service.startCheck(cmd)).state, 'committed');
    assert.equal((await terminal(target.service, cmd.commandId)).status, 'invalidated');
    assert.equal(target.backend.checks, 0);
    assert.equal((await target.service.startCheck(cmd)).replayed, true);
  } finally { await target.close(); }
});

for (const stage of ['credential-sync', 'persistence'] as const) {
  test(`检查启动 ${stage} 等待期间配置变化不得派发旧 endpoint`, async () => {
    let saved: ModelAccessState = { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    let armed = false;
    const store: ModelAccessStore = {
      load: async () => structuredClone(saved),
      save: async (next) => {
        if (armed && stage === 'persistence' && next.checks.some((check) => check.status === 'checking')) {
          armed = false; entered(); await gate;
        }
        saved = structuredClone(next);
      },
    };
    const target = await fixture({ store });
    target.backend.authenticated = true;
    try {
      const cmd = await command(target.service, `gate-${stage}`);
      const version = target.backend.credentialVersion.bind(target.backend);
      target.backend.credentialVersion = async () => {
        if (armed && stage === 'credential-sync') { armed = false; entered(); await gate; }
        return version();
      };
      armed = true;
      const started = target.service.startCheck(cmd);
      await entry;
      await target.settings.save({ commandId: `change-${stage}`, revision: 0,
        profile: { ...profile, endpoint: 'https://new.example/v1' } });
      release();
      await started;
      assert.equal((await terminal(target.service, cmd.commandId)).status, 'invalidated');
      assert.equal(target.backend.checks, 0);
      await target.service.startCheck(await command(target.service, `fresh-${stage}`));
      assert.equal((await terminal(target.service, `fresh-${stage}`)).status, 'passed');
      assert.equal(target.backend.checks, 1);
    } finally { release(); await target.close(); }
  });
}

test('秘密及其 hash 不入元数据；凭据命令一 ID 至多一次且 revision 冲突不写凭据', async () => {
  const target = await fixture();
  const key = 'test-super-secret';
  try {
    const cmd = await command(target.service, 'key-1');
    const result = await target.service.configure({ ...cmd, apiKey: key });
    assert.equal(result.state, 'committed');
    const replay = await target.service.configure({ ...cmd, apiKey: 'different-secret' });
    assert.equal(replay.replayed, true);
    assert.equal(target.backend.writes, 1);
    await assert.rejects(target.service.revoke(cmd), errorCode('COMMAND_ID_CONFLICT'));
    await assert.rejects(target.service.configure({ ...cmd, commandId: 'stale', apiKey: key }), errorCode('ACCESS_CONFLICT'));
    assert.equal(target.backend.writes, 1);
    const content = await readFile(target.accessPath, 'utf8');
    const models = await readFile(target.settingsPath, 'utf8');
    for (const value of [key, 'different-secret', createHash('sha256').update(key).digest('hex')]) {
      assert.equal(content.includes(value) || models.includes(value) || JSON.stringify(result).includes(value), false);
    }
    const receipt = await target.service.getReceipt('key-1');
    assert.deepEqual(Object.keys(receipt).sort(), ['accessRevision', 'action', 'commandId', 'errorCode', 'profileId', 'replayed', 'revision', 'state'].sort());
  } finally { await target.close(); }
});

test('同命令并发只写一次，不同旧 revision 的写入不覆盖新凭据', async () => {
  const target = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  target.backend.configureBarrier = gate;
  const original = target.backend.configure.bind(target.backend);
  target.backend.configure = async () => { entered(); await original(); };
  try {
    const cmd = await command(target.service, 'parallel');
    const first = target.service.configure({ ...cmd, apiKey: 'one' });
    await entry;
    const duplicate = target.service.configure({ ...cmd, apiKey: 'two' });
    const stale = target.service.configure({ ...cmd, commandId: 'other', apiKey: 'three' });
    const rejection = assert.rejects(stale, errorCode('ACCESS_CONFLICT'));
    release();
    await first;
    assert.equal((await duplicate).replayed, true);
    await rejection;
    assert.equal(target.backend.writes, 1);
  } finally { release(); await target.close(); }
});

test('认证与连通性独立；失败上游内容不回显，成功检查有时间并过期，撤销作废旧检查', async () => {
  const target = await fixture();
  try {
    await target.service.startCheck(await command(target.service, 'no-auth'));
    assert.equal((await terminal(target.service, 'no-auth')).errorCode, 'CHECK_AUTH_MISSING');
    await target.service.configure({ ...await command(target.service, 'auth'), apiKey: 'secret' });
    target.backend.fail = true;
    await target.service.startCheck(await command(target.service, 'failure'));
    const failed = await terminal(target.service, 'failure');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.errorCode, 'CHECK_FAILED');
    assert.equal(target.backend.authenticated, true);
    assert.equal(JSON.stringify(failed).includes('secret-upstream-payload'), false);
    target.backend.fail = false;
    await target.service.startCheck(await command(target.service, 'success'));
    const passed = await terminal(target.service, 'success');
    assert.equal(passed.status, 'passed');
    assert.ok(passed.checkedAt && passed.expiresAt);
    target.advance();
    assert.equal((await target.service.getSnapshot()).checks[0]?.status, 'expired');
    await target.service.revoke(await command(target.service, 'revoke'));
    const after = await target.service.getSnapshot();
    assert.equal(after.credentials[0]?.storedApiKey, false);
    assert.equal(after.checks[0]?.status, 'invalidated');
    assert.equal(target.backend.revocations, 1);
  } finally { await target.close(); }
});

test('检查超时、取消、并发限制及取消不能覆盖已完成状态', async () => {
  const target = await fixture({ timeoutMs: 30 });
  target.backend.authenticated = true;
  target.backend.wait = true;
  try {
    await target.service.startCheck(await command(target.service, 'timeout'));
    assert.equal((await terminal(target.service, 'timeout')).status, 'timed-out');
    const cmd = await command(target.service, 'cancel');
    await target.service.startCheck(cmd);
    const replay = await target.service.startCheck(cmd);
    assert.equal(replay.replayed, true);
    await assert.rejects(target.service.startCheck(await command(target.service, 'duplicate')), errorCode('CHECK_BUSY'));
    const cancelled = await target.service.cancelCheck('cancel');
    assert.equal(cancelled.checks[0]?.status, 'cancelled');
    assert.equal((await target.service.cancelCheck('cancel')).checks[0]?.status, 'cancelled');
    target.backend.wait = false;
    await target.service.startCheck(await command(target.service, 'done'));
    assert.equal((await terminal(target.service, 'done')).status, 'passed');
    assert.equal((await target.service.cancelCheck('done')).checks[0]?.status, 'passed');
  } finally { await target.close(); }
});

test('配置/凭据改变、外部凭据变更和重启使检查失效，迟到旧任务不能重新标成功', async () => {
  const target = await fixture();
  target.backend.authenticated = true;
  target.backend.wait = true;
  try {
    await target.service.startCheck(await command(target.service, 'running'));
    await target.settings.save({ commandId: 'config', revision: 0, profile: { ...profile, displayName: 'Changed' } });
    assert.equal((await terminal(target.service, 'running')).status, 'invalidated');
    target.backend.wait = false;
    await target.service.startCheck(await command(target.service, 'passed'));
    await terminal(target.service, 'passed');
    target.backend.version += 1;
    assert.equal((await target.service.getSnapshot()).checks[0]?.status, 'invalidated');
    await target.service.startCheck(await command(target.service, 'restart'));
    await terminal(target.service, 'restart');
    const restarted = target.create();
    assert.equal((await restarted.getSnapshot()).checks[0]?.status, 'invalidated');
    await restarted.close();
  } finally { await target.close(); }
});

test('Pi 写入后账本落盘失败是结果未知；重启不重发秘密，仅按安全命令对账', async () => {
  let saved: ModelAccessState = { version: 1, accessRevision: 0, credentialRevision: 0, commands: [], checks: [] };
  let failFinished = true;
  const store: ModelAccessStore = {
    load: async () => structuredClone(saved),
    save: async (next) => {
      if (failFinished && next.commands.some((entry) => entry.action === 'configure-key' && entry.state === 'committed')) throw new Error('disk failure');
      saved = structuredClone(next);
    },
  };
  const target = await fixture({ store });
  try {
    const cmd = await command(target.service, 'unknown');
    await assert.rejects(target.service.configure({ ...cmd, apiKey: 'not-in-ledger' }), errorCode('CREDENTIAL_RESULT_UNKNOWN'));
    assert.equal(target.backend.writes, 1);
    failFinished = false;
    const restarted = target.create();
    assert.equal((await restarted.getReceipt('unknown')).state, 'unconfirmed');
    assert.equal((await restarted.configure({ ...cmd, apiKey: 'changed-key' })).replayed, true);
    assert.equal(target.backend.writes, 1);
    assert.equal(JSON.stringify(saved).includes('not-in-ledger'), false);
    await restarted.close();
  } finally { await target.close(); }
});
