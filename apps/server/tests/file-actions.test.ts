import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionFilesService } from '../src/application/session-files-service.js';

test('操作目标返回原样真实路径和名称，拒绝类型变化与失效来源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-file-target-'));
  try {
    const name = "中文 空格 '单引号 $() ; [x].txt";
    await writeFile(join(root, name), '内容');
    await mkdir(join(root, '目录 空格'));
    const files = new SessionFilesService({ get: () => ({ archivedAt: null, workingDirectory: { kind: 'session-temp', path: root } }) }, join(root, 'data'));
    const target = await files.target('a', name, root, 'file');
    assert.equal(target.name, name); assert.equal(target.absolute, join(root, name));
    assert.equal((await files.target('a', '目录 空格', root, 'directory')).name, '目录 空格');
    await assert.rejects(files.target('a', name, root, 'directory'), /类型已变化/);
    await assert.rejects(files.target('a', name, '/old-root', 'file'), /工作目录已变化/);
    await assert.rejects(files.target('a', '../outside', root, 'file'), /工作目录内/);
    await symlink(join(root, name), join(root, 'link'));
    await assert.rejects(files.target('a', 'link', root, 'file'), /符号链接/);
    await rm(join(root, name));
    await assert.rejects(files.target('a', name, root, 'file'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
