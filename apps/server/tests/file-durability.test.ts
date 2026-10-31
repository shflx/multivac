import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationError, publishReplacement, syncDirectory, syncDirectorySync } from '../src/storage/file-durability.js';

test('Windows 不尝试打开目录，也不声称目录已刷新', async () => {
  assert.equal(await syncDirectory('/missing-directory', 'win32'), 'file-only');
  assert.equal(syncDirectorySync('/missing-directory', 'win32'), 'file-only');
  await assert.rejects(syncDirectory('/missing-directory', 'darwin'));
});
for (const failure of ['rename', 'confirm', 'none'] as const) test(`Windows 替换 ${failure}，保留唯一旧副本和真实提交状态`, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'multivac-durability-'));
  try {
    const target = join(root, 'state'), temporary = join(root, 'new');
    await fs.writeFile(target, 'old'); await fs.writeFile(temporary, 'new');
    const io = { ...fs, syncDirectory, rename: async (from: string, to: string) => {
      if (failure === 'rename') throw Object.assign(new Error('occupied'), { code: 'EPERM' });
      await fs.rename(from, to);
    }, open: (async (...args: Parameters<typeof fs.open>) => {
      if (failure === 'confirm') throw new Error('confirmation failed');
      return fs.open(...args);
    }) as typeof fs.open };
    if (failure === 'none') {
      await publishReplacement(temporary, target, 'win32', io);
      assert.deepEqual(await fs.readdir(root), ['state']);
      assert.equal(await fs.readFile(target, 'utf8'), 'new');
    } else {
      await assert.rejects(publishReplacement(temporary, target, 'win32', io), (error: unknown) => {
        assert.ok(error instanceof FilePublicationError);
        assert.equal(error.commitState, failure === 'rename' ? 'not-committed' : 'unknown');
        assert.ok(error.backup);
        return true;
      });
      const backup = (await fs.readdir(root)).find(name => name.startsWith('state.previous-'))!;
      assert.equal(await fs.readFile(join(root, backup), 'utf8'), 'old');
      assert.equal(await fs.readFile(target, 'utf8'), failure === 'rename' ? 'old' : 'new');
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
