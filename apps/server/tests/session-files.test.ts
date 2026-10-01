import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionFilesService } from '../src/application/session-files-service.js';

test('目录浏览按真实会话隔离，搜索子目录并拒绝越界、符号链接、目录变化和归档', async () => {
  const base = await mkdtemp(join(tmpdir(), 'multivac-files-'));
  try {
    const root = join(base, 'work');
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'README.md'), '真实内容');
    await writeFile(join(base, 'secret'), 'private');
    await symlink(join(base, 'secret'), join(root, 'link'));
    await symlink(root, join(root, 'loop'));
    const session = { archivedAt: null as string | null, workingDirectory: { kind: 'session-temp' as const, path: root } };
    const files = new SessionFilesService({ get: () => session }, join(base, 'data'));
    assert.deepEqual((await files.list('a')).entries.map((entry) => entry.name), ['nested']);
    assert.equal((await files.list('a', '', 'readme')).entries[0]?.path, 'nested/README.md');
    for (const path of ['../secret', '/etc/passwd', 'nested/../../secret', 'link', 'loop', 'nested\\README.md']) await assert.rejects(files.locate('a', path));
    await assert.rejects(files.list('a', '', '', '/old/root'), /工作目录已变化/);
    await assert.rejects(files.list('a', 'missing'));
    session.archivedAt = new Date().toISOString();
    await assert.rejects(files.list('a'), /不可用/);
    session.archivedAt = null;
    const protectedFiles = new SessionFilesService({ get: () => session }, base);
    await assert.rejects(protectedFiles.list('a'), /内部数据/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('单层目录与搜索返回有硬上限并明确标记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-files-limit-'));
  try {
    await Promise.all(Array.from({ length: 510 }, (_, index) => writeFile(join(root, `file-${index}.txt`), 'text')));
    const files = new SessionFilesService({ get: () => ({ archivedAt: null, workingDirectory: { kind: 'session-temp', path: root } }) }, join(root, 'data'));
    const list = await files.list('a');
    assert.equal(list.entries.length, 500); assert.equal(list.limited, true);
    const search = await files.list('a', '', 'file');
    assert.equal(search.entries.length, 200); assert.equal(search.limited, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
