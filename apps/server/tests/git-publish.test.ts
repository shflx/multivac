import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GitPublishService } from '../src/application/git-publish-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';
import type { ExternalOperation } from '@multivac/contracts';

test('并发远端核对的迟到未知结果不能覆盖成功回执', async (t) => {
  const db = new DatabaseSync(':memory:'); db.exec(INBOX_MIGRATION);
  const repository = new SqliteInboxRepository(db);
  const operation: ExternalOperation = { id: 'external:race', sessionId: 's', taskId: null, revision: 1, status: 'unknown', repository: '/test', remote: 'origin', target: 'https://example.invalid/test.git', ref: 'refs/heads/test', commit: 'abc', summary: '', account: '', createdAt: '', updatedAt: '', result: '结果未知' };
  repository.saveOperation(operation);
  const service = new GitPublishService(repository, new WorkbenchEvents(), () => ({ directory: '/test', taskId: null, canPublish: true }));
  const replies: Array<(value: string) => void> = [];
  t.mock.method(service as unknown as { remoteCommit: () => Promise<string> }, 'remoteCommit', () => new Promise<string>((resolve) => replies.push(resolve)));
  try {
    const first = service.reconcile(operation.id); const second = service.reconcile(operation.id);
    replies[0]!('abc'); assert.equal((await first).status, 'succeeded');
    replies[1]!(''); assert.equal((await second).status, 'succeeded');
    assert.equal(service.get(operation.id).status, 'succeeded');
  } finally { db.close(); }
});

test('真实裸仓库验证申请不发布、拒绝、固定版本、并发批准、重启未知只读对账', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-publish-'));
  const db = new DatabaseSync(':memory:'); db.exec(INBOX_MIGRATION);
  const repository = new SqliteInboxRepository(db);
  const cwd = join(root, 'work'); const remote = join(root, 'remote.git');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    execFileSync('git', ['init', '-q', cwd]); git('init', '-q', '--bare', remote);
    await writeFile(join(cwd, 'result.txt'), '固定交付'); git('add', '.'); git('-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '固定版本');
    git('remote', 'add', 'origin', remote);
    const events = new WorkbenchEvents(); const source = () => ({ directory: cwd, taskId: null, canPublish: true });
    const service = new GitPublishService(repository, events, source, true);
    const denied = await service.propose('s', 'deny', { remote: 'origin', branch: 'denied' });
    assert.equal(git('ls-remote', remote), '');
    await service.decide(denied.id, { commandId: 'd', revision: 1, decision: 'deny' }); assert.equal(git('ls-remote', remote), '');
    const publish = await service.propose('s', 'publish', { remote: 'origin', branch: 'deliver' });
    const input = { commandId: 'approve', revision: 1, decision: 'once' as const };
    const [result] = await Promise.all([service.decide(publish.id, input), service.decide(publish.id, input)]);
    assert.equal(result.status, 'succeeded'); assert.match(git('ls-remote', remote, 'refs/heads/deliver'), new RegExp(publish.commit));
    const exists = await service.propose('s', 'exists', { remote: 'origin', branch: 'deliver' });
    assert.equal((await service.decide(exists.id, { ...input, commandId: 'exists' })).status, 'invalidated');
    const stale = await service.propose('s', 'stale', { remote: 'origin', branch: 'stale' });
    await writeFile(join(cwd, 'result.txt'), '新版本'); git('add', '.'); git('-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '新版');
    assert.equal((await service.decide(stale.id, input)).status, 'invalidated'); assert.equal(git('ls-remote', remote, 'refs/heads/stale'), '');
    repository.saveOperation({ ...result, status: 'executing' });
    const restarted = new GitPublishService(repository, events, source, true);
    assert.equal(restarted.get(result.id).status, 'unknown');
    assert.equal((await restarted.reconcile(result.id)).status, 'succeeded');
    const production = new GitPublishService(repository, events, source);
    await assert.rejects(production.propose('s', 'file-forbidden', { remote: 'origin', branch: 'forbidden' }), /HTTPS/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
