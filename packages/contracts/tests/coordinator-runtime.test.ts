import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COORDINATOR_EVENT_FIXTURES } from '../src/index.js';

test('协调助手公共事件 fixtures 可序列化并覆盖关键终态', () => {
  const serialized = JSON.stringify(COORDINATOR_EVENT_FIXTURES);
  assert.equal(serialized.includes('coordinator.run.completed'), true);
  assert.equal(serialized.includes('coordinator.run.failed'), true);
  assert.equal(serialized.includes('coordinator.run.cancelled'), true);
  assert.equal(serialized.includes('coordinator.retry.started'), true);
  assert.equal(serialized.includes('coordinator.compaction.started'), true);
  assert.deepEqual(JSON.parse(serialized), COORDINATOR_EVENT_FIXTURES);
});

test('@multivac/contracts 源码不依赖 Node、数据库或 Pi SDK', async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  const files = ['index.ts', 'coordinator-runtime.ts', 'coordinator-fixtures.ts'];

  for (const file of files) {
    const source = await readFile(resolve(sourceRoot, file), 'utf8');
    assert.equal(source.includes('node:'), false, file);
    assert.equal(source.includes('@earendil-works/pi-'), false, file);
    assert.equal(/sqlite|better-sqlite/u.test(source), false, file);
  }
});
