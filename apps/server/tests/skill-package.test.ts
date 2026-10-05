import { parseSkillFrontmatter } from '../src/runtime/executors/pi-skill-parser.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SkillPackages,
  parseSkillPackage as parsePackage,
  readSkillDirectory as readDirectory,
} from '../src/modules/skills/skill-package.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
const parseSkillPackage = (files: Record<string, string>) => parsePackage(files, parseSkillFrontmatter);
const readSkillDirectory = (path: string) => readDirectory(path, parseSkillFrontmatter);
const files = (text = '---\nname: sample\ndescription: 示例\n---\n正文') => ({
  'SKILL.md': Buffer.from(text).toString('base64'),
});
test('Pi 解析、快照完整性、重启版本回读与命令冲突', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-'));
  let store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const pkg = parseSkillPackage(files());
    assert.equal(pkg.manifest.dependencies.source, 'unknown');
    const packages = new SkillPackages(join(root, 'packages'), parseSkillFrontmatter);
    packages.save(pkg);
    const record = {
      skillId: 'one',
      version: pkg.manifest.version,
      name: 'sample',
      displayName: '示例',
      description: '示例',
      source: 'local',
      projectId: null,
      revision: 1,
      enabled: true,
      removed: false,
      createdAt: '',
      updatedAt: '',
    };
    assert.equal(store.skills.commit('cmd', 'fp', () => record, pkg.manifest).changed, true);
    assert.equal(
      store.skills.commit('cmd', 'fp', () => {
        throw Error();
      }).changed,
      false,
    );
    assert.throws(() => store.skills.commit('cmd', 'other', () => record));
    store.close();
    store = new SqliteAssistantStore(join(root, 'db'));
    assert.deepEqual(store.skills.version('one', record.version), pkg.manifest);
    assert.deepEqual(packages.read(record.version), pkg);
    writeFileSync(
      join(root, 'packages', record.version + '.json'),
      JSON.stringify(files('---\nname: sample\ndescription: changed\n---')),
    );
    assert.throws(() => packages.read(record.version), /完整性/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('拒绝 YAML、路径、链接与限额，保留宿主字段且不授权', () => {
  for (const value of ['---\nname: [\n---', '---\nname: BAD\ndescription: x\n---', '---\nname: sample\n---'])
    assert.throws(() => parseSkillPackage(files(value)));
  assert.throws(() => parseSkillPackage({ ...files(), '../secret': '' }));
  assert.throws(() =>
    parseSkillPackage({ ...files(), 'assets/big': Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }),
  );
  const pkg = parseSkillPackage(
    files('---\nname: sample\ndescription: x\nallowed-tools: read\ncontext: fork\n---'),
  );
  assert.deepEqual(pkg.manifest.dependencies.tools, ['read']);
  assert.match(pkg.manifest.diagnostics.join(), /不代表用户授权/);
  const root = mkdtempSync(join(tmpdir(), 'skill-'));
  try {
    const dir = join(root, 'sample');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), Buffer.from(files()['SKILL.md'], 'base64'));
    assert.equal(readSkillDirectory(realpathSync(dir)).manifest.name, 'sample');
    symlinkSync('/etc/passwd', join(dir, 'secret'));
    assert.throws(() => readSkillDirectory(realpathSync(dir)), /链接/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('包落盘失败不创建可见登记', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const packs = new SkillPackages(join(root, 'packages'), parseSkillFrontmatter);
    rmSync(join(root, 'packages'), { recursive: true });
    assert.throws(() => packs.save(parseSkillPackage(files())));
    assert.deepEqual(store.skills.list(), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
