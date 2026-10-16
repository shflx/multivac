import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalRuntimePath } from '../src/runtime-config.js';
import { assertManagedWorkPath, resolveMultivacWorkPaths } from '../src/storage/work-paths.js';

test('开发托管目录限定本实例工作根，生产历史目录保持兼容', () => {
  const root = mkdtempSync(join(tmpdir(), 'multivac-work-root-isolation-'));
  try {
    const data = join(root, 'data'); mkdirSync(data);
    const production = resolveMultivacWorkPaths(join(root, 'prod-work'), data);
    const development = resolveMultivacWorkPaths(join(root, 'dev-work'), data, true);
    assert.doesNotThrow(() => assertManagedWorkPath(development, join(development.sessionsDir, 'new')));
    assert.throws(() => assertManagedWorkPath(development, join(production.sessionsDir, 'foreign')), /本实例工作根/u);
    assert.doesNotThrow(() => assertManagedWorkPath(production, join(root, 'historical-work')));
    symlinkSync(production.sessionsDir, join(development.workRoot, 'alias'));
    assert.throws(() => assertManagedWorkPath(development, join(development.workRoot, 'alias', 'new')), /本实例工作根/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('启动前拒绝托管子目录外链与悬空链接', () => {
  const root = mkdtempSync(join(tmpdir(), 'multivac-work-root-links-'));
  try {
    const data = join(root, 'data'); const work = join(root, 'work'); const external = join(root, 'external');
    mkdirSync(data); mkdirSync(work); mkdirSync(external);
    symlinkSync(external, join(work, 'projects'));
    assert.throws(() => resolveMultivacWorkPaths(work, data, true), /本实例工作根/u);
    symlinkSync(join(root, 'missing'), join(root, 'dangling'));
    assert.throws(() => canonicalRuntimePath(join(root, 'dangling', 'new')), /无法解析的符号链接/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
