import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { Project, Task } from '@multivac/contracts';
import { GitPublishService } from '../src/application/git-publish-service.js';
import { TaskGitService } from '../src/application/task-git-service.js';
import { TaskWorkingDirectories } from '../src/application/task-working-directories.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { gitEnvironment } from '../src/application/git-platform.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from '../src/storage/sqlite-inbox-repository.js';

const run = promisify(execFile);
const remote = process.env.MULTIVAC_GIT_ACCEPTANCE_REMOTE;
const source = process.env.MULTIVAC_GIT_ACCEPTANCE_SOURCE;

test('Windows 真实 HTTPS/GCM：任务 worktree 提交、批准发布、远端核对与清理', {
  skip: process.platform !== 'win32' || !remote || !source,
  timeout: 240_000,
}, async () => {
  const url = new URL(remote!);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'github.com');
  assert.equal(url.pathname, '/shflx/multivac.git');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  const root = await mkdtemp(join(tmpdir(), 'multivac-gcm-acceptance-'));
  const clone = join(root, 'source');
  const workRoot = join(root, 'work');
  const branch = `codex/windows-gcm-acceptance-${randomUUID().slice(0, 12)}`;
  const ref = `refs/heads/${branch}`;
  const environment = gitEnvironment('win32', process.env, 'publish');
  const git = async (cwd: string, args: string[]) => (await run('git.exe',
    ['-c', 'credential.helper=', '-c', 'credential.helper=manager', ...args],
    { cwd, env: environment, timeout: 30_000, maxBuffer: 128 * 1024 })).stdout.trim();
  let commit = '';
  const db = new DatabaseSync(':memory:');
  db.exec(INBOX_MIGRATION);
  const repository = new SqliteInboxRepository(db);
  let taskGit: TaskGitService | undefined;
  try {
    await git(root, ['clone', '--no-hardlinks', '--quiet', source!, clone]);
    await git(clone, ['remote', 'set-url', 'origin', remote!]);
    const baseline = await git(clone, ['rev-parse', 'HEAD']);
    await writeFile(join(clone, 'dirty-local.txt'), '只保留在来源工作树');
    const task = { taskId: 'gcm-acceptance', title: 'Windows Git 验收', projectId: 'acceptance-project' } as Task;
    const directories = new TaskWorkingDirectories(workRoot, () => ({ directories: [{ path: clone }] }) as Project);
    const prepared = await directories.prepare(task, 'gcm-run', new AbortController().signal);
    assert.equal(prepared.directory.kind, 'worktree');
    assert.equal(prepared.baseline, baseline);
    await assert.rejects(readFile(join(prepared.directory.path, 'dirty-local.txt')), { code: 'ENOENT' });
    taskGit = new TaskGitService({ workRoot,
      source: () => ({ runId: 'gcm-run', directory: prepared.directory.path, sourceDirectory: clone }),
      lease: () => 1024 * 1024,
    });
    await writeFile(join(prepared.directory.path, 'windows-gcm-acceptance.txt'), 'Windows HTTPS/GCM 验收\n');
    await taskGit.commit('gcm-session', { paths: ['windows-gcm-acceptance.txt'], message: 'test: 验证 Windows Git 发布' }, new AbortController().signal);
    commit = await git(prepared.directory.path, ['rev-parse', 'HEAD']);
    assert.notEqual(commit, baseline);
    assert.equal(await git(clone, ['rev-parse', 'HEAD']), baseline);
    assert.equal(await readFile(join(clone, 'dirty-local.txt'), 'utf8'), '只保留在来源工作树');

    const events = new WorkbenchEvents();
    const publishSource = () => ({ directory: prepared.directory.path, taskId: task.taskId, canPublish: true });
    const publish = new GitPublishService(repository, events, publishSource);
    const denied = await publish.propose('gcm-session', 'deny', { remote: 'origin', branch: `${branch}-denied` });
    assert.equal((await publish.decide(denied.id, { commandId: 'deny', revision: denied.revision, decision: 'deny' })).status, 'denied');
    assert.equal(await git(clone, ['ls-remote', '--refs', remote!, `refs/heads/${branch}-denied`]), '');

    const proposal = await publish.propose('gcm-session', 'approve', { remote: 'origin', branch });
    assert.equal(proposal.commit, commit);
    assert.equal(await git(clone, ['ls-remote', '--refs', remote!, ref]), '');
    const decision = { commandId: 'once', revision: proposal.revision, decision: 'once' as const };
    const published = await publish.decide(proposal.id, decision);
    assert.equal(published.status, 'succeeded', `${published.result} (${ref})`);
    assert.equal((await publish.decide(proposal.id, decision)).status, 'succeeded');
    assert.match(await git(clone, ['ls-remote', '--refs', remote!, ref]), new RegExp(`^${commit}\\s`));
    repository.saveOperation({ ...published, status: 'executing' });
    const restarted = new GitPublishService(repository, events, publishSource);
    assert.equal(restarted.get(published.id).status, 'unknown');
    assert.equal((await restarted.reconcile(published.id)).status, 'succeeded');
  } finally {
    try {
      if (commit) {
        const current = (await git(clone, ['ls-remote', '--refs', remote!, ref])).split(/\s/u)[0];
        if (current === commit) {
          await git(clone, ['push', '--porcelain', `--force-with-lease=${ref}:${commit}`, remote!, `:${ref}`]);
          assert.equal(await git(clone, ['ls-remote', '--refs', remote!, ref]), '');
        } else if (current) throw new Error(`测试分支指向了其他提交，未自动删除：${ref}`);
      }
    } finally {
      await taskGit?.dispose();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
