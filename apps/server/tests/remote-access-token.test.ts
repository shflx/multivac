import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { remoteConfigFromEnvironment } from '../src/adapters/http/remote-access.js';
import { loadOrCreateRemoteToken, remoteTokenPath } from '../src/storage/remote-access-token.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

function temporaryRoot(): string {
  const base = resolve('.tmp'); mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'remote-token-'));
}

test('默认 token 随机生成、按数据目录复用，已有凭据收紧为所属用户读写权限', () => {
  const root = temporaryRoot();
  try {
    const first = loadOrCreateRemoteToken(root);
    assert.match(first, /^[a-f0-9]{64}$/u);
    assert.equal(first === loadOrCreateRemoteToken(root), true);
    assert.equal(readFileSync(remoteTokenPath(root), 'utf8') === `${first}\n`, true);
    assert.equal(statSync(remoteTokenPath(root)).mode & 0o777, 0o600);
    chmodSync(remoteTokenPath(root), 0o644);
    assert.equal(first === loadOrCreateRemoteToken(root), true);
    assert.equal(statSync(remoteTokenPath(root)).mode & 0o777, 0o600);
    assert.equal(readdirSync(root).some(name => name.endsWith('.tmp')), false);
    assert.notEqual(first, loadOrCreateRemoteToken(join(root, 'other-instance')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('远程访问关闭不生成 token，显式 token 优先，无效显式 token 或入口不回退生成', () => {
  const root = temporaryRoot();
  let defaultsRead = 0;
  const fallback = () => { defaultsRead++; return loadOrCreateRemoteToken(root); };
  try {
    assert.equal(remoteConfigFromEnvironment({}, fallback).enabled, false);
    assert.equal(defaultsRead, 0);
    assert.equal(existsSync(remoteTokenPath(root)), false);
    const explicit = 'explicit-fixture-token-with-more-than-32-bytes';
    assert.equal(remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: explicit }, fallback).token, explicit);
    assert.throws(() => remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: 'short' }, fallback));
    assert.throws(() => remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_ORIGIN: 'https://fixture.example/path' }, fallback));
    assert.equal(defaultsRead, 0);
    const generated = remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1' }, fallback);
    assert.equal(generated.token === loadOrCreateRemoteToken(root), true);
    assert.equal(defaultsRead, 1);
    assert.equal(remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: '' }, fallback).token === generated.token, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('保存文件损坏、过大或为符号链接时明确失败，不覆盖或轮换已有 token', () => {
  const root = temporaryRoot();
  const path = remoteTokenPath(root);
  try {
    for (const invalid of ['broken', 'a'.repeat(66), 'z'.repeat(64)]) {
      writeFileSync(path, invalid);
      assert.throws(() => loadOrCreateRemoteToken(root), /token 文件无效/u);
      assert.equal(readFileSync(path, 'utf8'), invalid);
    }
    rmSync(path);
    const target = join(root, 'outside-token');
    writeFileSync(target, 'a'.repeat(64));
    symlinkSync(target, path);
    assert.throws(() => loadOrCreateRemoteToken(root));
    assert.equal(readFileSync(target, 'utf8'), 'a'.repeat(64));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function startService(root: string, overrides: NodeJS.ProcessEnv = {}) {
  let output = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: resolve('.'),
    env: { ...testApplicationEnvironment(root), MULTIVAC_PORT: '0',
      MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_HOST: '127.0.0.1', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', chunk => { output += String(chunk); });
  // 启动测试只核对是否展示凭据，不把随机 token 或完整输出写到测试日志。
  child.stderr.resume();
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('服务未在时限内启动。')), 15_000);
      const cleanup = () => { clearTimeout(timer); child.off('message', onReady); child.off('exit', onExit); child.off('error', onError); };
      const onReady = (message: unknown) => {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'multivac.ready') { cleanup(); resolve(); }
      };
      const onExit = () => { cleanup(); reject(new Error('服务就绪前退出。')); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      child.on('message', onReady); child.once('exit', onExit); child.once('error', onError);
    });
  } catch (error) {
    child.kill('SIGKILL'); await exited; throw error;
  }
  return {
    async stop() {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try {
        child.kill('SIGTERM');
        assert.equal(await exited, 0);
        return output;
      } finally { clearTimeout(timer); }
    },
  };
}

test('实际启动命令打印自动 token 和保存位置，重启复用；显式 token 不打印', async () => {
  const root = temporaryRoot();
  try {
    const first = await startService(root);
    const firstOutput = await first.stop();
    const token = readFileSync(remoteTokenPath(join(root, 'data')), 'utf8').trimEnd();
    assert.equal(firstOutput.includes(`远程访问 token：${token}`), true);
    assert.equal(firstOutput.includes(remoteTokenPath(join(root, 'data'))), true);
    const second = await startService(root);
    const secondOutput = await second.stop();
    assert.equal(secondOutput.includes(`远程访问 token：${token}`), true);
    assert.equal(readFileSync(remoteTokenPath(join(root, 'data')), 'utf8').trimEnd() === token, true);
    const explicit = 'explicit-fixture-token-with-more-than-32-bytes';
    const third = await startService(root, { MULTIVAC_REMOTE_TOKEN: explicit });
    const explicitOutput = await third.stop();
    assert.equal(explicitOutput.includes('远程访问 token：'), false);
    assert.equal(explicitOutput.includes(explicit), false);
    assert.equal(readFileSync(remoteTokenPath(join(root, 'data')), 'utf8').trimEnd() === token, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
