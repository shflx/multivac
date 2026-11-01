import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { assertWindowsLocalPath, resolveLocalInputPath, windowsFileName } from '../src/modules/sessions/platform-paths.js';
import { isPathWithin, safeDirectoryName } from '../src/modules/sessions/working-directory.js';
import { moveEntryWithoutReplace } from '../src/modules/sessions/directory-entries.js';
import { withWindowsFileLock } from './fixtures/windows-file-lock.js';

test('Windows 本地路径、文件 URL、中文空格与用户主目录', () => {
  for (const input of ['C:\\项目 空格\\a', 'file:///C:/%E9%A1%B9%E7%9B%AE%20%E7%A9%BA%E6%A0%BC/a'])
    assert.equal(resolveLocalInputPath(input, 'C:\\cwd', 'C:\\Users\\me', 'win32'), 'C:\\项目 空格\\a');
  assert.equal(resolveLocalInputPath('~\\中文', 'C:\\cwd', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\中文');
  assert.equal(isPathWithin('C:\\PROJECT', 'c:\\project\\a', 'win32'), true);
  assert.equal(isPathWithin('C:\\project', 'D:\\project', 'win32'), false);
  assert.equal(isPathWithin('C:\\project', 'C:\\project-other', 'win32'), false);
  for (const input of ['C:relative', '\\root', '\\\\host\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', 'C:\\x:stream', 'C:\\CON.txt', 'C:\\name.', 'C:\\name ', 'file://host/C:/x'])
    assert.throws(() => resolveLocalInputPath(input, 'C:\\cwd', 'C:\\Users\\me', 'win32'));
  assert.throws(() => assertWindowsLocalPath('relative', true));
  assert.equal(windowsFileName('CON.txt'), '_CON.txt');
  assert.equal(windowsFileName('bad<>name. '), 'bad--name');
  assert.equal(safeDirectoryName('CON', '项目', 'win32'), '_CON');
  assert.equal(safeDirectoryName('CON', '项目', 'darwin'), 'CON');
});
for (const mode of ['ok', 'occupied', 'copy-failed', 'source-changed'] as const) test(`Windows 目录移动 ${mode} 保留正确源目标`, () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'multivac-win-move-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    fs.mkdirSync(source); fs.writeFileSync(join(source, 'file'), 'original');
    if (mode === 'occupied') fs.mkdirSync(target);
    const io = { ...fs, copyFileSync: ((from, to, copyMode) => {
      if (mode === 'copy-failed') throw Object.assign(new Error('occupied'), { code: 'EPERM' });
      fs.copyFileSync(from, to, copyMode);
      if (mode === 'source-changed') fs.writeFileSync(join(source, 'file'), 'changed');
    }) as typeof fs.copyFileSync };
    if (mode === 'ok') {
      moveEntryWithoutReplace(source, target, 'win32', io);
      assert.equal(fs.existsSync(source), false);
      assert.equal(fs.readFileSync(join(target, 'file'), 'utf8'), 'original');
    } else {
      assert.throws(() => moveEntryWithoutReplace(source, target, 'win32', io));
      assert.equal(fs.readFileSync(join(source, 'file'), 'utf8'), mode === 'source-changed' ? 'changed' : 'original');
      if (mode === 'occupied') assert.deepEqual(fs.readdirSync(target), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows 实机同卷移动中文目录', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'multivac-unicode-move-'));
  try {
    const source = join(root, '中文 空格'), target = join(root, '目标 中文');
    fs.mkdirSync(source);
    fs.writeFileSync(join(source, '文件.txt'), 'content');
    moveEntryWithoutReplace(source, target);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(join(target, '文件.txt'), 'utf8'), 'content');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows 实机跨卷移动中文目录且不覆盖已有目标', { skip: process.platform !== 'win32' || !process.env.MULTIVAC_WINDOWS_SECOND_VOLUME_ROOT }, () => {
  const otherVolume = process.env.MULTIVAC_WINDOWS_SECOND_VOLUME_ROOT!;
  assert.notEqual(parse(tmpdir()).root.toLowerCase(), parse(otherVolume).root.toLowerCase());
  const sourceRoot = fs.mkdtempSync(join(tmpdir(), 'multivac-cross-volume-source-'));
  const targetRoot = fs.mkdtempSync(join(otherVolume, 'multivac-cross-volume-target-'));
  try {
    const source = join(sourceRoot, '中文 空格'), target = join(targetRoot, '中文 空格');
    fs.mkdirSync(source); fs.writeFileSync(join(source, '文件.txt'), 'cross-volume');
    moveEntryWithoutReplace(source, target);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(join(target, '文件.txt'), 'utf8'), 'cross-volume');
    fs.mkdirSync(source); fs.writeFileSync(join(source, '文件.txt'), 'second');
    assert.throws(() => moveEntryWithoutReplace(source, target));
    assert.equal(fs.readFileSync(join(source, '文件.txt'), 'utf8'), 'second');
    assert.equal(fs.readFileSync(join(target, '文件.txt'), 'utf8'), 'cross-volume');
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('Windows 实机文件占用导致目录移动失败时保留源', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'multivac-locked-move-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    fs.mkdirSync(source); fs.writeFileSync(join(source, 'file'), 'original');
    await withWindowsFileLock(join(source, 'file'), () => {
      assert.throws(() => moveEntryWithoutReplace(source, target));
    });
    assert.equal(fs.readFileSync(join(source, 'file'), 'utf8'), 'original');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
